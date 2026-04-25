# webrtc-dht

General-purpose Kademlia DHT over WebRTC with BEP 44 mutable item support.

## Status

🚧 **Under active development** — not yet ready for production use.

## Features (planned)

- **Kademlia DHT** — Standard k-bucket routing, XOR distance, iterative lookups
- **WebRTC transport** — Runs in the browser using WebRTC data channels
- **BEP 5** — Peer discovery (`get_peers`, `announce_peer`)
- **BEP 44** — Immutable and mutable item storage with Ed25519 signing
- **BEP 46** — Mutable torrent resolution
- **Bencode wire format** — Compatible with mainline DHT message format
- **Bootstrap via WebSocket trackers** — Uses existing WebTorrent tracker infrastructure
- **Peer-relayed signaling** — Self-sustaining after initial bootstrap

## Why?

WebTorrent currently has no DHT in the browser — peer discovery relies entirely on
WebSocket trackers. This package gives browser peers a real DHT for the first time,
enabling:

1. Trackerless peer discovery
2. Mutable torrent support (BEP 44/46)
3. Decentralized applications built on signed, versioned DHT items

## License

MIT
