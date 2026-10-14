const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { SyncService } = require('./sync-service.cjs')

function waitFor(predicate, timeoutMs = 2500) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('Timed out waiting for sync watcher'))
      setTimeout(check, 25)
    }
    check()
  })
}

test('watches local changes, debounces them, and stops cleanly', async (context) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unite-drive-watch-'))
  context.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const statuses = []
  let syncCount = 0
  const service = new SyncService({ syncOnce: async () => ({ completed: 0, failed: 0, retrying: 0, count: ++syncCount }) }, {
    rootPath: root,
    debounceMs: 40,
    remotePollMs: 60_000,
    onStatus: (status) => statuses.push(status.status),
  })
  context.after(() => service.stop())

  await service.start()
  assert.equal(syncCount, 1)
  const filePath = path.join(root, 'new-file.txt')
  await fs.promises.writeFile(filePath, 'change')
  await waitFor(() => syncCount >= 2)
  await service.stop()
  assert.equal(statuses.at(-1), 'paused')
})

test('start resolves before the initial sync when awaitInitialSync is false', async (context) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unite-drive-watch-'))
  context.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  let releaseSync
  const gate = new Promise((resolve) => { releaseSync = resolve })
  let syncStarted = false
  const service = new SyncService({
    syncOnce: async () => {
      syncStarted = true
      await gate
      return { completed: 0, failed: 0, retrying: 0 }
    },
  }, { rootPath: root, debounceMs: 40, remotePollMs: 60_000 })
  context.after(() => service.stop())

  // Resolves while the initial sync is still blocked on the gate.
  await service.start({ awaitInitialSync: false })
  assert.equal(syncStarted, true)

  releaseSync()
  await service.syncNow()
  await service.stop()
})
