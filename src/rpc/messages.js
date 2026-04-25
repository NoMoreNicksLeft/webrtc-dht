/**
 * DHT RPC message encoding/decoding — bencoded, matching mainline DHT format (BEP 5 + BEP 44)
 */

let bencode = null

async function getBencode () {
  if (!bencode) bencode = await import('bencode')
  return bencode
}

const CLIENT_VERSION = 'WD01'
let _txCounter = 0

export function nextTransactionId () {
  _txCounter = (_txCounter + 1) & 0xFFFF
  return new Uint8Array([(_txCounter >> 8) & 0xFF, _txCounter & 0xFF])
}

export function tidToHex (tid) {
  return Array.from(tid).map(b => b.toString(16).padStart(2, '0')).join('')
}

// --- Query builders ---

export async function pingQuery (selfId) {
  const bc = await getBencode()
  const tid = nextTransactionId()
  const msg = bc.encode({ t: tid, y: 'q', q: 'ping', a: { id: selfId }, v: CLIENT_VERSION })
  return { tid, msg }
}

export async function findNodeQuery (selfId, target) {
  const bc = await getBencode()
  const tid = nextTransactionId()
  const msg = bc.encode({ t: tid, y: 'q', q: 'find_node', a: { id: selfId, target } })
  return { tid, msg }
}

export async function getPeersQuery (selfId, infoHash) {
  const bc = await getBencode()
  const tid = nextTransactionId()
  const msg = bc.encode({ t: tid, y: 'q', q: 'get_peers', a: { id: selfId, info_hash: infoHash } })
  return { tid, msg }
}

export async function announcePeerQuery (selfId, infoHash, port, token, impliedPort = true) {
  const bc = await getBencode()
  const tid = nextTransactionId()
  const msg = bc.encode({
    t: tid, y: 'q', q: 'announce_peer',
    a: { id: selfId, info_hash: infoHash, port, token, implied_port: impliedPort ? 1 : 0 }
  })
  return { tid, msg }
}

export async function getQuery (selfId, target, seq) {
  const bc = await getBencode()
  const tid = nextTransactionId()
  const a = { id: selfId, target }
  if (typeof seq === 'number') a.seq = seq
  const msg = bc.encode({ t: tid, y: 'q', q: 'get', a })
  return { tid, msg }
}

export async function putMutableQuery (selfId, token, k, salt, seq, sig, v, cas) {
  const bc = await getBencode()
  const tid = nextTransactionId()
  const a = { id: selfId, token, k, seq, sig, v }
  if (salt.length > 0) a.salt = salt
  if (typeof cas === 'number') a.cas = cas
  const msg = bc.encode({ t: tid, y: 'q', q: 'put', a })
  return { tid, msg }
}

export async function putImmutableQuery (selfId, token, v) {
  const bc = await getBencode()
  const tid = nextTransactionId()
  const msg = bc.encode({ t: tid, y: 'q', q: 'put', a: { id: selfId, token, v } })
  return { tid, msg }
}

// --- Response builders ---

export async function response (tid, r) {
  const bc = await getBencode()
  return bc.encode({ t: tid, y: 'r', r, v: CLIENT_VERSION })
}

export async function errorResponse (tid, code, message) {
  const bc = await getBencode()
  return bc.encode({ t: tid, y: 'e', e: [code, message] })
}

// --- Message parsing ---

export async function decode (data) {
  const bc = await getBencode()
  try { return bc.decode(data) } catch { return null }
}

// --- Compact node encoding ---

export function encodeNodes (nodes) {
  const buf = new Uint8Array(nodes.length * 26)
  for (let i = 0; i < nodes.length; i++) {
    buf.set(nodes[i].id, i * 26)
  }
  return buf
}

export function decodeNodes (buf) {
  const nodes = []
  for (let i = 0; i + 26 <= buf.length; i += 26) {
    nodes.push({ id: buf.slice(i, i + 20) })
  }
  return nodes
}
