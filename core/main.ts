import { RemoteInfo, Socket as UdpSocket, createSocket as createUdpSocket } from "dgram"
import EventEmitter from "events"
import { readFile, writeFile } from "fs"
import ip from 'ip'
import { Server as TcpServer, createConnection as createTcpConnection, createServer as createTcpServer } from "net"
import { resolve } from "path"
import { Protocol } from "./protocol"
import { generateRandomID } from "./utils"

export type LocalOptions = {
    tcpPort?: number
    uploadRoot?: string
}

export enum LocalInfoMsg {
    REQUEST_CONNECT = 'REQUEST_CONNECT',
    ALLOW_CONNECT = 'ALLOW_CONNECT',
    REJECT_CONNECT = 'REJECT_CONNECT',
    SUCCESS = 'SUCCESS',
    FAIL = 'FAIL',
}

export enum LocalEvent {
    SERVER_LAUNCH = 'SERVER_LAUNCH',
    AWAIT_VERIFIED = 'AWAIT_VERIFIED',
    VERIFIED = 'VERIFIED',
    CLIENT_CONNECTED = 'CLIENT_CONNECTED',
    SERVER_CONNECTED = 'SERVER_CONNECTED',
    PERMISSION_DENY = 'PERMISSION_DENY',
    DISCONNECT = 'DISCONNECT',
    ERROR = 'ERROR',
    SUCCESS = 'SUCCESS'
}

export type LocalMessage<T = any> = {
    code: number
    msg: LocalInfoMsg | string
    data: T
}

export class LocalTranser {
    public readonly bus = new EventEmitter()
    private readonly id: string
    private readonly options: Required<LocalOptions>
    private readonly tcpServer: TcpServer
    private readonly udpServer: UdpSocket
    private verifiedClientHost: Set<string>
    private availableServer: Map<string, number>
    constructor(options?: LocalOptions) {
        this.options = {
            tcpPort: options?.tcpPort ?? 30,
            uploadRoot: options?.uploadRoot ?? './uploads'
        }
        this.id = generateRandomID(6)
        this.verifiedClientHost = new Set<string>()
        this.availableServer = new Map<string, number>()
        this.tcpServer = createTcpServer(socket => {
            const address = {
                address: socket.remoteAddress!,
                port: socket.remotePort,
                family: socket.remoteFamily
            }
            if (address.family === 'IPv6') {
                const ipSeq = address.address.split(':')
                address.address = ipSeq[ipSeq.length - 1]
            }
            if (!this.verifiedClientHost.has(address.address)) {
                console.log('未验证的客户端')
                socket.end()
                return
            }
            const protocol = new Protocol(socket)
            let summary: string[]
            let count = 0
            let finished = 0
            let error = false
            protocol.on('data', data => {
                if (!summary) {
                    summary = JSON.parse(data.toString('utf8'))
                    return
                }
                writeFile(resolve(this.options.uploadRoot, summary[count++]), data, err => {
                    finished++
                    if (err) {
                        console.log(err)
                        error = true
                        this.bus.emit(LocalEvent.ERROR, { host: address.address, port: address.port }, err)
                    }
                    if (finished === summary.length) {
                        protocol.send(this.wrapper(this.id, error ? 400 : 200, error ? LocalInfoMsg.FAIL : LocalInfoMsg.SUCCESS))
                        this.bus.emit(LocalEvent.SUCCESS, address)
                    }
                })
            })
        })
        this.udpServer = createUdpSocket('udp4', this.udpHandler.bind(this))
        this.tcpServer.listen(this.options.tcpPort, () => {
            console.log('TCP server start on', this.options.tcpPort)
            this.bus.emit(LocalEvent.SERVER_LAUNCH, this.wrapper(this.options.tcpPort))
        })
        this.udpServer.bind(30, () => {
            console.log('UDP server start on', 30)
            this.udpServer.setBroadcast(true)
        })
        this.bus.addListener(LocalEvent.VERIFIED, (rinfo: RemoteInfo, data: any) => {
            this.verifiedClientHost.add(rinfo.address)
            this.udpServer.send(
                this.wrapper(this.id, 200, LocalInfoMsg.ALLOW_CONNECT),
                rinfo.port,
                rinfo.address,
            )
            this.bus.emit(LocalEvent.CLIENT_CONNECTED, rinfo, data)
            return
        })
    }

    private udpHandler(raw: Buffer, rinfo: RemoteInfo) {
        // 忽略本机局域网IP
        const localIp = ip.address('public', 'ipv4')
        if (localIp === rinfo.address) {
            return
        }
        const { code, msg, data }: LocalMessage = JSON.parse(raw.toString('utf8'))
        if (msg === LocalInfoMsg.REQUEST_CONNECT) {
            if (this.verifiedClientHost.has(rinfo.address)) {
                this.udpServer.send(
                    this.wrapper(this.id, 200, LocalInfoMsg.ALLOW_CONNECT),
                    rinfo.port,
                    rinfo.address,
                )
                this.bus.emit(LocalEvent.CLIENT_CONNECTED, rinfo, this.wrapper(data))
                return
            }
            this.bus.emit(LocalEvent.AWAIT_VERIFIED, rinfo, this.wrapper(data))
            return
        }
        if (msg === LocalInfoMsg.ALLOW_CONNECT) {
            this.availableServer.set(rinfo.address, rinfo.port)
            this.bus.emit(LocalEvent.SERVER_CONNECTED, rinfo, this.wrapper(data))
            return
        }
        if (msg === LocalInfoMsg.REJECT_CONNECT) {
            this.availableServer.delete(rinfo.address)
            this.bus.emit(LocalEvent.PERMISSION_DENY, rinfo, this.wrapper(data))
            return
        }
    }

    private wrapper(data: any, code = 200, msg = LocalInfoMsg.SUCCESS) {
        return Buffer.from(JSON.stringify({
            data,
            code,
            msg
        }))
    }

    broadcast() {
        this.udpServer.send(
            this.wrapper(this.id, 200, LocalInfoMsg.REQUEST_CONNECT),
            30,
            '255.255.255.255',
        )
    }

    sendFiles(pathList: string[]) {
        // 区分 Windows 和 Unix 下的路径分隔符
        const divider = process.platform === 'win32' ? '\\' : '/'
        // 根据路径列表获取文件名列表
        const fileNames = pathList.map(path => path.split(divider).pop())
        // 摘要
        const summary = fileNames

        this.availableServer.forEach((port, address) => {
            const socket = createTcpConnection({
                port,
                host: address
            })
            const protocol = new Protocol(socket)
            protocol.on('data', data => {
                const { code, msg } = JSON.parse(data.toString('utf8'))
                if (code === 200 && msg === LocalInfoMsg.SUCCESS) {
                    this.bus.emit(LocalEvent.SUCCESS, { address, port })
                } else {
                    console.log('传输文件失败')
                    this.bus.emit(LocalEvent.ERROR, { address, port }, msg)
                }
                protocol.dispose()
            })
            protocol.send(JSON.stringify(summary))
            pathList.forEach(path => {
                const startTime = new Date().getTime()
                readFile(path, (err, data) => {
                    if (err) {
                        console.log('读取文件失败', err)
                        this.bus.emit(LocalEvent.ERROR, { address, port }, err)
                        return
                    }
                    console.log('读取文件成功...', path)
                    protocol.send(data, (err) => {
                        if (err) {
                            console.log('传输文件失败', err)
                            this.bus.emit(LocalEvent.ERROR, { address, port }, err)
                            return
                        }
                        console.log('传输文件成功', path, (new Date().getTime() - startTime) / 1000 + 's')
                    })
                })
            })
        })
    }
}

