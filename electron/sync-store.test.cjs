const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createSyncStore, normalizeRelativePath } = require('./sync-store.cjs')

function withStore(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unite-drive-store-'))
  const databasePath = path.join(directory, 'sync.sqlite')
  let store = createSyncStore(databasePath)
  try {
    run({ store, databasePath })
  } finally {
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('persists account mappings and file baselines across restarts', () => {
  withStore(({ store, databasePath }) => {
    store.upsertAccount({ id: 'drive-a', email: 'a@example.com', rootFolderId: 'root-a', quotaBytes: 1000 })
    store.upsertFile({ relativePath: 'photos/one.jpg', accountId: 'drive-a', driveFileId: 'remote-1', baselineHash: 'hash-1' })
    const reopened = createSyncStore(databasePath)
    try {
      assert.equal(reopened.getAccount('drive-a').root_folder_id, 'root-a')
      assert.equal(reopened.getFile('photos/one.jpg').drive_file_id, 'remote-1')
      assert.equal(reopened.getFile('photos/one.jpg').baseline_hash, 'hash-1')
    } finally {
      reopened.close()
    }
  })
})

test('persists file size in the manifest', () => {
  withStore(({ store }) => {
    store.upsertAccount({ id: 'drive-a', email: 'a@example.com' })
    store.upsertFile({ relativePath: 'photos/one.jpg', accountId: 'drive-a', sizeBytes: 4096 })
    assert.equal(store.getFile('photos/one.jpg').size_bytes, 4096)
    store.upsertFile({ relativePath: 'photos/one.jpg', accountId: 'drive-a', sizeBytes: 8192 })
    assert.equal(store.getFile('photos/one.jpg').size_bytes, 8192)
  })
})

test('removes an account along with its files and queued work', () => {
  withStore(({ store }) => {
    store.upsertAccount({ id: 'drive-a', email: 'a@example.com' })
    store.upsertAccount({ id: 'drive-b', email: 'b@example.com' })
    store.upsertFile({ relativePath: 'photos/one.jpg', accountId: 'drive-a', driveFileId: 'f1', baselineHash: 'h1' })
    store.upsertFile({ relativePath: 'docs/two.pdf', accountId: 'drive-b', driveFileId: 'f2', baselineHash: 'h2' })
    store.enqueueOperation({ id: 'op-a', kind: 'upload', relativePath: 'photos/one.jpg', accountId: 'drive-a' })
    store.enqueueOperation({ id: 'op-b', kind: 'upload', relativePath: 'docs/two.pdf', accountId: 'drive-b' })

    store.removeAccount('drive-a')

    assert.deepEqual(store.listAccounts().map((account) => account.id), ['drive-b'])
    assert.deepEqual(store.listFiles().map((file) => file.relative_path), ['docs/two.pdf'])
    assert.deepEqual(store.listOperations().map((operation) => operation.id), ['op-b'])
  })
})

test('queues idempotently and claims only ready work', () => {
  withStore(({ store }) => {
    const operation = store.enqueueOperation({ id: 'op-1', kind: 'upload', relativePath: 'report.pdf', payload: { size: 20 } })
    store.enqueueOperation({ id: 'op-1', kind: 'download', relativePath: 'other.pdf' })

    assert.equal(store.listOperations().length, 1)
    assert.deepEqual(operation.payload, { size: 20 })
    assert.equal(store.claimNextOperation().state, 'running')
    assert.equal(store.getOperation('op-1').attempts, 1)
    assert.equal(store.claimNextOperation(), null)
  })
})

test('respects retry time and recovers interrupted work', () => {
  withStore(({ store }) => {
    store.enqueueOperation({ id: 'op-retry', kind: 'download', relativePath: 'file.bin', nextAttemptAt: '2030-01-01T00:00:00.000Z' })
    assert.equal(store.claimNextOperation('2029-01-01T00:00:00.000Z'), null)
    assert.equal(store.claimNextOperation('2031-01-01T00:00:00.000Z').state, 'running')
    assert.equal(store.recoverInterruptedOperations(), 1)
    assert.equal(store.getOperation('op-retry').state, 'queued')
  })
})

test('rejects paths that escape the sync root', () => {
  assert.throws(() => normalizeRelativePath('../outside.txt'), /inside the sync root/)
  assert.throws(() => normalizeRelativePath('C:\\outside.txt'), /inside the sync root/)
})

test('rejects Windows-unsafe path names', () => {
  for (const bad of [
    'report.txt:hidden', // NTFS alternate data stream (ADS)
    'nul', // reserved device name
    'CON.txt', // reserved device name regardless of extension
    'voice/com1.wav', // reserved device name in a nested folder
    'trailing space ', // trailing space is stripped by Windows -> collision
    'trailing dot.', // trailing dot is stripped by Windows -> collision
    'split<angle>.txt', // Windows-illegal character
  ]) {
    assert.throws(() => normalizeRelativePath(bad), /inside the sync root/)
  }
  // Legitimate names still pass, and backslash remains a path separator.
  assert.equal(normalizeRelativePath('photos/My Report 2026.txt'), 'photos/My Report 2026.txt')
  assert.equal(normalizeRelativePath('photos\\nested\\file.txt'), 'photos/nested/file.txt')
})

test('resets local mappings and queued work while preserving connected accounts', () => {
  withStore(({ store }) => {
    store.upsertAccount({ id: 'drive-a', email: 'a@example.com' })
    store.upsertFile({ relativePath: 'file.txt', accountId: 'drive-a' })
    store.enqueueOperation({ kind: 'upload', relativePath: 'file.txt' })
    store.setMetadata('activeSyncRoot', 'C:/sync')
    store.resetSyncState()

    assert.deepEqual(store.listFiles(), [])
    assert.deepEqual(store.listOperations(), [])
    assert.equal(store.getMetadata('activeSyncRoot'), null)
    assert.equal(store.getAccount('drive-a').email, 'a@example.com')
  })
})

test('requeues failed operations only when explicitly requested', () => {
  withStore(({ store }) => {
    store.enqueueOperation({ id: 'failed-op', kind: 'upload', relativePath: 'file.txt' })
    store.claimNextOperation()
    store.updateOperation('failed-op', 'failed', { error: 'permanent until user retry' })

    assert.equal(store.requeueFailedOperations(), 1)
    assert.equal(store.getOperation('failed-op').state, 'queued')
    assert.equal(store.getOperation('failed-op').attempts, 0)
    assert.equal(store.getOperation('failed-op').last_error, null)
  })
})

test('persists notifications and supports unread, mark-read, and clear operations', () => {
  withStore(({ store, databasePath }) => {
    const first = store.addNotification({ id: 'notice-1', kind: 'error', title: 'Sync failed', message: 'Quota unavailable', createdAt: '2026-01-01T00:00:00.000Z' })
    store.addNotification({ id: 'notice-2', kind: 'success', title: 'Sync complete', message: 'One file downloaded', createdAt: '2026-01-02T00:00:00.000Z' })

    assert.equal(first.read_at, null)
    assert.equal(store.countUnreadNotifications(), 2)
    assert.equal(store.listNotifications()[0].id, 'notice-2')
    assert.equal(store.markNotificationRead('notice-1'), 1)
    assert.equal(store.countUnreadNotifications(), 1)

    store.close()
    const reopened = createSyncStore(databasePath)
    try {
      assert.equal(reopened.listNotifications()[1].title, 'Sync failed')
      assert.equal(reopened.countUnreadNotifications(), 1)
      assert.equal(reopened.markAllNotificationsRead(), 1)
      assert.equal(reopened.countUnreadNotifications(), 0)
      assert.equal(reopened.clearNotifications(), 2)
      assert.equal(reopened.listNotifications().length, 0)
    } finally {
      reopened.close()
    }
  })
})

test('cancels a queued operation and clears completed history', () => {
  withStore(({ store }) => {
    store.enqueueOperation({ id: 'queued-op', kind: 'upload', relativePath: 'queued.txt' })
    store.enqueueOperation({ id: 'done-op', kind: 'download', relativePath: 'done.txt' })
    store.updateOperation('done-op', 'completed')

    assert.equal(store.deleteOperation('queued-op'), 1)
    assert.equal(store.getOperation('queued-op'), null)
    assert.equal(store.listOperations().length, 1)

    assert.equal(store.clearCompletedOperations(), 1)
    assert.deepEqual(store.listOperations(), [])
  })
})

test('prunes completed operations beyond the retention count while keeping active work', () => {
  withStore(({ store }) => {
    for (let index = 0; index < 5; index += 1) {
      store.enqueueOperation({ id: `done-${index}`, kind: 'upload', relativePath: `done-${index}.txt` })
      store.updateOperation(`done-${index}`, 'completed')
    }
    store.enqueueOperation({ id: 'active', kind: 'upload', relativePath: 'active.txt' })

    assert.equal(store.pruneOperations({ maxCompleted: 3 }), 2)
    assert.equal(store.listOperations('completed').length, 3)
    assert.ok(store.listOperations().some((operation) => operation.id === 'active'))
  })
})

test('prunes completed operations past the retention window', () => {
  withStore(({ store }) => {
    store.enqueueOperation({ id: 'done-op', kind: 'upload', relativePath: 'done.txt' })
    store.updateOperation('done-op', 'completed')
    store.enqueueOperation({ id: 'active-op', kind: 'upload', relativePath: 'active.txt' })

    assert.equal(store.pruneOperations({ retentionDays: -1 }), 1)
    assert.equal(store.getOperation('done-op'), null)
    assert.equal(store.getOperation('active-op').state, 'queued')
  })
})

test('stores and reads the per-account Drive changes page token', () => {
  withStore(({ store, databasePath }) => {
    store.upsertAccount({ id: 'drive-a', email: 'a@example.com' })
    assert.equal(store.getChangesPageToken('drive-a'), null)

    store.setChangesPageToken('drive-a', '42')
    assert.equal(store.getChangesPageToken('drive-a'), '42')

    // The token survives a reopen.
    store.close()
    const reopened = createSyncStore(databasePath)
    try {
      assert.equal(reopened.getChangesPageToken('drive-a'), '42')
      reopened.setChangesPageToken('drive-a', null)
      assert.equal(reopened.getChangesPageToken('drive-a'), null)
    } finally {
      reopened.close()
    }
  })
})

test('runs a batch atomically and rolls back when it throws', () => {
  withStore(({ store }) => {
    store.upsertAccount({ id: 'drive-a', email: 'a@example.com' })
    store.upsertFile({ relativePath: 'before.txt', accountId: 'drive-a' })

    const result = store.withTransaction(() => {
      store.setChangesPageToken('drive-a', '7')
      store.upsertFile({ relativePath: 'inside.txt', accountId: 'drive-a' })
      return 'ok'
    })
    assert.equal(result, 'ok')
    assert.equal(store.getChangesPageToken('drive-a'), '7')
    assert.equal(store.getFile('inside.txt').relative_path, 'inside.txt')

    assert.throws(() =>
      store.withTransaction(() => {
        store.setChangesPageToken('drive-a', '99')
        store.upsertFile({ relativePath: 'rolled-back.txt', accountId: 'drive-a' })
        throw new Error('boom')
      }),
      /boom/,
    )
    // Nothing written inside the failed transaction persisted.
    assert.equal(store.getChangesPageToken('drive-a'), '7')
    assert.equal(store.getFile('rolled-back.txt'), null)
  })
})
