import {
  createConnection, createServer, Socket, SocketConstructorOpts, TcpNetConnectOpts,
} from 'net';
import { randomUUID } from 'crypto';
import EventEmitter from 'events';
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

function rjust(stringOrNumberToPad: string | number, targetLength: number, paddingString: string) {
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

type Node<T> = {
  next: Node<T> | null
  value: T
}

class Queue<T> {
  private start: Node<T> | null = null;

  private end: Node<T> | null = null;

  push(value: T) {
    const newNode: Node<T> = { next: null, value };
    if (!this.end) {
      this.start = newNode;
      this.end = newNode;
    } else {
      this.end.next = newNode;
      this.end = newNode;
    }
  }

  pop() {
    if (!this.start) {
      return null;
    }
    const { value } = this.start;
    if (this.start.next) {
      this.start = this.start.next;
    } else {
      this.start = null;
      this.end = null;
    }
    return value;
  }
}

class MultiplexSocket extends Socket {
  private sending: boolean = false;

  private messageQueue: Queue<Buffer> = new Queue();

  private buffer: Buffer = Buffer.alloc(0);

  private maxBufferSizeDigits: number = 14;

  constructor(...args: SocketConstructorOpts[]) {
    super(...args);

    this.on('data', (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.buffer = this.emitMessagesFromBuffer(this.buffer, this.maxBufferSizeDigits);
    });
  }

  private emitMessagesFromBuffer(buffer: Buffer, maxBufferSizeDigits: number) : Buffer {
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
      this.emit('multiplex-data', message.subarray(0, 36).toString(), message.subarray(36));
      return this.emitMessagesFromBuffer(buffer.subarray(maxBufferSizeDigits + length), this.maxBufferSizeDigits);
    }
    return buffer;
  }

  multiplexWrite(channelId?: string, buffer?: Buffer) {
    const channelIdAndData = channelId && buffer && Buffer.concat([Buffer.from(channelId), buffer]);
    if (this.sending) {
      if (channelIdAndData) {
        console.log('is sending, queueing', buffer.toString());
        this.messageQueue.push(channelIdAndData);
      }
    } else {
      const message = channelIdAndData || this.messageQueue.pop();

      if (message) {
        this.sending = true;
        const length = Buffer.from(rjust(message.length, this.maxBufferSizeDigits, '0'));
        console.log('sending', message.length - 36);
        this.write(Buffer.concat([length, message]), () => {
          this.sending = false;
          this.multiplexWrite();
        });
      }
    }
  }

  flush() {
    this.buffer = Buffer.alloc(0);
    this.messageQueue = new Queue();
  }
}

/**
 * Interesting code starts here
 */

const eventEmitter = new EventEmitter();
const sockets : Record<string, Socket> = {};

const forwardPortThroughSocket = (socketToPeer: MultiplexSocket, portToForward: number) => {
  const messagesFor : Record<string, Array<Buffer>> = {};

  console.log('connected to peer!');
  socketToPeer.on('multiplex-data', (channelId: string, message: Buffer) => {
    console.log('\nMessage from peer', message.length);
    if (!sockets[channelId]) {
      sockets[channelId] = createConnection(portToForward);
      sockets[channelId].on('ready', () => {
        if (messagesFor[channelId]) {
          console.log('channelId', channelId, 'draining queued messages', messagesFor[channelId].map((e) => e.toString()));
          messagesFor[channelId].forEach((m) => sockets[channelId].write(m));
          delete messagesFor[channelId];
        }
      });

      sockets[channelId].on('data', (data: Buffer) => {
        console.log('channelId', channelId, 'message to peer', data.length);
        socketToPeer.multiplexWrite(channelId, data);
      });
    }

    if (['writeOnly', 'open'].includes(sockets[channelId].readyState)) {
      console.log('channelId', channelId, 'To local socket', message.length);
      sockets[channelId].write(message);
    } else {
      messagesFor[channelId] ||= [];
      messagesFor[channelId].push(message);
    }
  });

  createServer((localSocketToServer) => {
    const channelId = randomUUID();
    sockets[channelId] = localSocketToServer;

    localSocketToServer.on('data', (data: Buffer) => {
      console.log('-- message to peer', data.length);
      socketToPeer.multiplexWrite(channelId, data);
    });

    localSocketToServer.on('close', () => {
      delete sockets[channelId];
    });
  }).listen(portToForward)
    .on('error', (e) => {
      console.log(e);
      console.log('Service alread running on port', portToForward);
    });
};

