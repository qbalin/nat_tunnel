import {
  createConnection, createServer,
} from 'net';
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

function limitExecutionCount(fn: (...args1: any[]) => void, limit: number) {
  let executionCount = 0;
  return (...args2: any[]) => {
    if (executionCount >= limit) {
      throw new Error('retry count exhausted');
    }
    console.log('Retrying', executionCount, limit);
    executionCount += 1;
    return fn(...args2);
  };
}

function throttle<T>(fn: (...args1: any[]) => T, delay: number) {
  return (...args2: any[]) => new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(fn(...args2));
      } catch (e) {
        reject(e);
      }
    }, delay);
  });
}

const setupSocketToPeer = (localPortUsedWithServer: number, peerAddress: Address, portToForward: number, networkType: 'public' | 'private', socketToServer) => {
  console.log(`\nAttempting ${networkType} connection towards ${peerAddress}`);
  console.log('localPortUsedWithServer', localPortUsedWithServer);

  const socketToPeerOptions = {
    localPort: localPortUsedWithServer,
    port: peerAddress.port,
    host: peerAddress.host,
  };

  const socketToPeer = createConnection(socketToPeerOptions);
  const tryToReconnect = limitExecutionCount(throttle(() => socketToPeer.connect(socketToPeerOptions), 1000), 600);

  socketToPeer.on('error', (e) => {
    console.log(e.message);
    try {
      tryToReconnect();
    } catch (err) {
      console.error(`Failed to connect with peer on ${networkType} network`);
      console.error('Are you running the rendez-vous server on the same machine as this client by any chance? You should not. TODO: understand why.');
      if (err instanceof Error) {
        console.error(err.message);
      } else {
        console.error(err);
      }
      throw e;
    }
  });

  socketToPeer.on('connect', () => {
    console.log(`Connected to ${networkType} peer!`);
    console.log(`${networkType} socket info:`, socketToPeer.address());
    const socketToLocalPort = createConnection({ port: portToForward });
    socketToLocalPort.on('connect', () => {
      console.log('forwarding port', portToForward, 'to peer');
      socketToLocalPort.pipe(socketToPeer);
      socketToPeer.pipe(socketToLocalPort);
    });
    socketToLocalPort.on('error', (e) => {
      if (e.message.includes('ECONNREFUSED')) {
        console.log(`No server is running on port ${portToForward}, or the connection was refused. Starting one.`);
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

const socketToServer = createConnection({
  port: serverPort,
  host: serverHost,
});
socketToServer.on('data', (data: string) => {
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

    const localPortUsedWithServer = socketToServer.localPort;

    socketToServer.on('end', () => {
    // const socketToPrivatePeer = setupSocketToPeer(localPortUsedWithServer, peerPrivateAddress, forwardPort, 'private');
      const socketToPublicPeer = setupSocketToPeer(localPortUsedWithServer, peerPublicAddress, forwardPort, 'public');
    // socketToPrivatePeer.on('connect', socketToPublicPeer.end);
    // socketToPublicPeer.on('connect', socketToPrivatePeer.end);
    });
  }
});

socketToServer.on('connect', () => {
  console.log('Connected to the server from', socketToServer.address());
  socketToServer.write(JSON.stringify(
    {
      command: 'register',
      localPort: socketToServer.localPort,
      localAddress: socketToServer.localAddress,
    },
  ));
});

socketToServer.on('error', (e) => {
  throw e;
});

socketToServer.on('end', () => {
  console.log('closing socket to server');
});
