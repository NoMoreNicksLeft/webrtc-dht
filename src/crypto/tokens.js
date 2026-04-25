/**
 * Token management for DHT put authorization
 */

import { sha1 } from '../kademlia/id.js'

export class TokenManager {
  constructor (rotateInterval = 5 * 60 * 1000) {
    this._secret = this._generateSecret()
    this._previousSecret = this._secret
    this._rotateInterval = rotateInterval
    this._intervalId = setInterval(() => {
      this._previousSecret = this._secret
      this._secret = this._generateSecret()
    }, this._rotateInterval)
    if (this._intervalId.unref) this._intervalId.unref()
  }

  async generate (address) {
    const data = new TextEncoder().encode(this._secret + ':' + address)
    return sha1(data)
  }

  async verify (token, address) {
    const current = await sha1(new TextEncoder().encode(this._secret + ':' + address))
    if (this._equal(token, current)) return true
    const previous = await sha1(new TextEncoder().encode(this._previousSecret + ':' + address))
    return this._equal(token, previous)
  }

  destroy () {
    clearInterval(this._intervalId)
  }

  _generateSecret () {
    const bytes = new Uint8Array(16)
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes)
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
    }
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  _equal (a, b) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false
    }
    return true
  }
}
