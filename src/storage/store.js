/**
 * BEP 44 item storage — mutable and immutable DHT items
 */

import { sha1, equal, toHex } from '../kademlia/id.js'
import { verify } from '../crypto/ed25519.js'

export class Store {
  constructor (maxItems = 1000) {
    this._items = new Map()
    this._maxItems = maxItems
  }

  get size () { return this._items.size }

  async putImmutable (target, v) {
    const computed = await sha1(v)
    if (!equal(computed, target)) return false
    this._items.set(toHex(target), { v: new Uint8Array(v), target: new Uint8Array(target) })
    this._evictIfNeeded()
    return true
  }

  getImmutable (target) {
    const item = this._items.get(toHex(target))
    if (!item || item.k) return null
    return item
  }

  async putMutable (k, salt, seq, sig, v, cas) {
    if (v.length > 1000) return { stored: false, error: 'value too large' }
    if (salt.length > 64) return { stored: false, error: 'salt too large' }

    const targetInput = new Uint8Array(k.length + salt.length)
    targetInput.set(k)
    targetInput.set(salt, k.length)
    const target = await sha1(targetInput)
    const key = toHex(target)

    const existing = this._items.get(key)
    if (existing && existing.k) {
      if (typeof cas === 'number' && existing.seq !== cas) {
        return { stored: false, error: `CAS mismatch: expected ${cas}, got ${existing.seq}` }
      }
      if (seq <= existing.seq) {
        return { stored: false, error: `seq ${seq} not greater than current ${existing.seq}` }
      }
    }

    const sigMessage = this._buildSignMessage(salt, seq, v)
    const valid = await verify(sig, sigMessage, k)
    if (!valid) return { stored: false, error: 'signature verification failed' }

    this._items.set(key, {
      k: new Uint8Array(k),
      salt: new Uint8Array(salt),
      seq, sig: new Uint8Array(sig),
      v: new Uint8Array(v),
      target: new Uint8Array(target)
    })
    this._evictIfNeeded()
    return { stored: true }
  }

  getMutable (target) {
    const item = this._items.get(toHex(target))
    if (!item || !item.k) return null
    return item
  }

  get (target) {
    return this._items.get(toHex(target)) || null
  }

  remove (target) {
    return this._items.delete(toHex(target))
  }

  /**
   * Build BEP 44 signature message:
   *   [4:salt{len}:{salt}]3:seqi{seq}e1:v{len}:{v}
   */
  _buildSignMessage (salt, seq, v) {
    let prefix = ''
    if (salt.length > 0) {
      prefix = `4:salt${salt.length}:`
    }
    const seqPart = `3:seqi${seq}e1:v${v.length}:`

    const prefixBytes = new TextEncoder().encode(prefix)
    const seqBytes = new TextEncoder().encode(seqPart)

    const result = new Uint8Array(prefixBytes.length + salt.length + seqBytes.length + v.length)
    let offset = 0
    result.set(prefixBytes, offset); offset += prefixBytes.length
    if (salt.length > 0) { result.set(salt, offset); offset += salt.length }
    result.set(seqBytes, offset); offset += seqBytes.length
    result.set(v, offset)
    return result
  }

  _evictIfNeeded () {
    if (this._items.size <= this._maxItems) return
    const firstKey = this._items.keys().next().value
    this._items.delete(firstKey)
  }
}
