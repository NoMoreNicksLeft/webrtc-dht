import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { TransactionManager } from '../src/rpc/transaction.js'
import { nextTransactionId } from '../src/rpc/messages.js'

describe('TransactionManager', () => {
  it('starts empty', () => {
    const tm = new TransactionManager()
    assert.equal(tm.size, 0)
    tm.destroy()
  })

  it('register and resolve', async () => {
    const tm = new TransactionManager(5000)
    const tid = nextTransactionId()

    const promise = tm.register(tid)
    assert.equal(tm.size, 1)

    tm.resolve(tid, { id: 'test-response' })
    const result = await promise
    assert.deepEqual(result, { id: 'test-response' })
    assert.equal(tm.size, 0)
    tm.destroy()
  })

  it('register and reject', async () => {
    const tm = new TransactionManager(5000)
    const tid = nextTransactionId()

    const promise = tm.register(tid)
    tm.reject(tid, new Error('test error'))

    await assert.rejects(promise, { message: 'test error' })
    assert.equal(tm.size, 0)
    tm.destroy()
  })

  it('timeout rejects', async () => {
    const tm = new TransactionManager(50) // 50ms timeout
    const tid = nextTransactionId()

    const promise = tm.register(tid)
    await assert.rejects(promise, /timed out/)
    assert.equal(tm.size, 0)
    tm.destroy()
  })

  it('resolve unknown tid returns false', () => {
    const tm = new TransactionManager()
    const tid = nextTransactionId()
    assert.equal(tm.resolve(tid, {}), false)
    tm.destroy()
  })

  it('destroy cancels all pending', async () => {
    const tm = new TransactionManager(5000)
    const tid1 = nextTransactionId()
    const tid2 = nextTransactionId()

    const p1 = tm.register(tid1)
    const p2 = tm.register(tid2)
    assert.equal(tm.size, 2)

    tm.destroy()
    assert.equal(tm.size, 0)

    await assert.rejects(p1, /destroyed/)
    await assert.rejects(p2, /destroyed/)
  })
})
