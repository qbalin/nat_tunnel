"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const net_1 = require("net");
const crypto_1 = require("crypto");
const address_1 = __importDefault(require("./address"));
/**
 * Arguments parsing:
 * --host or -h: address of the rendez-vous server
 * --port or -p: port of the rendez-vous server
 * --forward-port or -fp: port of a local service to forward,
 * --timeout or -t: time in seconds after which we will give up trying to connect to the peer
 * or where to start a server if no service exists
 */
const forwardPortKeyIndex = process.argv.findIndex((entry, index) => index > 1 && ['--forward-port', '-fp'].includes(entry));
const portKeyIndex = process.argv.findIndex((entry, index) => index > 1 && ['--port', '-p'].includes(entry));
const hostKeyIndex = process.argv.findIndex((entry, index) => index > 1 && ['--host', '-h'].includes(entry));
const timeoutKeyIndex = process.argv.findIndex((entry, index) => index > 1 && ['--timeout', '-t'].includes(entry));
if (forwardPortKeyIndex === -1) {
    throw new Error('You must specify a local port to forward to the peer (e.g.: --forward-port 22)');
}
if (portKeyIndex === -1 || hostKeyIndex === -1) {
    throw new Error('\n\tPlease specify the host and port of the rendez-vous server. \n\te.g. `$ node ./client.js -h 123.234.111.222 -p 9999`\n\n');
}
const serverHost = process.argv[hostKeyIndex + 1];
const serverPortString = process.argv[portKeyIndex + 1];
if (!/^[0-9]+$/.test(serverPortString)) {
    throw new Error('Port must be a number from 1 to 65535.');
}
const timeoutString = timeoutKeyIndex !== -1 ? process.argv[timeoutKeyIndex + 1] : '60';
const serverPort = parseInt(serverPortString, 10);
const forwardPortString = process.argv[forwardPortKeyIndex + 1];
const forwardPort = parseInt(forwardPortString, 10);
const timeout = parseInt(timeoutString, 10);
/**
 * Utility functions. Could have used lodash or underscore instead
 */
function limitExecutionCount(fn, limit) {
    let executionCount = 0;
    return (...args2) => {
        if (executionCount >= limit) {
            throw new Error('retry count exhausted');
        }
        console.log('Retrying', executionCount, limit);
        executionCount += 1;
        return fn(...args2);
    };
}
function throttle(fn, delay) {
    return (...args2) => new Promise((resolve, reject) => {
        setTimeout(() => {
            try {
                resolve(fn(...args2));
            }
            catch (e) {
                reject(e);
            }
        }, delay);
    });
}
function rjust(stringOrNumberToPad, targetLength, paddingString) {
    const stringToPad = stringOrNumberToPad.toString();
    if (stringToPad.length > targetLength) {
        throw new Error(`String '${stringToPad}' is longer than desired padding (${targetLength}).`);
    }
    const padding = new Array(targetLength - stringToPad.length);
    for (let i = 0; i < padding.length; i += 1) {
        padding[i] = paddingString[i % paddingString.length];
    }
    return `${padding.join('')}${stringToPad}`;
}
class Queue {
    constructor() {
        this.nodes = [];
        this.start = null;
        this.end = null;
    }
    push(value) {
        const newNode = { left: null, right: null, value };
        if (!this.end) {
            this.start = newNode;
            this.end = newNode;
        }
        else {
            newNode.left = this.end;
            this.end.right = newNode;
            this.end = newNode;
        }
    }
    pop() {
        if (!this.start) {
            return null;
        }
        const { value } = this.start;
        this.start = this.start.right;
        return value;
    }
}
class MultiplexAddon {
    constructor(socket) {
        this.sending = false;
        this.messageQueue = new Queue();
        this.buffer = Buffer.alloc(0);
        this.maxBufferSizeDigits = 14;
        this.socket = socket;
        const emitMessagesFromBuffer = (buffer, sock, maxBufferSizeDigits) => {
            if (buffer.length === 0) {
                return buffer;
            }
            const lengthAsBuffer = buffer.subarray(0, maxBufferSizeDigits);
            if (lengthAsBuffer.length !== maxBufferSizeDigits) {
                console.error('Error while reading length', lengthAsBuffer.length, lengthAsBuffer, lengthAsBuffer.toString());
                console.log(buffer.toString());
                return buffer;
            }
            const length = parseInt(lengthAsBuffer.toString(), 10);
            const message = buffer.subarray(maxBufferSizeDigits, length + maxBufferSizeDigits);
            if (message.length === length) {
                sock.emit('multiplex-data', message.subarray(0, 36).toString(), message.subarray(36));
                return emitMessagesFromBuffer(buffer.subarray(maxBufferSizeDigits + length), sock, maxBufferSizeDigits);
            }
            return buffer;
        };
        socket.on('data', (data) => {
            this.buffer = Buffer.concat([this.buffer, data]);
            this.buffer = emitMessagesFromBuffer(this.buffer, socket, this.maxBufferSizeDigits);
        });
    }
    write(buffer) {
        if (this.sending) {
            if (buffer) {
                console.log('is sending, queueing', buffer.toString());
                this.messageQueue.push(buffer);
            }
        }
        else {
            const message = buffer || this.messageQueue.pop();
            if (message) {
                this.sending = true;
                const length = Buffer.from(rjust(message.length, this.maxBufferSizeDigits, '0'));
                this.socket.write(Buffer.concat([length, message]), () => {
                    this.sending = false;
                    this.write();
                });
            }
        }
    }
}
/**
 * Interesting code starts here
 */
