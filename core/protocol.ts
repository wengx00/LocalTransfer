import { Socket } from "net"
import { Readable, pipeline } from "stream"

export type ProtocolEvent = 'data' | 'close' | 'end'
export type ProtocolHandler = (params: Buffer) => any
export type StreamQueueItem = {
    stream: Readable
    length: number
    callback?: (err?: any) => any
    onProgress?: (percent: number, speed: string) => any
}

/**
 * 基于 TCP 封装的自定义应用层协议
 * * 在 TCP 包头中增加4字节记录Body的Header，防止粘包
 * * 使用异步事件驱动，开箱即用
 */
export class Protocol {
    private handler = new Map<string, ProtocolHandler[]>()
    private pendingLength = 0
    private pendingData = Buffer.alloc(0)
    private signal = false // 正在发送数据
    private streamQueue: StreamQueueItem[] = []
    constructor(private readonly socket: Socket) {
        this.socketProxy()
    }

    /**
     * 清空流式传输队列
     */
    private flushStreamQueue() {
        if (!this.streamQueue.length) {
            this.signal = false
            return
        }
        this.signal = true
        const { stream, length, callback, onProgress } = this.streamQueue.shift()!
        const header = Buffer.alloc(4)
        header.writeUInt32BE(length, 0)
        this.socket.write(header)
        let sended = 0
        let lastTime = new Date().getTime()
        let lastSend = 0
        stream.on('data', (chunk) => {
            if (!this.socket.write(chunk)) {
                stream.pause()
            }
            const chunkLength = chunk.length
            const curTime = new Date().getTime()
            const percent = Math.round((sended + chunkLength) / length * 100)
            const timeDiv = (curTime - lastTime) / 1000
            lastSend += chunkLength
            if (timeDiv >= 1) {
                onProgress?.(Math.round(percent), (lastSend / 1000 / timeDiv).toFixed(2))
                lastTime = curTime
                lastSend = 0
            }
            sended += chunk.length
        })
        stream.on('end', () => {
            callback?.()
            this.flushStreamQueue.call(this)
        })
        this.socket.on('drain', () => stream.resume())
    }

    private socketProxy() {
        const socket = this.socket
        socket.on('data', (buffer) => {
            while (buffer.length) {
                if (!this.pendingLength) {
                    this.pendingLength = buffer.readUInt32BE(0)
                    this.pendingData = Buffer.alloc(0)
                    buffer = buffer.subarray(4)
                    continue
                }
                this.pendingData = Buffer.concat([this.pendingData, buffer.subarray(0, Math.min(buffer.length, this.pendingLength))])
                if (this.pendingLength >= buffer.length) {
                    this.pendingLength -= buffer.length
                    buffer = Buffer.alloc(0)
                    if (this.pendingLength === 0) this.emit('data', this.pendingData)
                    break
                }
                buffer = buffer.subarray(this.pendingLength)
                this.emit('data', this.pendingData)
                this.pendingLength = 0
            }
        })
        socket.on('end', () => this.emit('end', void 0 as any))
        socket.on('close', () => this.emit('close', void 0 as any))
    }

    private emit(event: ProtocolEvent, params: Buffer) {
        if (!this.handler.get(event)) return
        setImmediate(() => this.handler.get(event)!.forEach(handler => handler(params)))
    }

    /**
     * 注册监听事件
     * @param event 可选 `data` | `close` | `end`
     * @param handler 处理函数，`data` 事件会接收一个 `Buffer`
     */
    on(event: ProtocolEvent, handler: ProtocolHandler) {
        if (!this.handler.get(event)) this.handler.set(event, [handler])
        else this.handler.get(event)!.push(handler)
    }
    /**
         * 基于自定义协议发送数据
         * * 数据会加上4字节的Header，指示Body长度
         * @param data 发送的数据
         */
    send(data: Buffer | string, cb?: (err?: Error) => any) {
        data = data instanceof Buffer ? data : Buffer.from(data)
        let buffer = Buffer.alloc(4)
        buffer.writeUInt32BE(data.length, 0)
        buffer = Buffer.concat([buffer, data])
        this.socket.write(buffer, cb)
    }
    /**
     * 销毁socket
     */
    dispose() {
        this.socket.end()
    }
    /**
     * 流式传输
     */
    pipe(stream: Readable, length: number, callback?: (err?: any) => any, onProgress?: (percent: number, speed: string) => any) {
        this.streamQueue.push({ stream, length, callback, onProgress })
        if (!this.signal) this.flushStreamQueue()
    }
}