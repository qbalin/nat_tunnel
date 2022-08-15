"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const net_1 = require("net");
class Address {
    constructor(host, port) {
        this.host = host;
        this.port = port;
    }
    toString() {
        return `${this.host}:${this.port}`;
    }
    equals(other) {
        return other?.host === this.host && other.port === this.port;
    }
}
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
        if (!originDescriptor.public.host
            || !originDescriptor.public.port
            || !originDescriptor.private.host
            || !originDescriptor.private.port) {
            throw new Error(`Cannot register incomplete origin descriptor: ${JSON.stringify(originDescriptor)}`);
        }
        if (originDescriptor.public.equals(this.clientAOriginDescriptor?.public)
            || originDescriptor.public.equals(this.clientBOriginDescriptor?.public)) {
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
}
const clientPair = new ClientPair();
const server = (0, net_1.createServer)((c) => {
    // Optional - useful when logging data
    // c.setEncoding('utf8');
    c.on('end', () => {
        if (c.remoteAddress && c.remotePort) {
            clientPair.remove(new Address(c.remoteAddress, c.remotePort));
        }
    });
    c.on('data', (data) => {
        let parsedData;
        try {
            parsedData = JSON.parse(data.toString());
        }
        catch (e) {
            parsedData = {};
        }
        if (parsedData.command === 'register') {
            if (c.remoteAddress && c.remotePort) {
                clientPair.add(new OriginDescriptor(c, new Address(c.remoteAddress, c.remotePort), new Address(parsedData.localAddress, parsedData.localPort)));
            }
            else {
                throw new Error(`Received data: ${JSON.stringify(parsedData)} from a socket without remote address or port! { remoteAddress: ${c.remoteAddress}, remotePort: ${c.remotePort}}`);
            }
            if (clientPair.complete) {
                if (parsedData.relay) {
                    console.log('\nClient pair is full, broadcasting \'initiateRelayedCommunication\' command');
                    clientPair.clientAOriginDescriptor?.socket.write(JSON.stringify({
                        command: 'initiateRelayedCommunication',
                        name: 'A',
                        peerName: 'B',
                    }));
                    clientPair.clientBOriginDescriptor?.socket.write(JSON.stringify({
                        command: 'initiateRelayedCommunication',
                        name: 'B',
                        peerName: 'A',
                    }));
                    clientPair.clientBOriginDescriptor?.socket.removeAllListeners('data');
                    clientPair.clientAOriginDescriptor?.socket.removeAllListeners('data');
                    clientPair.clientAOriginDescriptor?.socket.pipe(clientPair.clientBOriginDescriptor?.socket);
                    clientPair.clientBOriginDescriptor?.socket.pipe(clientPair.clientAOriginDescriptor?.socket);
                }
                else {
                    console.log('\nClient pair is full, broadcasting \'tryConnectToPeer\' command');
                    console.log(`- PRIVATELY\t(A) ${clientPair.clientAOriginDescriptor?.private} <=> (B) ${clientPair.clientBOriginDescriptor?.private}`);
                    console.log(`- PUBLICLY\t(A) ${clientPair.clientAOriginDescriptor?.public} <=> (B) ${clientPair.clientBOriginDescriptor?.public}`);
                    clientPair.clientAOriginDescriptor?.socket.write(JSON.stringify({
                        command: 'tryConnectToPeer',
                        name: 'A',
                        peerName: 'B',
                        public: clientPair.clientBOriginDescriptor?.public,
                        private: clientPair.clientBOriginDescriptor?.private,
                    }));
                    clientPair.clientBOriginDescriptor?.socket.write(JSON.stringify({
                        command: 'tryConnectToPeer',
                        name: 'B',
                        peerName: 'A',
                        public: clientPair.clientAOriginDescriptor?.public,
                        private: clientPair.clientAOriginDescriptor?.private,
                    }));
                }
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
