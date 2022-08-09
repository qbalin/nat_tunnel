import {
  createConnection, createServer, NetConnectOpts,
} from 'net';
import Address from './address';

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

/**
 * Interesting code starts here
 */
const setupSocketToPeer = (localPortUsedWithServer: number, peerAddress: Address, portToForward: number, networkType: 'public' | 'private') => {
  console.log(`\nAttempting ${networkType} connection towards ${peerAddress}`);
  console.log('localPortUsedWithServer', localPortUsedWithServer);

  const socketToPeerOptions = {
    localPort: localPortUsedWithServer,
    port: peerAddress.port,
    host: peerAddress.host,
  };

  // 5. try to connect to the peer in P2P!
  const socketToPeer = createConnection(socketToPeerOptions);
  socketToPeer.setKeepAlive(true);
  const tryToReconnect = limitExecutionCount(throttle(() => socketToPeer.connect(socketToPeerOptions), 1000), timeout);

  socketToPeer.on('error', (e) => {
    console.log(e.message);
    try {
      // 6. There is a chance that the connection to the peer will fail. Retry.
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

  // 7. We're connected to the peer!
  socketToPeer.on('connect', () => {
    console.log(`Connected to ${networkType} peer!`);
    console.log(`${networkType} socket info:`, socketToPeer.address());

    // 8. Trying to connect to a local service living on portToForward, like ssh on port 22,
    // and pipe the stream from that port to the peer.
    const socketToLocalPort = createConnection(portToForward);
    socketToLocalPort.once('connect', () => {
      console.log('connected to local service', socketToLocalPort.localPort);
      // If socketToLocalPort ever managed to connect to a local service, make sure it respawns
      // after it has been closed
      socketToLocalPort.on('close', () => {
        console.log('socketToLocalPort closed. Reconnecting.');
        socketToLocalPort.connect(portToForward);
      });
    });
    socketToLocalPort.on('connect', () => {
      console.log('forwarding port', portToForward, 'to peer');
      socketToLocalPort.pipe(socketToPeer, { end: false });
      socketToPeer.pipe(socketToLocalPort);
    });
    socketToLocalPort.on('error', (e) => {
      if (e.message.includes('ECONNREFUSED')) {
        // 9. If no service was running on the portToForward, there is nothing to pipe to the peer,
        // so let's create a local server. If anyone connects to this local server, the traffic
        // will be sent over to the peer.
        console.log(`No server is running on port ${portToForward}, or the connection was refused. Starting one.`);
        createServer((c) => {
          c.pipe(socketToPeer, { end: false });
          socketToPeer.pipe(c);
        }).listen(portToForward);
      } else {
        throw e;
      }
    });
  });
  return socketToPeer;
};

// 1. Connect to the rendez-vous server
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

  // 3. Server got information from a pair of peers trying to connect. To each, it sent
  // the coordinates of the other: the public (address, port) and private (address, port)
  if (parsedData?.command === 'tryConnectToPeer') {
    const peerPublicAddress = new Address(parsedData.public.host, parsedData.public.port);
    const peerPrivateAddress = new Address(parsedData.private.host, parsedData.private.port);

    console.log(`\nI am client ${parsedData.name}. Will try connecting with peer ${parsedData.peerName} at:`);
    console.log(`\tPrivately: ${peerPrivateAddress}`);
    console.log(`\tPublicly: ${peerPublicAddress}`);

    const localPortUsedWithServer = socketToServer.localPort as number;

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
