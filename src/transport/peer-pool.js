/**
 * Peer pool — manages WebRTC connections to DHT nodes via simple-peer
 *
 * Each DHT peer connection wraps a simple-peer instance. Messages are
 * sent and received as bencoded buffers on the default data channel.
 *
 * The pool handles:
 * - Creating outgoing connections (initiator = true)
 * - Accepting incoming connections (initiator = false)
 * - Routing messages to/from connected peers by node ID
 * - Connection lifecycle (connect, disconnect, error)
 */

import { EventEmitter } from 'events'
import { equal, toHex } from '../kademlia/id.js'

export class PeerPool extends EventEmitter {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.maxPeers=100] - max simultaneous connections
   * @param {Object} [opts.simplePeerOpts] - options passed to simple-peer constructor
   */
  constructor (opts = {}) {
    super()
    this.maxPeers = opts.maxPeers || 100
    this.simplePeerOpts = opts.simplePeerOpts || {}

    /** @type {Map<string, { peer, nodeId, connected }>} */
    this._peers = new Map()

    this._SimplePeer = null // loaded lazily
  }

  get size () {
    return this._peers.size
  }

  /**
   * Get the simple-peer constructor (lazy load)
   */
  async _getSimplePeer () {
    if (!this._SimplePeer) {
      const mod = await import('@thaunknown/simple-peer')
      this._SimplePeer = mod.default || mod
    }
    return this._SimplePeer
  }

  /**
   * Create an outgoing connection to a new peer
   * @param {Uint8Array} nodeId - the remote node's DHT ID
   * @returns {{ peer, signal: Promise<Object> }} - the peer and a promise for the first signal
   */
  async createOutgoing (nodeId) {
    if (this._peers.size >= this.maxPeers) {
      throw new Error('Peer pool is full')
    }

    const key = toHex(nodeId)
    if (this._peers.has(key)) {
      return this._peers.get(key)
    }

    const SimplePeer = await this._getSimplePeer()
    const peer = new SimplePeer({
      initiator: true,
      trickle: true,
      ...this.simplePeerOpts
    })

    const entry = { peer, nodeId: new Uint8Array(nodeId), connected: false }
    this._peers.set(key, entry)
    this._setupPeer(key, entry)

    // Return a promise that resolves with the first signal (SDP offer)
    const signal = new Promise((resolve, reject) => {
      peer.once('signal', resolve)
      peer.once('error', reject)
    })

    return { entry, signal }
  }

  /**
   * Accept an incoming connection
   * @param {Uint8Array} nodeId - the remote node's DHT ID
   * @param {Object} signalData - the SDP offer from the remote peer
   * @returns {{ peer, signal: Promise<Object> }} - the peer and a promise for the answer signal
   */
  async acceptIncoming (nodeId, signalData) {
    if (this._peers.size >= this.maxPeers) {
      throw new Error('Peer pool is full')
    }

    const key = toHex(nodeId)

    // If we already have a connection to this node, destroy the old one
    if (this._peers.has(key)) {
      this.disconnect(nodeId)
    }

    const SimplePeer = await this._getSimplePeer()
    const peer = new SimplePeer({
      initiator: false,
      trickle: true,
      ...this.simplePeerOpts
    })

    const entry = { peer, nodeId: new Uint8Array(nodeId), connected: false }
    this._peers.set(key, entry)
    this._setupPeer(key, entry)

    // Feed the offer signal
    peer.signal(signalData)

    // Return a promise that resolves with our answer signal
    const signal = new Promise((resolve, reject) => {
      peer.once('signal', resolve)
      peer.once('error', reject)
    })

    return { entry, signal }
  }

  /**
   * Feed a signaling message to an existing peer
   * @param {Uint8Array} nodeId
   * @param {Object} signalData
   */
  signal (nodeId, signalData) {
    const key = toHex(nodeId)
    const entry = this._peers.get(key)
    if (!entry) return false
    entry.peer.signal(signalData)
    return true
  }

  /**
   * Send data to a connected peer
   * @param {Uint8Array} nodeId
   * @param {Uint8Array} data - bencoded message
   * @returns {boolean} true if sent
   */
  send (nodeId, data) {
    const key = toHex(nodeId)
    const entry = this._peers.get(key)
    if (!entry || !entry.connected) return false
    try {
      entry.peer.send(data)
      return true
    } catch {
      return false
    }
  }

  /**
   * Disconnect from a peer
   * @param {Uint8Array} nodeId
   */
  disconnect (nodeId) {
    const key = toHex(nodeId)
    const entry = this._peers.get(key)
    if (!entry) return
    entry.peer.destroy()
    this._peers.delete(key)
  }

  /**
   * Check if we're connected to a peer
   * @param {Uint8Array} nodeId
   * @returns {boolean}
   */
  isConnected (nodeId) {
    const key = toHex(nodeId)
    const entry = this._peers.get(key)
    return entry ? entry.connected : false
  }

  /**
   * Get all connected peer node IDs
   * @returns {Uint8Array[]}
   */
  connectedIds () {
    const ids = []
    for (const entry of this._peers.values()) {
      if (entry.connected) ids.push(entry.nodeId)
    }
    return ids
  }

  /**
   * Destroy all connections
   */
  destroy () {
    for (const [key, entry] of this._peers) {
      entry.peer.destroy()
    }
    this._peers.clear()
  }

  /**
   * Wire up event handlers for a peer
   */
  _setupPeer (key, entry) {
    const { peer, nodeId } = entry

    peer.on('connect', () => {
      entry.connected = true
      this.emit('connect', nodeId)
    })

    peer.on('data', (data) => {
      this.emit('message', nodeId, new Uint8Array(data))
    })

    peer.on('close', () => {
      entry.connected = false
      this._peers.delete(key)
      this.emit('disconnect', nodeId)
    })

    peer.on('error', (err) => {
      entry.connected = false
      this._peers.delete(key)
      this.emit('error', nodeId, err)
    })
  }
}
