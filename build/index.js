"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const net_1 = require("net");
const address_1 = __importDefault(require("./address"));
const portKeyIndex = process.argv.findIndex((entry, index) => index > 1 && ['--port', '-p'].includes(entry));
if (portKeyIndex === -1) {
    throw new Error('\n\tPlease specify the port on which the rendez-vous server will run with option --port.');
}
const serverPortString = process.argv[portKeyIndex + 1];
if (!/^[0-9]+$/.test(serverPortString)) {
    throw new Error('Port must be a number from 1 to 65535.');
}
const serverPort = parseInt(serverPortString, 10);
class OriginDescriptor {
    constructor(socket, publicOrigin, privateOrigin) {
        this.socket = socket;
        this.public = publicOrigin;
        this.private = privateOrigin;
    }
    toString() {
        return JSON.stringify({
            public: this.public,
            private: this.private,
        }, null, 1);
    }
}
class ClientPair {
    constructor() {
        this.clientAOriginDescriptor = null;
        this.clientBOriginDescriptor = null;
    }
    get complete() {
        return this.clientAOriginDescriptor && this.clientBOriginDescriptor;
    }
    add(originDescriptor) {
        var _a, _b;
        if (!originDescriptor.public.host
            || !originDescriptor.public.port
            || !originDescriptor.private.host
            || !originDescriptor.private.port) {
            throw new Error(`Cannot register incomplete origin descriptor: ${JSON.stringify(originDescriptor)}`);
        }
        if (originDescriptor.public.equals((_a = this.clientAOriginDescriptor) === null || _a === void 0 ? void 0 : _a.public)
            || originDescriptor.public.equals((_b = this.clientBOriginDescriptor) === null || _b === void 0 ? void 0 : _b.public)) {
            console.log('\nClient already registered:');
            console.log(originDescriptor.toString());
        }
        else if (!this.clientAOriginDescriptor) {
            console.log('\nRegistering new client origin descriptor in slot A:');
            console.log(originDescriptor.toString());
            this.clientAOriginDescriptor = originDescriptor;
        }
        else if (!this.clientBOriginDescriptor) {
            console.log('\nRegistering new client origin descriptor in slot B:');
            console.log(originDescriptor.toString());
            this.clientBOriginDescriptor = originDescriptor;
        }
        else {
            throw new Error('Only two clients can be registered at a time!');
        }
    }
    remove(publicOrigin) {
        if (this.clientAOriginDescriptor && publicOrigin.equals(this.clientAOriginDescriptor.public)) {
            console.log('\nRemoving client:');
            console.log(this.clientAOriginDescriptor.toString());
            this.clientAOriginDescriptor = null;
        }
        else if (this.clientBOriginDescriptor
            && publicOrigin.equals(this.clientBOriginDescriptor.public)) {
            console.log('\nRemoving client:');
            console.log(this.clientBOriginDescriptor.toString());
            this.clientBOriginDescriptor = null;
        }
        else {
            console.log('Client with following public origin was not found for removal:');
            console.log(JSON.stringify(publicOrigin));
        }
    }
    clear() {
        var _a, _b;
        (_a = this.clientAOriginDescriptor) === null || _a === void 0 ? void 0 : _a.socket.end();
        (_b = this.clientBOriginDescriptor) === null || _b === void 0 ? void 0 : _b.socket.end();
    }
}
const clientPair = new ClientPair();
const server = (0, net_1.createServer)((c) => {
    // Optional - useful when logging data
    c.setEncoding('utf8');
    c.on('end', () => {
        if (c.remoteAddress && c.remotePort) {
            clientPair.remove(new address_1.default(c.remoteAddress, c.remotePort));
        }
    });
    c.on('data', (data) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        let parsedData;
        try {
            parsedData = JSON.parse(data);
        }
        catch (e) {
            console.log('data', data);
            throw e;
        }
        if (parsedData.command === 'register') {
            if (c.remoteAddress && c.remotePort) {
                clientPair.add(new OriginDescriptor(c, new address_1.default(c.remoteAddress, c.remotePort), new address_1.default(parsedData.localAddress, parsedData.localPort)));
            }
            else {
                throw new Error(`Received data: ${JSON.stringify(parsedData)} from a socket without remote address or port! { remoteAddress: ${c.remoteAddress}, remotePort: ${c.remotePort}}`);
            }
            if (clientPair.complete) {
                console.log('\nClient pair is full, broadcasting \'tryConnectToPeer\' command');
                console.log(`- PRIVATELY\t(A) ${(_a = clientPair.clientAOriginDescriptor) === null || _a === void 0 ? void 0 : _a.private} <=> (B) ${(_b = clientPair.clientBOriginDescriptor) === null || _b === void 0 ? void 0 : _b.private}`);
                console.log(`- PUBLICLY\t(A) ${(_c = clientPair.clientAOriginDescriptor) === null || _c === void 0 ? void 0 : _c.public} <=> (B) ${(_d = clientPair.clientBOriginDescriptor) === null || _d === void 0 ? void 0 : _d.public}`);
                (_e = clientPair.clientAOriginDescriptor) === null || _e === void 0 ? void 0 : _e.socket.write(JSON.stringify({
                    command: 'tryConnectToPeer',
                    name: 'A',
                    peerName: 'B',
                    public: (_f = clientPair.clientBOriginDescriptor) === null || _f === void 0 ? void 0 : _f.public,
                    private: (_g = clientPair.clientBOriginDescriptor) === null || _g === void 0 ? void 0 : _g.private,
                }));
                (_h = clientPair.clientBOriginDescriptor) === null || _h === void 0 ? void 0 : _h.socket.write(JSON.stringify({
                    command: 'tryConnectToPeer',
                    name: 'B',
                    peerName: 'A',
                    public: (_j = clientPair.clientAOriginDescriptor) === null || _j === void 0 ? void 0 : _j.public,
                    private: (_k = clientPair.clientAOriginDescriptor) === null || _k === void 0 ? void 0 : _k.private,
                }));
                // The server must indicate the end of the communication for the client to be able to re-use
                // the same outbound port in the future communication with the other peer.
                // This requirement is OS dependant: on MacOS, it is not necessary. On Raspbian, it is.
                clientPair.clear();
            }
        }
    });
});
server.on('error', (e) => {
    throw e;
});
server.listen(serverPort, () => {
    console.log('server bound on port', serverPort);
});
