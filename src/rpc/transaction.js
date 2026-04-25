/**
 * Transaction manager — matches RPC responses to pending requests
 *
 * Each outgoing query gets a 2-byte transaction ID. When a response arrives,
 * the transaction ID is used to find the corresponding callback. Transactions
 * that don't receive a response within the timeout period are failed.
 */

import { tidToHex } from './messages.js'

export class TransactionManager {
  /**
   * @param {number} [timeout=5000] - query timeout in ms
   */
  constructor (timeout = 5000) {
    this._timeout = timeout
    /** @type {Map<string, { resolve, reject, timer, nodeId }>} */
    this._pending = new Map()
  }

  get size () {
    return this._pending.size
  }

  /**
   * Register a pending transaction
   * @param {Uint8Array} tid - transaction ID
   * @param {Uint8Array} [nodeId] - the node we sent the query to (for failure tracking)
   * @returns {Promise<Object>} resolves with the response, rejects on timeout
   */
  register (tid, nodeId) {
    const key = tidToHex(tid)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(key)
        reject(new Error(`Transaction ${key} timed out`))
      }, this._timeout)

      if (timer.unref) timer.unref()

      this._pending.set(key, { resolve, reject, timer, nodeId })
    })
  }

  /**
   * Resolve a pending transaction with a response
   * @param {Uint8Array} tid - transaction ID from the response
   * @param {Object} response - decoded response message
   * @returns {boolean} true if a matching transaction was found
   */
  resolve (tid, response) {
    const key = tidToHex(tid)
    const tx = this._pending.get(key)
    if (!tx) return false

    clearTimeout(tx.timer)
    this._pending.delete(key)
    tx.resolve(response)
    return true
  }

  /**
   * Reject a pending transaction with an error
   * @param {Uint8Array} tid
   * @param {Error} error
   * @returns {boolean}
   */
  reject (tid, error) {
    const key = tidToHex(tid)
    const tx = this._pending.get(key)
    if (!tx) return false

    clearTimeout(tx.timer)
    this._pending.delete(key)
    tx.reject(error)
    return true
  }

  /**
   * Cancel all pending transactions
   */
  destroy () {
    for (const [key, tx] of this._pending) {
      clearTimeout(tx.timer)
      tx.reject(new Error('Transaction manager destroyed'))
    }
    this._pending.clear()
  }
}