const setupSocketToPeer = (localPortUsedWithServer: number, peerAddress: Address, portToForward: number, networkType: 'public' | 'private', ownAbortController: AbortController, otherAbortController: AbortController) : Promise<MultiplexSocket> => new Promise((resolve, reject) => {
  console.log(`\nAttempting ${networkType} connection towards ${peerAddress}`);
  console.log('localPortUsedWithServer', localPortUsedWithServer);

  const socketToPeerOptions : TcpNetConnectOpts = {
    localPort: localPortUsedWithServer,
    port: peerAddress.port,
    host: peerAddress.host,
  };

  // 5. try to connect to the peer in P2P!
  const socketToPeer = new MultiplexSocket();
  socketToPeer.connect(socketToPeerOptions);

  socketToPeer.setKeepAlive(true);
  const tryToReconnect = limitExecutionCount(throttle(() => socketToPeer.connect(socketToPeerOptions), 1000), timeout);

  socketToPeer.on('error', (e) => {
    console.log(e.message);
    try {
      // 6. There is a chance that the connection to the peer will fail. Retry, unless a connection is already successful.
      if (ownAbortController.signal.aborted) {
        reject(new Error(`Connection on ${networkType === 'private' ? 'public' : 'private'} network succeded, giving up ${networkType} connection attempt`));
      } else {
        tryToReconnect();
      }
    } catch (err) {
      console.error(`Failed to connect with peer on ${networkType} network`);
      console.error(e);
      socketToPeer.removeAllListeners();
      socketToPeer.destroy();
      reject(e);
    }
  });

  // 7. We're connected to the peer!
  socketToPeer.on('connect', () => {
    if (!ownAbortController.signal.aborted) {
      otherAbortController.abort();
    }
    resolve(socketToPeer);
  });
});

// 1. Connect to the rendez-vous server
const socketToServer = new MultiplexSocket();
socketToServer.connect({
  port: serverPort,
  host: serverHost,
}, () => {
  // 2. When connecte to rendez-vous server, send information about the
  // local port and address being used. These coordinates will be used
  // to connect on a private network, if the other peer happens to live on it.
  console.log('Connected to the server from', socketToServer.address());
  socketToServer.write(JSON.stringify(
    {
      command: 'register',
      relay: false,
      localPort: socketToServer.localPort,
      localAddress: socketToServer.localAddress,
    },
  ));
});

const handleDataFromServer = (data: string) => {
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
    socketToServer.on('end', async () => {
      const abortController1 = new AbortController();
      const abortController2 = new AbortController();
      const socketToPrivatePeer = setupSocketToPeer(localPortUsedWithServer, peerPrivateAddress, forwardPort, 'private', abortController1, abortController2);
      const socketToPublicPeer = setupSocketToPeer(localPortUsedWithServer, peerPublicAddress, forwardPort, 'public', abortController2, abortController1);

      try {
        // Promise.any will return the first socket that managed to connect.
        // The private and public can both succeed only if both peers are on the same network and the router allows hairpin connections. Rare.
        const socketToPeer = await Promise.any([socketToPrivatePeer, socketToPublicPeer]);

        // In case both have succeeded, discard the one that succeeded last
        Promise.allSettled([socketToPrivatePeer, socketToPublicPeer]).then((results) => {
          results.forEach((r) => {
            if (r.status === 'fulfilled' && r.value !== socketToPeer) {
              r.value.removeAllListeners();
              r.value.destroy();
            } else if (r.status === 'rejected') {
              console.log(r.reason.message);
            }
          });
        });
        eventEmitter.emit('socketReadyForPortForwarding', socketToPeer);
      } catch (e) {
        console.log('Attempts to connect in P2P failed. Will try via relay.');
        socketToServer.connect({ port: serverPort, host: serverHost }, () => {
          console.log('Connected to relay server.');
          socketToServer.write(JSON.stringify(
            {
              command: 'register',
              relay: true,
              localPort: socketToServer.localPort,
              localAddress: socketToServer.localAddress,
            },
          ));
        });
      }
    });
  } else if (parsedData?.command === 'initiateRelayedCommunication') {
    socketToServer.flush();
    socketToServer.removeListener('data', handleDataFromServer);
    eventEmitter.emit('socketReadyForPortForwarding', socketToServer);
  }
};

socketToServer.on('data', handleDataFromServer);

eventEmitter.on('socketReadyForPortForwarding', (socketToPeer: MultiplexSocket) => {
  forwardPortThroughSocket(socketToPeer, forwardPort);
});

socketToServer.on('error', (e) => {
  throw e;
});

socketToServer.on('end', () => {
  console.log('closing socket to server');
});
