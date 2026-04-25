/**
 * Kademlia ID utilities
 *
 * Node IDs and keys are 160-bit (20-byte) values.
 * Distance is computed as XOR of two IDs.
 * All IDs are represented as Uint8Array(20).
 */

export const ID_LENGTH = 20
export const ID_BITS = 160

/**
 * Generate a random 160-bit ID (synchronous)
 * @returns {Uint8Array}
 */
export function randomId () {
  const id = new Uint8Array(ID_LENGTH)
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(id)
    return id
  }
  // Node.js: crypto.getRandomValues is available since v19
  for (let i = 0; i < ID_LENGTH; i++) {
    id[i] = Math.floor(Math.random() * 256)
  }
  return id
}

/**
 * Compute XOR distance between two IDs
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {Uint8Array}
 */
export function distance (a, b) {
  if (a.length !== ID_LENGTH || b.length !== ID_LENGTH) {
    throw new Error(`IDs must be ${ID_LENGTH} bytes`)
  }
  const result = new Uint8Array(ID_LENGTH)
  for (let i = 0; i < ID_LENGTH; i++) {
    result[i] = a[i] ^ b[i]
  }
  return result
}

/**
 * Compare two IDs as big-endian unsigned integers
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {number} -1 if a < b, 0 if equal, 1 if a > b
 */
export function compare (a, b) {
  for (let i = 0; i < ID_LENGTH; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

/**
 * Check if two IDs are equal
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function equal (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Determine which k-bucket an ID falls into relative to our own ID.
 * Returns the index of the most significant differing bit.
 * Returns -1 if the IDs are equal.
 * Bucket 0 = closest (only LSB differs), bucket 159 = most distant (MSB differs).
 * @param {Uint8Array} self
 * @param {Uint8Array} other
 * @returns {number}
 */
export function bucketIndex (self, other) {
  const d = distance(self, other)
  for (let i = 0; i < ID_LENGTH; i++) {
    if (d[i] === 0) continue
    const byte = d[i]
    for (let bit = 7; bit >= 0; bit--) {
      if (byte & (1 << bit)) {
        return (ID_BITS - 1) - (i * 8 + (7 - bit))
      }
    }
  }
  return -1
}

/**
 * Convert a hex string to a Uint8Array ID
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function fromHex (hex) {
  if (hex.length !== ID_LENGTH * 2) {
    throw new Error(`Hex string must be ${ID_LENGTH * 2} characters`)
  }
  const id = new Uint8Array(ID_LENGTH)
  for (let i = 0; i < ID_LENGTH; i++) {
    id[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return id
}

/**
 * Convert a Uint8Array ID to a hex string
 * @param {Uint8Array} id
 * @returns {string}
 */
export function toHex (id) {
  let hex = ''
  for (let i = 0; i < id.length; i++) {
    hex += id[i].toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Compute SHA-1 hash of input data, returning a 20-byte ID
 * @param {Uint8Array|string} data
 * @returns {Promise<Uint8Array>}
 */
export async function sha1 (data) {
  const input = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data

  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const hash = await globalThis.crypto.subtle.digest('SHA-1', input)
    return new Uint8Array(hash)
  }
  // Node.js fallback
  const { createHash } = await import('node:crypto')
  const h = createHash('sha1')
  h.update(input)
  return new Uint8Array(h.digest())
}
