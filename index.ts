import { RemoteInfo } from "dgram"
import { LocalEvent, LocalTranser } from "./core/main"
import { createInterface } from "readline"

const localTransfer = new LocalTranser()

localTransfer.bus.addListener(LocalEvent.AWAIT_VERIFIED, (rinfo: RemoteInfo, data: Buffer) => {
    localTransfer.bus.emit(LocalEvent.VERIFIED, rinfo, data)
})

localTransfer.bus.addListener(LocalEvent.CLIENT_CONNECTED, (rinfo: RemoteInfo, data: Buffer) => {
    console.log('客户端已连接', rinfo.address, rinfo.port)
})
localTransfer.bus.addListener(LocalEvent.SERVER_CONNECTED, (rinfo: RemoteInfo, data: Buffer) => {
    console.log('服务端已连接', rinfo.address, rinfo.port)
})
localTransfer.bus.addListener(LocalEvent.ERROR, (rinfo: RemoteInfo, err: Error) => {
    console.log('错误', rinfo.address, rinfo.port, err)
    setImmediate(main)
})
localTransfer.bus.addListener(LocalEvent.SUCCESS, (rinfo: RemoteInfo) => {
    console.log('文件传输成功', rinfo.address, rinfo.port)
    setImmediate(main)
})

localTransfer.broadcast()

function main() {
    const readline = createInterface({
        input: process.stdin,
        output: process.stdout
    })
    readline.question('输入传输的文件路径, $ 键刷新接收服务器, 两次 Ctrl+C 退出: \n', (ans) => {
        if (ans === '$') {
            localTransfer.broadcast()
            setImmediate(main)
            return
        }
        localTransfer.sendFiles([ans])
    })
}

setTimeout(() => {
    main()
}, 1000)