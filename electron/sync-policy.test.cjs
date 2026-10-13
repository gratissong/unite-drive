const test = require('node:test')
const assert = require('node:assert/strict')
const { planSyncAction } = require('./sync-policy.cjs')

test('uploads a local-only change', () => {
  assert.deepEqual(planSyncAction({ baselineHash: 'old', localHash: 'new', remoteHash: 'old' }), { type: 'upload' })
})

test('downloads a remote-only change', () => {
  assert.deepEqual(planSyncAction({ baselineHash: 'old', localHash: 'old', remoteHash: 'new' }), { type: 'download' })
})

test('keeps both versions when both sides changed', () => {
  assert.deepEqual(
    planSyncAction({ baselineHash: 'old', localHash: 'local', remoteHash: 'remote' }),
    { type: 'keep-both', preserveRemoteAsConflictCopy: true, uploadLocal: true },
  )
})

test('moves a locally deleted remote file to recoverable trash', () => {
  assert.deepEqual(
    planSyncAction({ baselineHash: 'old', localExists: false, remoteHash: 'old' }),
    { type: 'trash-remote' },
  )
})

test('keeps the local copy if a remote deletion is not propagated', () => {
  assert.deepEqual(
    planSyncAction({ baselineHash: 'old', localHash: 'old', remoteExists: false, deletionPolicy: 'keep-other-copy' }),
    { type: 'restore-remote' },
  )
})

test('preserves matching first-sync files without conflict', () => {
  assert.deepEqual(planSyncAction({ baselineHash: null, localHash: 'same', remoteHash: 'same' }), { type: 'in-sync', baselineHash: 'same' })
})
