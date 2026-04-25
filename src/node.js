/**
 * DHT Node — high-level Kademlia DHT implementation
 *
 * Implements iterative lookups (find_node, get_peers, get, put),
 * handles incoming queries, maintains the routing table, and
 * manages the bootstrap process.
 */

import { EventEmitter } from 'events'
import { randomId, distance, compare, equal, toHex, fromHex, sha1, bucketIndex, ID_LENGTH } from './kademlia/id.js'
import { RoutingTable, K } from './kademlia/routing-table.js'
import { RPC } from './rpc/index.js'
import { TokenManager } from './crypto/tokens.js'
import { Store } from './storage/store.js'
import { PeerPool } from './transport/peer-pool.js'
import { SignalingClient } from './transport/signaling.js'
import { encodeNodes, decodeNodes } from './rpc/messages.js'

// Kademlia concurrency parameter
const ALPHA = 3

export class DHTNode extends EventEmitter {
  /**
   * @param {Object} [opts]
   * @param {Uint8Array} [opts.nodeId] - 20-byte node ID (random if not provided)
   * @param {string[]} [opts.trackers] - WebSocket tracker URLs for bootstrap
   * @param {number} [opts.k=20] - k-bucket size
   * @param {number} [opts.timeout=5000] - RPC query timeout in ms
   * @param {number} [opts.maxPeers=100] - max WebRTC connections
   * @param {Object} [opts.simplePeerOpts] - options for simple-peer
   * @param {number} [opts.maxItems=1000] - max items in the DHT store
   */
  constructor (opts = {}) {
    super()
    this.nodeId = opts.nodeId || randomId()
    this.k = opts.k || K

    this.routingTable = new RoutingTable(this.nodeId, this.k)
    this.tokens = new TokenManager()
    this.store = new Store(opts.maxItems || 1000)

    // Peer storage: info_hash -> Set of peer identifiers
    this._peerStore = new Map()

    this.pool = new PeerPool({
      maxPeers: opts.maxPeers || 100,
      simplePeerOpts: opts.simplePeerOpts || {}
    })

    this.rpc = new RPC(this.pool, this.nodeId, { timeout: opts.timeout || 5000 })

    this.signaling = new SignalingClient({
      trackers: opts.trackers || ['wss://tracker.openwebtorrent.com'],
      nodeId: this.nodeId
    })

    this._destroyed = false
    this._bootstrapped = false

    // Handle incoming queries
    this.rpc.on('query', (query) => this._handleQuery(query))

    // When a new peer connects, add to routing table
    this.pool.on('connect', (nodeId) => {
      this.routingTable.add(nodeId, toHex(nodeId))
      this.emit('peer', nodeId)
    })

    this.pool.on('disconnect', (nodeId) => {
      this.emit('peer:disconnect', nodeId)
    })
  }

