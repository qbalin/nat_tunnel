import { createServer, Socket } from 'net';
import Address from './address';

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
  socket: Socket;

  private: Address;

  public: Address;

  constructor(socket: Socket, publicOrigin: Address, privateOrigin: Address) {
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
  clientAOriginDescriptor: OriginDescriptor | null = null;

  clientBOriginDescriptor: OriginDescriptor | null = null;

  get complete() {
    return this.clientAOriginDescriptor && this.clientBOriginDescriptor;
  }

  add(originDescriptor: OriginDescriptor) {
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
    } else if (!this.clientAOriginDescriptor) {
      console.log('\nRegistering new client origin descriptor in slot A:');
      console.log(originDescriptor.toString());
      this.clientAOriginDescriptor = originDescriptor;
    } else if (!this.clientBOriginDescriptor) {
      console.log('\nRegistering new client origin descriptor in slot B:');
      console.log(originDescriptor.toString());
      this.clientBOriginDescriptor = originDescriptor;
    } else {
      throw new Error('Only two clients can be registered at a time!');
    }
  }

  remove(publicOrigin: Address) {
    if (this.clientAOriginDescriptor && publicOrigin.equals(this.clientAOriginDescriptor.public)) {
      console.log('\nRemoving client:');
      console.log(this.clientAOriginDescriptor.toString());
      this.clientAOriginDescriptor = null;
    } else if (
      this.clientBOriginDescriptor
      && publicOrigin.equals(this.clientBOriginDescriptor.public)
    ) {
      console.log('\nRemoving client:');
      console.log(this.clientBOriginDescriptor.toString());
      this.clientBOriginDescriptor = null;
    } else {
      console.log('Client with following public origin was not found for removal:');
      console.log(JSON.stringify(publicOrigin));
    }
  }

  clear() {
    this.clientAOriginDescriptor?.socket.end();
    this.clientBOriginDescriptor?.socket.end();
  }
}

const clientPair = new ClientPair();

const server = createServer((c) => {
  // Optional - useful when logging data
  // c.setEncoding('utf8');

  c.on('end', () => {
    if (c.remoteAddress && c.remotePort) {
      clientPair.remove(
        new Address(c.remoteAddress, c.remotePort),
      );
    }
  });

  c.on('data', (data: Buffer) => {
    let parsedData: any;
    try {
      parsedData = JSON.parse(data.toString());
    } catch (e) {
      parsedData = {};
    }

    if (parsedData.command === 'register') {
      if (c.remoteAddress && c.remotePort) {
        clientPair.add(new OriginDescriptor(
          c,
          new Address(c.remoteAddress, c.remotePort),
          new Address(parsedData.localAddress, parsedData.localPort),
        ));
      } else {
        throw new Error(`Received data: ${JSON.stringify(parsedData)} from a socket without remote address or port! { remoteAddress: ${c.remoteAddress}, remotePort: ${c.remotePort}}`);
      }

      if (clientPair.complete) {
        if (parsedData.relay) {
          console.log('\nClient pair is full, broadcasting \'initiateRelayedCommunication\' command');
          clientPair.clientAOriginDescriptor?.socket.write(
            JSON.stringify({
              command: 'initiateRelayedCommunication',
              name: 'A',
              peerName: 'B',
            }),
          );

          clientPair.clientBOriginDescriptor?.socket.write(
            JSON.stringify({
              command: 'initiateRelayedCommunication',
              name: 'B',
              peerName: 'A',
            }),
          );

          clientPair.clientBOriginDescriptor?.socket.removeAllListeners('data');
          clientPair.clientAOriginDescriptor?.socket.removeAllListeners('data');

          clientPair.clientAOriginDescriptor?.socket.pipe(clientPair.clientBOriginDescriptor?.socket);
          clientPair.clientBOriginDescriptor?.socket.pipe(clientPair.clientAOriginDescriptor?.socket);
        } else {
          console.log('\nClient pair is full, broadcasting \'tryConnectToPeer\' command');
          console.log(`- PRIVATELY\t(A) ${clientPair.clientAOriginDescriptor?.private} <=> (B) ${clientPair.clientBOriginDescriptor?.private}`);
          console.log(`- PUBLICLY\t(A) ${clientPair.clientAOriginDescriptor?.public} <=> (B) ${clientPair.clientBOriginDescriptor?.public}`);

          clientPair.clientAOriginDescriptor?.socket.write(
            JSON.stringify({
              command: 'tryConnectToPeer',
              name: 'A',
              peerName: 'B',
              public: clientPair.clientBOriginDescriptor?.public,
              private: clientPair.clientBOriginDescriptor?.private,
            }),
          );

          clientPair.clientBOriginDescriptor?.socket.write(
            JSON.stringify({
              command: 'tryConnectToPeer',
              name: 'B',
              peerName: 'A',
              public: clientPair.clientAOriginDescriptor?.public,
              private: clientPair.clientAOriginDescriptor?.private,
            }),
          );

          // The server must indicate the end of the communication for the client to be able to re-use
          // the same outbound port in the future communication with the other peer.
          // This requirement is OS dependant: on MacOS, it is not necessary. On Raspbian, it is.
          clientPair.clear();
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
