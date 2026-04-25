import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  randomId, distance, compare, equal, bucketIndex,
  fromHex, toHex, sha1, ID_LENGTH, ID_BITS
} from '../src/kademlia/id.js'

import { RoutingTable, K } from '../src/kademlia/routing-table.js'

describe('Kademlia ID', () => {
  it('randomId generates 20-byte IDs', () => {
    const id = randomId()
    assert.equal(id.length, ID_LENGTH)
    assert.ok(id instanceof Uint8Array)
  })

  it('two random IDs are different', () => {
    const a = randomId()
    const b = randomId()
    assert.ok(!equal(a, b))
  })

  it('distance is symmetric', () => {
    const a = randomId()
    const b = randomId()
    assert.ok(equal(distance(a, b), distance(b, a)))
  })

  it('distance to self is zero', () => {
    const a = randomId()
    const d = distance(a, a)
    for (let i = 0; i < ID_LENGTH; i++) assert.equal(d[i], 0)
  })

  it('compare works', () => {
    const a = fromHex('0000000000000000000000000000000000000001')
    const b = fromHex('0000000000000000000000000000000000000002')
    assert.equal(compare(a, b), -1)
    assert.equal(compare(b, a), 1)
    assert.equal(compare(a, a), 0)
  })

  it('equal detects equality', () => {
    const a = fromHex('abcdef0123456789abcdef0123456789abcdef01')
    const b = fromHex('abcdef0123456789abcdef0123456789abcdef01')
    const c = fromHex('abcdef0123456789abcdef0123456789abcdef02')
    assert.ok(equal(a, b))
    assert.ok(!equal(a, c))
  })

  it('hex roundtrip', () => {
    const hex = 'deadbeef0123456789abcdef0123456789abcdef'
    assert.equal(toHex(fromHex(hex)), hex)
  })

  it('bucketIndex: MSB differs = bucket 159', () => {
    const self = fromHex('0000000000000000000000000000000000000000')
    const other = fromHex('8000000000000000000000000000000000000000')
    assert.equal(bucketIndex(self, other), 159)
  })

  it('bucketIndex: LSB differs = bucket 0', () => {
    const self = fromHex('0000000000000000000000000000000000000000')
    const close = fromHex('0000000000000000000000000000000000000001')
    assert.equal(bucketIndex(self, close), 0)
  })

  it('bucketIndex: equal = -1', () => {
    const self = fromHex('0000000000000000000000000000000000000000')
    assert.equal(bucketIndex(self, self), -1)
  })

  it('sha1 produces 20 bytes', async () => {
    const hash = await sha1('hello')
    assert.equal(hash.length, 20)
    assert.equal(toHex(hash), 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d')
  })
})

describe('RoutingTable', () => {
  it('starts empty', () => {
    const rt = new RoutingTable(randomId())
    assert.equal(rt.size, 0)
  })

  it('add a contact', () => {
    const rt = new RoutingTable(randomId())
    const result = rt.add(randomId(), 'addr1')
    assert.equal(result.action, 'added')
    assert.equal(rt.size, 1)
  })

  it('update existing contact', () => {
    const rt = new RoutingTable(randomId())
    const id = randomId()
    rt.add(id, 'addr1')
    const result = rt.add(id, 'addr2')
    assert.equal(result.action, 'updated')
    assert.equal(rt.size, 1)
    assert.equal(rt.get(id).address, 'addr2')
  })

  it('cannot add self', () => {
    const selfId = randomId()
    const rt = new RoutingTable(selfId)
    assert.equal(rt.add(selfId, 'x').action, 'self')
    assert.equal(rt.size, 0)
  })

  it('bucket full returns incumbent', () => {
    const selfId = fromHex('0000000000000000000000000000000000000000')
    const rt = new RoutingTable(selfId, 2)

    const id1 = fromHex('8000000000000000000000000000000000000001')
    const id2 = fromHex('8000000000000000000000000000000000000002')
    const id3 = fromHex('8000000000000000000000000000000000000003')

    rt.add(id1, 'a1')
    rt.add(id2, 'a2')
    const result = rt.add(id3, 'a3')

    assert.equal(result.action, 'full')
    assert.ok(equal(result.incumbent.id, id1))
  })

  it('closest returns sorted contacts', () => {
    const selfId = fromHex('0000000000000000000000000000000000000000')
    const rt = new RoutingTable(selfId)

    const ids = [
      fromHex('ff00000000000000000000000000000000000000'),
      fromHex('0f00000000000000000000000000000000000000'),
      fromHex('0000000000000000000000000000000000000001'),
      fromHex('00f0000000000000000000000000000000000000')
    ]
    ids.forEach((id, i) => rt.add(id, `a${i}`))

    const target = fromHex('0000000000000000000000000000000000000000')
    const closest = rt.closest(target, 4)

    assert.equal(closest.length, 4)
    assert.ok(equal(closest[0].id, ids[2])) // 00..01
    assert.ok(equal(closest[1].id, ids[3])) // 00f0..
    assert.ok(equal(closest[2].id, ids[1])) // 0f00..
    assert.ok(equal(closest[3].id, ids[0])) // ff00..
  })

  it('remove a contact', () => {
    const rt = new RoutingTable(randomId())
    const id = randomId()
    rt.add(id, 'addr')
    assert.ok(rt.remove(id))
    assert.equal(rt.size, 0)
  })

  it('recordFailure removes after max fails', () => {
    const rt = new RoutingTable(randomId())
    const id = randomId()
    rt.add(id, 'addr')
    for (let i = 0; i < 4; i++) assert.ok(!rt.recordFailure(id, 5))
    assert.ok(rt.recordFailure(id, 5))
    assert.equal(rt.size, 0)
  })

  it('replaceIncumbent swaps contacts', () => {
    const selfId = fromHex('0000000000000000000000000000000000000000')
    const rt = new RoutingTable(selfId, 1)

    const id1 = fromHex('8000000000000000000000000000000000000001')
    const id2 = fromHex('8000000000000000000000000000000000000002')

    rt.add(id1, 'a1')
    const result = rt.add(id2, 'a2')
    assert.equal(result.action, 'full')

    assert.ok(rt.replaceIncumbent(id1, result.candidate))
    assert.equal(rt.size, 1)
    assert.ok(rt.get(id2))
    assert.ok(!rt.get(id1))
  })
})