  /**
   * Join the DHT network
   * Connects to trackers, finds initial peers, populates routing table
   */
  async join () {
    if (this._destroyed) throw new Error('Node is destroyed')

    // Start signaling — connect to trackers and exchange offers
    await this.signaling.start(
      // createOffer: create an outgoing simple-peer and return its SDP offer
      async () => {
        const tempId = randomId()
        const { entry, signal } = await this.pool.createOutgoing(tempId)
        const sdpOffer = await signal
        const offerId = toHex(tempId)
        return { offerId, sdpOffer }
      },
      // createAnswer: accept an incoming offer and return our SDP answer
      async (sdpOffer, remotePeerId) => {
        const nodeId = fromHex(remotePeerId.padEnd(40, '0').substring(0, 40))
        const { entry, signal } = await this.pool.acceptIncoming(nodeId, sdpOffer)
        const sdpAnswer = await signal
        return { sdpAnswer, nodeId }
      }
    )

    // Handle answers to our outgoing offers
    this.signaling.on('answer', ({ offerId, sdpAnswer, remotePeerId }) => {
      const nodeId = fromHex(offerId.padEnd(40, '0').substring(0, 40))
      this.pool.signal(nodeId, sdpAnswer)
    })

    // Wait for at least one peer connection
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        resolve() // Don't fail — might get peers later
      }, 10000)
      if (timeout.unref) timeout.unref()

      this.pool.once('connect', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    // Bootstrap: do a find_node for our own ID to populate the routing table
    if (this.pool.size > 0) {
      await this._iterativeFindNode(this.nodeId)
      this._bootstrapped = true
    }

    this.emit('ready')

    // Periodic refresh of stale buckets
    this._refreshInterval = setInterval(() => this._refresh(), 15 * 60 * 1000)
    if (this._refreshInterval.unref) this._refreshInterval.unref()
  }

  // --- Public API ---

  /**
   * Find nodes closest to a target
   * @param {Uint8Array} target - 20-byte target ID
   * @returns {Promise<Contact[]>}
   */
  async findNode (target) {
    return this._iterativeFindNode(target)
  }

  /**
   * Find peers for a torrent
   * @param {Uint8Array} infoHash - 20-byte info hash
   * @returns {Promise<{ peers: string[], nodes: Contact[] }>}
   */
  async getPeers (infoHash) {
    return this._iterativeGetPeers(infoHash)
  }

  /**
   * Announce that we have a torrent
   * @param {Uint8Array} infoHash
   */
  async announcePeer (infoHash) {
    const closest = await this._iterativeFindNode(infoHash)
    const promises = []
    for (const contact of closest.slice(0, this.k)) {
      if (!this.pool.isConnected(contact.id)) continue
      try {
        // We need a token from each node first (via get_peers)
        const resp = await this.rpc.getPeers(contact.id, infoHash)
        if (resp.token) {
          promises.push(
            this.rpc.announcePeer(contact.id, infoHash, 0, resp.token).catch(() => {})
          )
        }
      } catch {
        // Skip failed nodes
      }
    }
    await Promise.allSettled(promises)
  }

  /**
   * BEP 44: Get an item from the DHT (mutable or immutable)
   * @param {Uint8Array} target - sha1(k + salt) for mutable, sha1(bencode(v)) for immutable
   * @param {number} [minSeq] - for mutable: only return if seq > minSeq
   * @returns {Promise<Object|null>} the item, or null if not found
   */
  async get (target, minSeq) {
    // Check local store first
    const local = this.store.get(target)
    if (local && (!minSeq || (local.seq && local.seq > minSeq))) {
      return local
    }

    // Iterative lookup
    const closest = await this._iterativeFindNode(target)
    let best = local

    for (const contact of closest) {
      if (!this.pool.isConnected(contact.id)) continue
      try {
        const resp = await this.rpc.get(contact.id, target, minSeq)
        if (resp.v) {
          // Got an item — check if it's better than what we have
          if (resp.k) {
            // Mutable item
            if (!best || (resp.seq > (best.seq || -1))) {
              best = {
                k: resp.k,
                salt: resp.salt || new Uint8Array(0),
                seq: resp.seq,
                sig: resp.sig,
                v: resp.v,
                target
              }
              // Store locally
              await this.store.putMutable(resp.k, resp.salt || new Uint8Array(0), resp.seq, resp.sig, resp.v)
            }
          } else {
            // Immutable item
            best = { v: resp.v, target }
            await this.store.putImmutable(target, resp.v)
          }
        }
      } catch {
        // Skip failed nodes
      }
    }

    return best
  }

  /**
   * BEP 44: Put a mutable item into the DHT
   * @param {Uint8Array} k - 32-byte public key
   * @param {Uint8Array} salt
   * @param {number} seq
   * @param {Uint8Array} sig - 64-byte signature
   * @param {Uint8Array} v - bencoded value (max 1000 bytes)
   * @param {number} [cas] - optional CAS
   * @returns {Promise<number>} number of nodes that accepted the put
   */
  async putMutable (k, salt, seq, sig, v, cas) {
    // Store locally first
    const result = await this.store.putMutable(k, salt, seq, sig, v, cas)
    if (!result.stored) {
      throw new Error(result.error)
    }

    // Compute target
    const targetInput = new Uint8Array(k.length + salt.length)
    targetInput.set(k)
    targetInput.set(salt, k.length)
    const target = await sha1(targetInput)

    // Find closest nodes and put to each
    const closest = await this._iterativeFindNode(target)
    let stored = 0

    for (const contact of closest.slice(0, this.k)) {
      if (!this.pool.isConnected(contact.id)) continue
      try {
        // Get a write token first
        const getResp = await this.rpc.get(contact.id, target)
        if (getResp.token) {
          await this.rpc.putMutable(contact.id, getResp.token, k, salt, seq, sig, v, cas)
          stored++
        }
      } catch {
        // Skip failed nodes
      }
    }

    return stored
  }

  /**
   * BEP 44: Put an immutable item into the DHT
   * @param {Uint8Array} v - bencoded value
   * @returns {Promise<{ target: Uint8Array, stored: number }>}
   */
  async putImmutable (v) {
    const target = await sha1(v)
    await this.store.putImmutable(target, v)

    const closest = await this._iterativeFindNode(target)
    let stored = 0

    for (const contact of closest.slice(0, this.k)) {
      if (!this.pool.isConnected(contact.id)) continue
      try {
        const getResp = await this.rpc.get(contact.id, target)
        if (getResp.token) {
          await this.rpc.putImmutable(contact.id, getResp.token, v)
          stored++
        }
      } catch {
        // Skip
      }
    }

    return { target, stored }
  }

  /**
   * Destroy the node and clean up
   */
  destroy () {
    this._destroyed = true
    if (this._refreshInterval) clearInterval(this._refreshInterval)
    this.signaling.destroy()
    this.rpc.destroy()
    this.tokens.destroy()
    this.pool.destroy()
    this.removeAllListeners()
  }

  // --- Iterative lookups ---

  /**
   * Iterative find_node: find the K closest nodes to a target
   */
  async _iterativeFindNode (target) {
    const closest = this.routingTable.closest(target, this.k)
    if (closest.length === 0) return []

    const queried = new Set()
    const found = new Map() // hex -> contact

    // Seed with our closest known contacts
    for (const c of closest) {
      found.set(toHex(c.id), c)
    }

    let improved = true
    while (improved) {
      improved = false

      // Pick ALPHA closest un-queried nodes
      const sorted = [...found.values()]
        .filter(c => !queried.has(toHex(c.id)))
        .sort((a, b) => compare(distance(a.id, target), distance(b.id, target)))
        .slice(0, ALPHA)

      if (sorted.length === 0) break

      const promises = sorted.map(async (contact) => {
        queried.add(toHex(contact.id))
        if (!this.pool.isConnected(contact.id)) return []
        try {
          const resp = await this.rpc.findNode(contact.id, target)
          if (resp.nodes) {
            return decodeNodes(resp.nodes instanceof Uint8Array ? resp.nodes : new Uint8Array(resp.nodes))
          }
          return []
        } catch {
          this.routingTable.recordFailure(contact.id)
          return []
        }
      })

      const results = await Promise.all(promises)
      for (const nodes of results) {
        for (const node of nodes) {
          if (equal(node.id, this.nodeId)) continue
          const hex = toHex(node.id)
          if (!found.has(hex)) {
            found.set(hex, { id: node.id, address: hex, lastSeen: Date.now(), failCount: 0 })
            this.routingTable.add(node.id, hex)
            improved = true
          }
        }
      }
    }

    // Return K closest
    return [...found.values()]
      .sort((a, b) => compare(distance(a.id, target), distance(b.id, target)))
      .slice(0, this.k)
  }

  /**
   * Iterative get_peers: find peers for an info hash
   */
  async _iterativeGetPeers (infoHash) {
    const closest = await this._iterativeFindNode(infoHash)
    const allPeers = new Set()

    for (const contact of closest) {
      if (!this.pool.isConnected(contact.id)) continue
      try {
        const resp = await this.rpc.getPeers(contact.id, infoHash)
        if (resp.values) {
          for (const peer of resp.values) {
            allPeers.add(typeof peer === 'string' ? peer : toHex(peer))
          }
        }
      } catch {
        // Skip
      }
    }

    return { peers: [...allPeers], nodes: closest }
  }

  // --- Incoming query handler ---

  async _handleQuery ({ nodeId, tid, method, args }) {
    // Add querying node to our routing table
    this.routingTable.add(nodeId, toHex(nodeId))

    const selfId = this.nodeId
    const address = toHex(nodeId)

    switch (method) {
      case 'ping': {
        await this.rpc.respond(nodeId, tid, { id: selfId })
        break
      }

      case 'find_node': {
        const target = args.target
        if (!target || target.length !== ID_LENGTH) {
          await this.rpc.respondError(nodeId, tid, 203, 'invalid target')
          return
        }
        const closest = this.routingTable.closest(target, this.k, nodeId)
        await this.rpc.respond(nodeId, tid, {
          id: selfId,
          nodes: encodeNodes(closest)
        })
        break
      }

      case 'get_peers': {
        const infoHash = args.info_hash
        if (!infoHash || infoHash.length !== ID_LENGTH) {
          await this.rpc.respondError(nodeId, tid, 203, 'invalid info_hash')
          return
        }

        const token = await this.tokens.generate(address)
        const key = toHex(infoHash)
        const peers = this._peerStore.get(key)

        if (peers && peers.size > 0) {
          await this.rpc.respond(nodeId, tid, {
            id: selfId,
            token,
            values: [...peers]
          })
        } else {
          const closest = this.routingTable.closest(infoHash, this.k, nodeId)
          await this.rpc.respond(nodeId, tid, {
            id: selfId,
            token,
            nodes: encodeNodes(closest)
          })
        }
        break
      }

      case 'announce_peer': {
        const infoHash = args.info_hash
        const token = args.token
        if (!infoHash || !token) {
          await this.rpc.respondError(nodeId, tid, 203, 'missing fields')
          return
        }

        const valid = await this.tokens.verify(token, address)
        if (!valid) {
          await this.rpc.respondError(nodeId, tid, 203, 'invalid token')
          return
        }

        const key = toHex(infoHash)
        if (!this._peerStore.has(key)) {
          this._peerStore.set(key, new Set())
        }
        this._peerStore.get(key).add(address)

        await this.rpc.respond(nodeId, tid, { id: selfId })
        break
      }

      case 'get': {
        const target = args.target
        if (!target || target.length !== ID_LENGTH) {
          await this.rpc.respondError(nodeId, tid, 203, 'invalid target')
          return
        }

        const token = await this.tokens.generate(address)
        const item = this.store.get(target)

        if (item) {
          const r = { id: selfId, token, v: item.v }
          if (item.k) {
            r.k = item.k
            r.seq = item.seq
            r.sig = item.sig
            if (item.salt && item.salt.length > 0) r.salt = item.salt
          }
          await this.rpc.respond(nodeId, tid, r)
        } else {
          // No item — return closest nodes
          const closest = this.routingTable.closest(target, this.k, nodeId)
          await this.rpc.respond(nodeId, tid, {
            id: selfId,
            token,
            nodes: encodeNodes(closest)
          })
        }
        break
      }

      case 'put': {
        const token = args.token
        if (!token) {
          await this.rpc.respondError(nodeId, tid, 203, 'missing token')
          return
        }

        const valid = await this.tokens.verify(token, address)
        if (!valid) {
          await this.rpc.respondError(nodeId, tid, 203, 'invalid token')
          return
        }

        if (args.k) {
          // Mutable put
          const result = await this.store.putMutable(
            args.k, args.salt || new Uint8Array(0),
            args.seq, args.sig, args.v, args.cas
          )
          if (!result.stored) {
            await this.rpc.respondError(nodeId, tid, 301, result.error)
            return
          }
          this.emit('mutable:update', {
            k: args.k,
            salt: args.salt || new Uint8Array(0),
            seq: args.seq,
            v: args.v
          })
        } else {
          // Immutable put
          const target = await sha1(args.v)
          const stored = await this.store.putImmutable(target, args.v)
          if (!stored) {
            await this.rpc.respondError(nodeId, tid, 301, 'hash mismatch')
            return
          }
        }

        await this.rpc.respond(nodeId, tid, { id: selfId })
        break
      }

      default:
        await this.rpc.respondError(nodeId, tid, 204, `unknown method: ${method}`)
    }
  }

  // --- Maintenance ---

  async _refresh () {
    const stale = this.routingTable.staleIndexes()
    for (const idx of stale) {
      // Generate a random ID in this bucket's range and look it up
      const target = randomId()
      try {
        await this._iterativeFindNode(target)
      } catch {
        // Ignore refresh failures
      }
    }
  }
}
