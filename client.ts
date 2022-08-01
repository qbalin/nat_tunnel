import { createConnection, createServer, Socket } from 'net';
import Address from './address';

const forwardPortKeyIndex = process.argv.findIndex((entry, index) => index > 1 && ['--forward-port', '-fp'].includes(entry));
const portKeyIndex = process.argv.findIndex((entry, index) => index > 1 && ['--port', '-p'].includes(entry));
const hostKeyIndex = process.argv.findIndex((entry, index) => index > 1 && ['--host', '-h'].includes(entry));

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
const serverPort = parseInt(serverPortString, 10);
const forwardPortString = process.argv[forwardPortKeyIndex + 1];
const forwardPort = parseInt(forwardPortString, 10);

const setupSocketToPeer = (socketToServer: Socket, peerAddress: Address, portToForward: number, networkType: 'public' | 'private') => {
  console.log(`\nAttempting ${networkType} connection towards ${peerAddress}`);
  console.log('socketToServer.address()', socketToServer.address());

  const socketToPeer = createConnection({
    localPort: socketToServer.localPort,
    port: peerAddress.port,
    host: peerAddress.host,
  });
  socketToPeer.on('error', (e) => {
    console.error(`Failed to connect with peer on ${networkType} network`);
    console.error('Are you running the rendez-vous server on the same machine as this client by any chance? You should not. TODO: understand why.');
    throw e;
  });

  socketToPeer.on('connect', () => {
    console.log(`Connected to ${networkType} peer!`);
    console.log(`${networkType} socket info:`, socketToPeer.address());
    const localSocket = createConnection({ port: portToForward });
    localSocket.on('connect', () => {
      localSocket.pipe(socketToPeer);
      socketToPeer.pipe(localSocket);
    });
    localSocket.on('error', (e) => {
      if (e.message.includes('ECONNREFUSED')) {
        console.log(`No server is running on port ${portToForward}. Starting one.`);
        createServer((c) => {
          c.pipe(socketToPeer);
          socketToPeer.pipe(c);
        }).listen(portToForward);
      } else {
        throw e;
      }
    });
  });
  return socketToPeer;
};

const socket = createConnection({
  port: serverPort,
  host: serverHost,
});
socket.on('data', (data: string) => {
  console.log('data', data);
  let parsedData: any = null;
  try {
    parsedData = JSON.parse(data);
  } catch (e) {
    if (e instanceof Error) {
      console.error(e.message);
    }
  }

  if (parsedData?.command === 'tryConnectToPeer') {
    const peerPublicAddress = new Address(parsedData.public.host, parsedData.public.port);
    const peerPrivateAddress = new Address(parsedData.private.host, parsedData.private.port);

    console.log(`\nI am client ${parsedData.name}. Will try connecting with peer ${parsedData.peerName} at:`);
    console.log(`\tPrivately: ${peerPrivateAddress}`);
    console.log(`\tPublicly: ${peerPublicAddress}`);

    // const socketToPrivatePeer = setupSocketToPeer(socket, peerPrivateAddress, forwardPort, 'private');
    const socketToPublicPeer = setupSocketToPeer(socket, peerPublicAddress, forwardPort, 'public');
    // socketToPrivatePeer.on('connect', socketToPublicPeer.end);
    // socketToPublicPeer.on('connect', socketToPrivatePeer.end);
  }
});

socket.on('connect', () => {
  console.log('Connected to the server from', socket.address());
  socket.write(JSON.stringify(
    {
      command: 'register',
      localPort: socket.localPort,
      localAddress: socket.localAddress,
    },
  ));
});

socket.on('error', (e) => {
  throw e;
});
