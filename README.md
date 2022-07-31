# nat_tunnel

Utility to make tunneling with NAT traversal easy. Think of STUN server / client, simpler - and less secure (no encryption yet).

Main resource: [Peer-to-Peer Communication Across Network Address Translators by Bryan Ford, Pyda Srisuresh & Dan Kegel](https://bford.info/pub/net/p2pnat/index.html)


## What

This utility allows to simply establish (when possible) a P2P connection between two clients behind a NAT using TCP hole punching.

### Example: Telnet chat

Assuming a server is running, on client A run:
```bash
node client.js --host rendez-vous.server.address --port rendez-vous.server.port --forward-port 2222
```

on client B run:
```bash
node client.js --host rendez-vous.server.address --port rendez-vous.server.port --forward-port 2223
```

on client A run:
```bash
telnet localhost 2222
```

on client B run:
```bash
telnet localhost 2223
```

:tada: You've got yourself a chat via NAT traversal!


### Example: Exposing a service

Imagine a service (like ssh) is running on client A on a port that you want to tunnel to client B. 

Assuming a server is running, on client A run:
```bash
node client.js --host rendez-vous.server.address --port rendez-vous.server.port --forward-port 22
```

on client B run:
```bash
node client.js --host rendez-vous.server.address --port rendez-vous.server.port --forward-port 2223
```

on client B run:
```bash
ssh -p 2223 userOfClientA@localhost
```

:tada: You've got yourself an ssh session via NAT traversal!


## Recommended network topology
NAT traversal does not work with every router or network topology.

For increased chances of success, I recommend the rendez-vous server and the peer clients to use different networks.

My setup was the following:
- A Raspberry Pi hosting the rendez-vous server on port 9999, behind a NAT forwarding its port 9999 to the Raspberry's 9999. This should be enough to make the rendez-vous server visible from the internet
- A MacBook Pro running one client connected to the internet via a phone hotspot
- Another MacBook Pro running one client connected to the internet via another phone hotspot

It is possible to have both clients live on the same network, but then there will be no NAT traversal of course.

## Installation

```bash
git clone https://github.com/qbalin/nat_tunnel.git
cd nat_tunnel
yarn install
```

To compile the TypeScript, run `yarn dev`, this should produce three files in the `build/` folder.

## Server setup
On the server, place the compiled files `index.js` and `address.js` next to each other. Then run:

```
node index.js --port 9999
```

This should spin the server on port 9999. Make sure it is reachable from the outside by configuring port forwarding on your router.

## Client setup
On the clients, place the compiled files `client.js` and `address.js` next to each other. Then run:
```
node client.js --host address.of.rendez-vous-server --port 9999 --forward-port 2222
```

where `host` and `port` are the address of the server's router and its opened port forwarded to the server, and forward port is the port on the local client that you wish to forward to the peer: it can be the port of a running service (like 22 for ssh, or 3000 for a local web app, etc...), but if no service is found running on that port, it will create a server on it. You can then read / write data to it with telnet for example. 