const sockets = {};
const setupSocketToPeer = (localPortUsedWithServer, peerAddress, portToForward, networkType) => {
    console.log(`\nAttempting ${networkType} connection towards ${peerAddress}`);
    console.log('localPortUsedWithServer', localPortUsedWithServer);
    const socketToPeerOptions = {
        localPort: localPortUsedWithServer,
        port: peerAddress.port,
        host: peerAddress.host,
    };
    // 5. try to connect to the peer in P2P!
    const socketToPeer = (() => {
        const socket = (0, net_1.createConnection)(socketToPeerOptions);
        const multiplex = new MultiplexAddon(socket);
        Reflect.set(socket, 'multiplex', multiplex);
        return socket;
    })();
    socketToPeer.setKeepAlive(true);
    const tryToReconnect = limitExecutionCount(throttle(() => socketToPeer.connect(socketToPeerOptions), 1000), timeout);
    socketToPeer.on('error', (e) => {
        console.log(e.message);
        try {
            // 6. There is a chance that the connection to the peer will fail. Retry.
            tryToReconnect();
        }
        catch (err) {
            console.error(`Failed to connect with peer on ${networkType} network`);
            console.error('Are you running the rendez-vous server on the same machine as this client by any chance? You should not. TODO: understand why.');
            if (err instanceof Error) {
                console.error(err.message);
            }
            else {
                console.error(err);
            }
            throw e;
        }
    });
    // 7. We're connected to the peer!
    const messagesFor = {};
    socketToPeer.on('connect', () => {
        console.log('connected to peer!');
        socketToPeer.on('multiplex-data', (socketId, message) => {
            console.log('\nMessage from peer', message.length);
            if (!sockets[socketId]) {
                sockets[socketId] = (0, net_1.createConnection)(portToForward);
                sockets[socketId].on('ready', () => {
                    if (messagesFor[socketId]) {
                        console.log('socketId', socketId, 'draining queued messages', messagesFor[socketId].map((e) => e.toString()));
                        messagesFor[socketId].forEach((m) => sockets[socketId].write(m));
                        delete messagesFor[socketId];
                    }
                });
                sockets[socketId].on('data', (data) => {
                    console.log('socketId', socketId, 'message to peer', data.length);
                    socketToPeer.multiplex.write(Buffer.concat([Buffer.from(socketId), data]));
                });
            }
            if (['writeOnly', 'open'].includes(sockets[socketId].readyState)) {
                console.log('socketId', socketId, 'To local socket', message.length);
                sockets[socketId].write(message);
            }
            else {
                messagesFor[socketId] || (messagesFor[socketId] = []);
                messagesFor[socketId].push(message);
            }
        });
        (0, net_1.createServer)((localSocketToServer) => {
            const socketId = (0, crypto_1.randomUUID)();
            sockets[socketId] = localSocketToServer;
            localSocketToServer.on('data', (data) => {
                console.log('-- message to peer', data.length);
                socketToPeer.multiplex.write(Buffer.concat([Buffer.from(socketId), data]));
            });
            localSocketToServer.on('close', () => {
                delete sockets[socketId];
            });
        }).listen(portToForward)
            .on('error', (e) => {
            console.log(e);
            console.log('Service alread running on port', portToForward);
        });
    });
};
// 1. Connect to the rendez-vous server
const socketToServer = (0, net_1.createConnection)({
    port: serverPort,
    host: serverHost,
});
socketToServer.on('data', (data) => {
    console.log('data', data);
    let parsedData = null;
    try {
        parsedData = JSON.parse(data);
    }
    catch (e) {
        if (e instanceof Error) {
            console.error(e.message);
        }
    }
    // 3. Server got information from a pair of peers trying to connect. To each, it sent
    // the coordinates of the other: the public (address, port) and private (address, port)
    if ((parsedData === null || parsedData === void 0 ? void 0 : parsedData.command) === 'tryConnectToPeer') {
        const peerPublicAddress = new address_1.default(parsedData.public.host, parsedData.public.port);
        const peerPrivateAddress = new address_1.default(parsedData.private.host, parsedData.private.port);
        console.log(`\nI am client ${parsedData.name}. Will try connecting with peer ${parsedData.peerName} at:`);
        console.log(`\tPrivately: ${peerPrivateAddress}`);
        console.log(`\tPublicly: ${peerPublicAddress}`);
        const localPortUsedWithServer = socketToServer.localPort;
        // 4. Waiting until the server closes the socket before trying to connect to the peer
        // with the same outbound port: some OS (like Raspbian) would not allow to reuse the outbound
        // port in a connection to the peer if that port were used in a connection to the server.
        // It is important that the server be the one to end the connection to really free the port.
        socketToServer.on('end', () => {
            // const socketToPrivatePeer = setupSocketToPeer(localPortUsedWithServer, peerPrivateAddress, forwardPort, 'private');
            const socketToPublicPeer = setupSocketToPeer(localPortUsedWithServer, peerPublicAddress, forwardPort, 'public');
            // socketToPrivatePeer.on('connect', socketToPublicPeer.end);
            // socketToPublicPeer.on('connect', socketToPrivatePeer.end);
        });
    }
});
// 2. When connecte to rendez-vous server, send information about the
// local port and address being used. These coordinates will be used
// to connect on a private network, if the other peer happens to live on it.
socketToServer.on('connect', () => {
    console.log('Connected to the server from', socketToServer.address());
    socketToServer.write(JSON.stringify({
        command: 'register',
        localPort: socketToServer.localPort,
        localAddress: socketToServer.localAddress,
    }));
});
socketToServer.on('error', (e) => {
    throw e;
});
socketToServer.on('end', () => {
    console.log('closing socket to server');
});
