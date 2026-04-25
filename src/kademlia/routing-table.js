/**
 * Kademlia routing table with k-buckets
 */

import { ID_BITS, distance, compare, equal, bucketIndex } from './id.js'

export const K = 20

/**
 * @typedef {Object} Contact
 * @property {Uint8Array} id
 * @property {*} address
 * @property {number} lastSeen
 * @property {number} failCount
 */

export class RoutingTable {
  /**
   * @param {Uint8Array} selfId
   * @param {number} [k=K]
   */
  constructor (selfId, k = K) {
    this.selfId = selfId
    this.k = k
    this.buckets = new Array(ID_BITS)
    for (let i = 0; i < ID_BITS; i++) {
      this.buckets[i] = []
    }
  }

  get size () {
    let count = 0
    for (const bucket of this.buckets) {
      count += bucket.length
    }
    return count
  }

  /**
   * Add or update a contact.
   * Returns an action object:
   *   { action: 'added', contact }
   *   { action: 'updated' }
   *   { action: 'full', incumbent, candidate }
   *   { action: 'self' }
   */
  add (id, address) {
    if (equal(id, this.selfId)) {
      return { action: 'self' }
    }

    const idx = bucketIndex(this.selfId, id)
    if (idx < 0) return { action: 'self' }

    const bucket = this.buckets[idx]

    const existingIdx = bucket.findIndex(c => equal(c.id, id))
    if (existingIdx !== -1) {
      const contact = bucket.splice(existingIdx, 1)[0]
      contact.address = address
      contact.lastSeen = Date.now()
      contact.failCount = 0
      bucket.push(contact)
      return { action: 'updated' }
    }

    const contact = {
      id: new Uint8Array(id),
      address,
      lastSeen: Date.now(),
      failCount: 0
    }

    if (bucket.length < this.k) {
      bucket.push(contact)
      return { action: 'added', contact }
    }

    return { action: 'full', incumbent: bucket[0], candidate: contact }
  }

  /**
   * Replace the incumbent with a candidate when incumbent fails to respond.
   */
  replaceIncumbent (incumbentId, candidate) {
    const idx = bucketIndex(this.selfId, incumbentId)
    if (idx < 0) return false

    const bucket = this.buckets[idx]
    const incumbentIdx = bucket.findIndex(c => equal(c.id, incumbentId))
    if (incumbentIdx === -1) return false

    bucket.splice(incumbentIdx, 1)
    candidate.lastSeen = Date.now()
    candidate.failCount = 0
    bucket.push(candidate)
    return true
  }

  remove (id) {
    const idx = bucketIndex(this.selfId, id)
    if (idx < 0) return false

    const bucket = this.buckets[idx]
    const contactIdx = bucket.findIndex(c => equal(c.id, id))
    if (contactIdx === -1) return false

    bucket.splice(contactIdx, 1)
    return true
  }

  recordFailure (id, maxFails = 5) {
    const idx = bucketIndex(this.selfId, id)
    if (idx < 0) return false

    const bucket = this.buckets[idx]
    const contact = bucket.find(c => equal(c.id, id))
    if (!contact) return false

    contact.failCount++
    if (contact.failCount >= maxFails) {
      this.remove(id)
      return true
    }
    return false
  }

  /**
   * Find the K closest contacts to a target ID.
   */
  closest (target, count = this.k, exclude = null) {
    const all = []
    for (const bucket of this.buckets) {
      for (const contact of bucket) {
        if (exclude && equal(contact.id, exclude)) continue
        all.push(contact)
      }
    }

    all.sort((a, b) => {
      const da = distance(a.id, target)
      const db = distance(b.id, target)
      return compare(da, db)
    })

    return all.slice(0, count)
  }

  get (id) {
    const idx = bucketIndex(this.selfId, id)
    if (idx < 0) return null

    const bucket = this.buckets[idx]
    return bucket.find(c => equal(c.id, id)) || null
  }

  toArray () {
    const all = []
    for (const bucket of this.buckets) {
      for (const contact of bucket) {
        all.push(contact)
      }
    }
    return all
  }

  staleIndexes (maxAge = 15 * 60 * 1000) {
    const now = Date.now()
    const stale = []
    for (let i = 0; i < ID_BITS; i++) {
      const bucket = this.buckets[i]
      if (bucket.length === 0) continue
      const newest = Math.max(...bucket.map(c => c.lastSeen))
      if (now - newest > maxAge) {
        stale.push(i)
      }
    }
    return stale
  }
}
