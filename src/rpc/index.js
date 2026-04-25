/**
 * RPC layer — ties transport (peer pool) to message encoding and transactions
 *
 * Provides a high-level interface for sending DHT queries and handling
 * incoming queries from other nodes.
 */

import { EventEmitter } from 'events'
import { TransactionManager } from './transaction.js'
import * as msg from './messages.js'

export class RPC extends EventEmitter {
  /**
   * @param {import('../transport/peer-pool.js').PeerPool} pool
   * @param {Uint8Array} selfId - our node ID
   * @param {Object} [opts]
   * @param {number} [opts.timeout=5000]
   */
  constructor (pool, selfId, opts = {}) {
    super()
    this.pool = pool
    this.selfId = selfId
    this.transactions = new TransactionManager(opts.timeout || 5000)

    // Handle incoming messages from peers
    this.pool.on('message', (nodeId, data) => {
      this._onMessage(nodeId, data)
    })
  }

  // --- Outgoing queries ---

  async ping (nodeId) {
    const { tid, msg: data } = await msg.pingQuery(this.selfId)
    this.pool.send(nodeId, data)
    return this.transactions.register(tid, nodeId)
  }

  async findNode (nodeId, target) {
    const { tid, msg: data } = await msg.findNodeQuery(this.selfId, target)
    this.pool.send(nodeId, data)
    return this.transactions.register(tid, nodeId)
  }

  async getPeers (nodeId, infoHash) {
    const { tid, msg: data } = await msg.getPeersQuery(this.selfId, infoHash)
    this.pool.send(nodeId, data)
    return this.transactions.register(tid, nodeId)
  }

  async announcePeer (nodeId, infoHash, port, token) {
    const { tid, msg: data } = await msg.announcePeerQuery(this.selfId, infoHash, port, token)
    this.pool.send(nodeId, data)
    return this.transactions.register(tid, nodeId)
  }

  async get (nodeId, target, seq) {
    const { tid, msg: data } = await msg.getQuery(this.selfId, target, seq)
    this.pool.send(nodeId, data)
    return this.transactions.register(tid, nodeId)
  }

  async putMutable (nodeId, token, k, salt, seq, sig, v, cas) {
    const { tid, msg: data } = await msg.putMutableQuery(this.selfId, token, k, salt, seq, sig, v, cas)
    this.pool.send(nodeId, data)
    return this.transactions.register(tid, nodeId)
  }

  async putImmutable (nodeId, token, v) {
    const { tid, msg: data } = await msg.putImmutableQuery(this.selfId, token, v)
    this.pool.send(nodeId, data)
    return this.transactions.register(tid, nodeId)
  }

  // --- Respond to queries ---

  async respond (nodeId, tid, r) {
    const data = await msg.response(tid, r)
    this.pool.send(nodeId, data)
  }

  async respondError (nodeId, tid, code, message) {
    const data = await msg.errorResponse(tid, code, message)
    this.pool.send(nodeId, data)
  }

  // --- Incoming message handling ---

  async _onMessage (nodeId, data) {
    const decoded = await msg.decode(data)
    if (!decoded) return

    const type = decoded.y
    if (type === 'r' || type === 'e') {
      // Response or error — match to pending transaction
      const tid = decoded.t
      if (!tid) return

      if (type === 'e') {
        const err = decoded.e
        const error = new Error(
          Array.isArray(err) ? `DHT error ${err[0]}: ${err[1]}` : 'Unknown DHT error'
        )
        this.transactions.reject(tid, error)
      } else {
        this.transactions.resolve(tid, decoded.r || {})
      }
    } else if (type === 'q') {
      // Incoming query — emit for the DHT node to handle
      this.emit('query', {
        nodeId,
        tid: decoded.t,
        method: decoded.q?.toString?.() || decoded.q,
        args: decoded.a || {}
      })
    }
  }

  destroy () {
    this.transactions.destroy()
  }
}
