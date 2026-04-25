/**
 * Ed25519 cryptographic operations for BEP 44 mutable items
 *
 * Uses Web Crypto API when available (Firefox 132+, Chrome 113+),
 * falls back to @noble/ed25519 for older browsers and Node.js.
 */

let _useWebCrypto = null

async function hasWebCryptoEd25519 () {
  if (_useWebCrypto !== null) return _useWebCrypto
  try {
    await globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
    _useWebCrypto = true
  } catch {
    _useWebCrypto = false
  }
  return _useWebCrypto
}

export async function generateKeyPair () {
  if (await hasWebCryptoEd25519()) {
    const keyPair = await globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
    const pubRaw = await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey)
    const privPkcs8 = await globalThis.crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
    return {
      publicKey: new Uint8Array(pubRaw),
      privateKey: new Uint8Array(privPkcs8).slice(-32)
    }
  }
  const ed = await import('@noble/ed25519')
  const privateKey = ed.utils.randomPrivateKey()
  const publicKey = await ed.getPublicKeyAsync(privateKey)
  return { publicKey, privateKey }
}

export async function sign (message, privateKey) {
  if (await hasWebCryptoEd25519()) {
    const pkcs8 = _wrapPkcs8Ed25519(privateKey)
    const key = await globalThis.crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign'])
    const sig = await globalThis.crypto.subtle.sign('Ed25519', key, message)
    return new Uint8Array(sig)
  }
  const ed = await import('@noble/ed25519')
  return ed.signAsync(message, privateKey)
}

export async function verify (signature, message, publicKey) {
  if (await hasWebCryptoEd25519()) {
    try {
      const key = await globalThis.crypto.subtle.importKey('raw', publicKey, 'Ed25519', false, ['verify'])
      return globalThis.crypto.subtle.verify('Ed25519', key, signature, message)
    } catch {
      return false
    }
  }
  const ed = await import('@noble/ed25519')
  try {
    return ed.verifyAsync(signature, message, publicKey)
  } catch {
    return false
  }
}

function _wrapPkcs8Ed25519 (seed) {
  const prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05,
    0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
  ])
  const result = new Uint8Array(prefix.length + 32)
  result.set(prefix)
  result.set(seed, prefix.length)
  return result
}
