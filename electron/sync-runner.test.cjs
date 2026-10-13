const test = require('node:test')
const assert = require('node:assert/strict')
const { createSyncStore } = require('./sync-store.cjs')
const { SyncRunner } = require('./sync-runner.cjs')

async function withStore(run) {
  const store = createSyncStore(':memory:')
  try {
    return await run(store)
  } finally {
    store.close()
  }
}

test('retries transient failures with backoff and completes later', async () => {
  await withStore(async (store) => {
    store.enqueueOperation({ id: 'retry-me', kind: 'upload', relativePath: 'file.txt' })
    let now = Date.now()
    let attempts = 0
    const runner = new SyncRunner(store, {
      upload: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('temporary network failure')
        return 'uploaded'
      },
    }, { clock: () => now, random: () => 0, baseDelayMs: 100 })

    const first = await runner.runNext()
    assert.equal(first.state, 'retry')
    assert.equal(store.getOperation('retry-me').state, 'retry')
    assert.equal(store.claimNextOperation(new Date(now).toISOString()), null)
    now = Date.parse(first.nextAttemptAt)
    const second = await runner.runNext()
    assert.deepEqual(second, { operationId: 'retry-me', state: 'completed', result: 'uploaded' })
  })
})

test('moves exhausted operations to a visible failed state', async () => {
  await withStore(async (store) => {
    store.enqueueOperation({ id: 'always-fails', kind: 'upload', relativePath: 'file.txt' })
    const runner = new SyncRunner(store, { upload: async () => { throw new Error('permanent failure') } }, { maxAttempts: 1 })
    const result = await runner.runNext()
    assert.equal(result.state, 'failed')
    assert.match(store.getOperation('always-fails').last_error, /permanent failure/)
  })
})

test('does not claim work before its retry timestamp', async () => {
  await withStore(async (store) => {
    store.enqueueOperation({ id: 'future', kind: 'upload', relativePath: 'file.txt', nextAttemptAt: '2030-01-01T00:00:00.000Z' })
    const runner = new SyncRunner(store, { upload: async () => 'uploaded' }, { clock: () => Date.parse('2029-01-01T00:00:00.000Z') })
    assert.equal(await runner.runNext(), null)
  })
})
