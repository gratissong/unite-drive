const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createSyncStore } = require('./sync-store.cjs')
const { FakeDriveProvider } = require('./fake-drive-provider.cjs')
const { SyncEngine } = require('./sync-engine.cjs')

async function withEngine({ localFiles = {}, providers, settings = {}, runnerOptions } = {}, run) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unite-drive-engine-'))
  const rootPath = path.join(directory, 'sync-root')
  await fs.promises.mkdir(rootPath)
  for (const [relativePath, content] of Object.entries(localFiles)) {
    const filePath = path.join(rootPath, ...relativePath.split('/'))
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    await fs.promises.writeFile(filePath, content)
  }
  const store = createSyncStore(':memory:')
  const engine = new SyncEngine({
    rootPath,
    store,
    providers,
    settings: { conflictPolicy: 'keep-both', deletionPolicy: 'propagate-to-trash', storageReservePercent: 0, ...settings },
    trashLocal: async (filePath) => fs.promises.rename(filePath, `${filePath}.trashed`),
    runnerOptions,
  })
  try {
    await run({ directory, rootPath, store, engine })
  } finally {
    store.close()
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
}

function drive(accountId, options = {}) {
  return new FakeDriveProvider({ accountId, email: `${accountId}@example.com`, quotaBytes: 1024 ** 2, ...options })
}

test('uploads local files into a managed root and records a baseline', async () => {
  const provider = drive('drive-a')
  await withEngine({ localFiles: { 'docs/notes.txt': 'local content' }, providers: [provider] }, async ({ engine, store }) => {
    const first = await engine.syncOnce()
    const remote = await provider.listManagedFiles(provider.rootFolderId)
    assert.equal(first.completed, 1)
    assert.equal(remote.length, 1)
    assert.equal(remote[0].relativePath, 'docs/notes.txt')
    assert.equal(store.getFile('docs/notes.txt').drive_file_id, remote[0].driveFileId)
    assert.equal(store.getFile('docs/notes.txt').size_bytes, Buffer.byteLength('local content'))
    const second = await engine.syncOnce()
    assert.equal(second.actionsQueued, 0)
    assert.equal((await provider.listManagedFiles(provider.rootFolderId)).length, 1)
  })
})

test('downloads pre-existing files only from the app-managed root', async () => {
  const provider = drive('drive-a')
  provider.seedFile({ relativePath: 'docs/from-drive.txt', content: 'remote content' })
  await withEngine({ providers: [provider] }, async ({ rootPath, engine }) => {
    await engine.syncOnce()
    assert.equal(await fs.promises.readFile(path.join(rootPath, 'docs', 'from-drive.txt'), 'utf8'), 'remote content')
  })
})

test('downloads a file added in Drive after initial sync into the local folder', async () => {
  const provider = drive('drive-a')
  await withEngine({ providers: [provider] }, async ({ rootPath, engine, store }) => {
    await engine.syncOnce()
    provider.seedFile({ relativePath: 'added-later.txt', content: 'created in Drive' })
    const result = await engine.syncOnce()

    assert.equal(result.completed, 1)
    assert.equal(await fs.promises.readFile(path.join(rootPath, 'added-later.txt'), 'utf8'), 'created in Drive')
    assert.ok(store.getFile('added-later.txt'))
  })
})

test('downloads a same-name Drive addition as a conflict copy without replacing local content', async () => {
  const provider = drive('drive-a')
  await withEngine({ localFiles: { 'same.txt': 'local copy' }, providers: [provider] }, async ({ rootPath, engine }) => {
    await engine.syncOnce()
    provider.seedFile({ relativePath: 'same.txt', content: 'added separately in Drive' })
    const result = await engine.syncOnce()

    assert.equal(result.failed, 0)
    assert.equal(await fs.promises.readFile(path.join(rootPath, 'same.txt'), 'utf8'), 'local copy')
    const localNames = await fs.promises.readdir(rootPath)
    const conflictName = localNames.find((name) => name.includes('(conflict from'))
    assert.ok(conflictName)
    assert.equal(await fs.promises.readFile(path.join(rootPath, conflictName), 'utf8'), 'added separately in Drive')
  })
})

test('keeps divergent first-sync copies under distinct paths', async () => {
  const provider = drive('drive-a')
  provider.seedFile({ relativePath: 'report.txt', content: 'cloud version', modifiedAt: '2026-10-10T12:00:00.000Z' })
  await withEngine({ localFiles: { 'report.txt': 'local version' }, providers: [provider] }, async ({ rootPath, engine }) => {
    await engine.syncOnce()
    const files = await provider.listManagedFiles(provider.rootFolderId)
    assert.equal(files.length, 2)
    assert.equal(files.some((file) => file.relativePath === 'report.txt'), true)
    const conflict = files.find((file) => file.relativePath.includes('(conflict from'))
    assert.ok(conflict)
    assert.equal(await fs.promises.readFile(path.join(rootPath, conflict.relativePath), 'utf8'), 'cloud version')
    assert.equal(await fs.promises.readFile(path.join(rootPath, 'report.txt'), 'utf8'), 'local version')
  })
})

test('does not propagate deletions when first sync resumes after a conflict rename', async () => {
  const provider = drive('drive-a')
  provider.seedFile({ relativePath: 'report.txt', content: 'cloud version', modifiedAt: '2026-10-10T12:00:00.000Z' })
  provider.failNext('downloadFile', new Error('temporary download failure'))
  let now = Date.now() + 1000
  await withEngine({
    localFiles: { 'report.txt': 'local version' },
    providers: [provider],
    runnerOptions: { clock: () => now, random: () => 0, baseDelayMs: 1 },
  }, async ({ engine }) => {
    const interrupted = await engine.syncOnce()
    assert.equal(interrupted.firstSyncComplete, false)
    assert.equal(interrupted.retrying, 1)

    now += 1000
    const resumed = await engine.syncOnce()
    assert.equal(resumed.firstSyncComplete, true)
    const remoteFiles = await provider.listManagedFiles(provider.rootFolderId)
    assert.equal(remoteFiles.length, 2)
    assert.equal(remoteFiles.some((file) => file.relativePath.includes('(conflict from')), true)
  })
})

test('keeps both versions when local and Drive edits race', async () => {
  const provider = drive('drive-a')
  await withEngine({ localFiles: { 'report.txt': 'same version' }, providers: [provider] }, async ({ rootPath, engine }) => {
    await engine.syncOnce()
    const original = (await provider.listManagedFiles(provider.rootFolderId))[0]
    await fs.promises.writeFile(path.join(rootPath, 'report.txt'), 'local edit')
    provider.seedFile({ relativePath: 'report.txt', content: 'Drive edit', driveFileId: original.driveFileId })
    await engine.syncOnce()

    const files = await provider.listManagedFiles(provider.rootFolderId)
    assert.equal(files.length, 2)
    const cloudConflict = files.find((file) => file.relativePath.includes('(conflict from'))
    assert.ok(cloudConflict)
    assert.equal(await fs.promises.readFile(path.join(rootPath, cloudConflict.relativePath), 'utf8'), 'Drive edit')
    assert.equal(await fs.promises.readFile(path.join(rootPath, 'report.txt'), 'utf8'), 'local edit')
  })
})

test('propagates local deletion to recoverable Drive trash', async () => {
  const provider = drive('drive-a')
  await withEngine({ localFiles: { 'remove.txt': 'content' }, providers: [provider] }, async ({ rootPath, engine, store }) => {
    await engine.syncOnce()
    const remote = (await provider.listManagedFiles(provider.rootFolderId))[0]
    await fs.promises.rm(path.join(rootPath, 'remove.txt'))
    await engine.syncOnce()
    assert.equal((await provider.listManagedFiles(provider.rootFolderId)).length, 0)
    assert.equal((await provider.getQuota()).usageBytes, Buffer.byteLength('content'))
    assert.equal(store.getFile('remove.txt').sync_state, 'tombstone')
    await provider.restoreFile(remote.driveFileId)
  })
})

test('preserves a Drive edit after local deletion without repeating conflict copies', async () => {
  const provider = drive('drive-a')
  await withEngine({ localFiles: { 'changed.txt': 'original' }, providers: [provider] }, async ({ rootPath, engine }) => {
    await engine.syncOnce()
    const original = (await provider.listManagedFiles(provider.rootFolderId))[0]
    await fs.promises.rm(path.join(rootPath, 'changed.txt'))
    provider.seedFile({ relativePath: 'changed.txt', driveFileId: original.driveFileId, content: 'edited remotely' })

    const first = await engine.syncOnce()
    assert.equal(first.failed, 0)
    assert.equal((await provider.listManagedFiles(provider.rootFolderId)).length, 1)
    const preserved = (await provider.listManagedFiles(provider.rootFolderId))[0]
    assert.match(preserved.relativePath, /conflict from/)

    const second = await engine.syncOnce()
    assert.equal(second.actionsQueued, 0)
    assert.equal((await provider.listManagedFiles(provider.rootFolderId)).length, 1)
  })
})

test('retries a failed upload without creating duplicate remote files', async () => {
  const provider = drive('drive-a')
  provider.failNext('uploadFile', new Error('temporary network failure'))
  let now = Date.now() + 1000
  await withEngine({
    localFiles: { 'retry.txt': 'content' },
    providers: [provider],
    runnerOptions: { clock: () => now, random: () => 0, baseDelayMs: 10 },
  }, async ({ engine }) => {
    assert.equal((await engine.syncOnce()).retrying, 1)
    now += 100
    assert.equal((await engine.syncOnce()).completed, 1)
    assert.equal((await provider.listManagedFiles(provider.rootFolderId)).length, 1)
  })
})

test('routes a new file to the account with enough reserved capacity', async () => {
  const small = drive('small', { quotaBytes: 8 })
  const large = drive('large', { quotaBytes: 100 })
  await withEngine({ localFiles: { 'large.bin': '0123456789' }, providers: [small, large], settings: { storageReservePercent: 5 } }, async ({ engine, store }) => {
    await engine.syncOnce()
    assert.equal(store.getFile('large.bin').account_id, 'large')
    assert.equal((await small.listManagedFiles(small.rootFolderId)).length, 0)
    assert.equal((await large.listManagedFiles(large.rootFolderId)).length, 1)
  })
})

test('routes a new file to a manually selected default drive', async () => {
  const preferred = drive('preferred', { quotaBytes: 1000 })
  const larger = drive('larger', { quotaBytes: 10_000 })
  await withEngine({
    localFiles: { 'chosen.bin': '0123456789' },
    providers: [preferred, larger],
    settings: { storageReservePercent: 0, autoRoute: false, preferredAccountId: 'preferred' },
  }, async ({ engine, store }) => {
    await engine.syncOnce()
    assert.equal(store.getFile('chosen.bin').account_id, 'preferred')
    assert.equal((await larger.listManagedFiles(larger.rootFolderId)).length, 0)
  })
})

test('falls back to the most available drive when the default cannot fit', async () => {
  const preferred = drive('preferred', { quotaBytes: 4 })
  const larger = drive('larger', { quotaBytes: 10000 })
  await withEngine({
    localFiles: { 'large.bin': '0123456789' },
    providers: [preferred, larger],
    settings: { storageReservePercent: 0, autoRoute: false, preferredAccountId: 'preferred' },
  }, async ({ engine, store }) => {
    await engine.syncOnce()
    assert.equal(store.getFile('large.bin').account_id, 'larger')
  })
})

test('blocks silent sync-root changes until local state is reset', async () => {
  const provider = drive('drive-a')
  await withEngine({ localFiles: { 'keep.txt': 'content' }, providers: [provider] }, async ({ directory, engine, store }) => {
    await engine.syncOnce()
    const nextRoot = path.join(directory, 'new-root')
    await fs.promises.mkdir(nextRoot)
    engine.rootPath = nextRoot
    await assert.rejects(engine.syncOnce(), { code: 'SYNC_ROOT_CHANGED' })

    store.resetSyncState()
    await engine.syncOnce()
    assert.equal(await fs.promises.readFile(path.join(nextRoot, 'keep.txt'), 'utf8'), 'content')
  })
})

test('applyDedupe removes the non-keeper copy locally and on Drive, then tombstones it', async () => {
  const provider = drive('drive-a')
  await withEngine({
    localFiles: { 'keep/photo.png': 'identical bytes', 'dup/photo.png': 'identical bytes' },
    providers: [provider],
  }, async ({ rootPath, engine, store }) => {
    await engine.syncOnce()
    assert.equal((await provider.listManagedFiles(provider.rootFolderId)).length, 2)

    const result = await engine.applyDedupe([{ relativePath: 'dup/photo.png' }])
    assert.equal(result.removed.length, 1)
    assert.equal(result.errors.length, 0)

    // Local copy moved out of the sync root (to .trashed), keeper untouched.
    assert.equal(fs.existsSync(path.join(rootPath, 'dup', 'photo.png')), false)
    assert.equal(await fs.promises.readFile(path.join(rootPath, 'keep', 'photo.png'), 'utf8'), 'identical bytes')

    // Drive copy trashed, keeper still present.
    const managed = await provider.listManagedFiles(provider.rootFolderId)
    assert.equal(managed.length, 1)
    assert.equal(managed[0].relativePath, 'keep/photo.png')

    assert.equal(store.getFile('dup/photo.png').sync_state, 'tombstone')
    assert.equal(store.getFile('keep/photo.png').sync_state, 'active')
  })
})

test('applyDedupe does not resurrect removed copies on a later sync', async () => {
  const provider = drive('drive-a')
  await withEngine({
    localFiles: { 'keep/photo.png': 'identical bytes', 'dup/photo.png': 'identical bytes' },
    providers: [provider],
  }, async ({ rootPath, engine, store }) => {
    await engine.syncOnce()
    await engine.applyDedupe([{ relativePath: 'dup/photo.png' }])
    // Real trashLocal (shell.trashItem) sends the file to the Recycle Bin, so it leaves
    // the sync tree. The test fake renames to a sibling .trashed file; remove it to match.
    await fs.promises.rm(path.join(rootPath, 'dup', 'photo.png.trashed'), { force: true })

    await engine.syncOnce()

    assert.equal((await provider.listManagedFiles(provider.rootFolderId)).length, 1)
    assert.equal(fs.existsSync(path.join(rootPath, 'dup', 'photo.png')), false)
    assert.match(store.getFile('dup/photo.png').sync_state, /tombstone|forgotten/)
    assert.equal(await fs.promises.readFile(path.join(rootPath, 'keep', 'photo.png'), 'utf8'), 'identical bytes')
  })
})

test('applyDedupe reports an unknown copy and leaves it untouched', async () => {
  const provider = drive('drive-a')
  await withEngine({ localFiles: { 'keep.txt': 'content' }, providers: [provider] }, async ({ rootPath, engine }) => {
    await engine.syncOnce()
    const result = await engine.applyDedupe([{ relativePath: 'does-not-exist.txt' }])
    assert.equal(result.removed.length, 0)
    assert.equal(result.errors.length, 1)
    assert.equal(fs.existsSync(path.join(rootPath, 'keep.txt')), true)
    assert.equal((await provider.listManagedFiles(provider.rootFolderId)).length, 1)
  })
})

test('applyDedupe refuses to remove the last copy of a file', async () => {
  const provider = drive('drive-a')
  await withEngine({ localFiles: { 'only/photo.png': 'content' }, providers: [provider] }, async ({ rootPath, engine, store }) => {
    await engine.syncOnce()
    const result = await engine.applyDedupe([{ relativePath: 'only/photo.png' }])
    assert.equal(result.removed.length, 0)
    assert.equal(result.errors.length, 1)
    assert.equal(fs.existsSync(path.join(rootPath, 'only', 'photo.png')), true)
    assert.equal((await provider.listManagedFiles(provider.rootFolderId)).length, 1)
    assert.equal(store.getFile('only/photo.png').sync_state, 'active')
  })
})

test('applyDedupe refuses a batch that would remove every copy of a file', async () => {
  const provider = drive('drive-a')
  await withEngine({
    localFiles: { 'a/photo.png': 'identical bytes', 'b/photo.png': 'identical bytes' },
    providers: [provider],
  }, async ({ rootPath, engine }) => {
    await engine.syncOnce()
    const result = await engine.applyDedupe([
      { relativePath: 'a/photo.png' },
      { relativePath: 'b/photo.png' },
    ])
    assert.equal(result.removed.length, 0)
    assert.equal(result.errors.length, 2)
    assert.equal(fs.existsSync(path.join(rootPath, 'a', 'photo.png')), true)
    assert.equal(fs.existsSync(path.join(rootPath, 'b', 'photo.png')), true)
    assert.equal((await provider.listManagedFiles(provider.rootFolderId)).length, 2)
  })
})

test('removeFiles removes a unique photo (no identical copy) locally and on Drive, then tombstones it', async () => {
  const provider = drive('drive-a')
  await withEngine({
    localFiles: { 'photos/keep.jpg': 'frame one', 'photos/extra.jpg': 'frame two' },
    providers: [provider],
  }, async ({ rootPath, engine, store }) => {
    await engine.syncOnce()
    assert.equal((await provider.listManagedFiles(provider.rootFolderId)).length, 2)

    const result = await engine.removeFiles([{ relativePath: 'photos/extra.jpg' }])
    assert.equal(result.removed.length, 1)
    assert.equal(result.errors.length, 0)

    // Local copy moved out of the sync root (to .trashed), the similar keeper untouched.
    assert.equal(fs.existsSync(path.join(rootPath, 'photos', 'extra.jpg')), false)
    assert.equal(await fs.promises.readFile(path.join(rootPath, 'photos', 'keep.jpg'), 'utf8'), 'frame one')

    // Drive copy trashed, keeper still present, manifest row tombstoned.
    const managed = await provider.listManagedFiles(provider.rootFolderId)
    assert.equal(managed.length, 1)
    assert.equal(managed[0].relativePath, 'photos/keep.jpg')
    assert.equal(store.getFile('photos/extra.jpg').sync_state, 'tombstone')
    assert.equal(store.getFile('photos/keep.jpg').sync_state, 'active')
  })
})

test('removeFiles does not resurrect the removed photo on a later sync', async () => {
  const provider = drive('drive-a')
  await withEngine({
    localFiles: { 'photos/keep.jpg': 'frame one', 'photos/extra.jpg': 'frame two' },
    providers: [provider],
  }, async ({ rootPath, engine, store }) => {
    await engine.syncOnce()
    await engine.removeFiles([{ relativePath: 'photos/extra.jpg' }])
    // The test fake renames to a sibling .trashed file; real trash leaves the tree.
    await fs.promises.rm(path.join(rootPath, 'photos', 'extra.jpg.trashed'), { force: true })

    await engine.syncOnce()

    assert.equal((await provider.listManagedFiles(provider.rootFolderId)).length, 1)
    assert.equal(fs.existsSync(path.join(rootPath, 'photos', 'extra.jpg')), false)
    assert.match(store.getFile('photos/extra.jpg').sync_state, /tombstone|forgotten/)
    assert.equal(await fs.promises.readFile(path.join(rootPath, 'photos', 'keep.jpg'), 'utf8'), 'frame one')
  })
})

test('removeFiles removes a local-only photo that has not synced yet', async () => {
  const provider = drive('drive-a')
  await withEngine({ localFiles: { 'photos/solo.jpg': 'unique frame' }, providers: [provider] }, async ({ rootPath, engine }) => {
    const result = await engine.removeFiles([{ relativePath: 'photos/solo.jpg' }])
    assert.equal(result.removed.length, 1)
    assert.equal(result.errors.length, 0)
    assert.equal(fs.existsSync(path.join(rootPath, 'photos', 'solo.jpg')), false)
  })
})

test('incremental idle sync skips remote listing', async () => {
  const provider = drive('drive-a', { trackChanges: true })
  provider.seedFile({ relativePath: 'docs/from-drive.txt', content: 'remote content' })
  await withEngine({ providers: [provider] }, async ({ rootPath, engine }) => {
    await engine.syncOnce() // downloads and seeds the changes cursor
    assert.equal(provider.listCalls, 1)
    assert.equal(fs.existsSync(path.join(rootPath, 'docs', 'from-drive.txt')), true)

    // A second poll with no Drive activity must not re-list the remote tree.
    await engine.syncOnce()
    assert.equal(provider.listCalls, 1)
  })
})

test('incremental sync re-lists and downloads when a remote file is edited', async () => {
  const provider = drive('drive-a', { trackChanges: true })
  const seeded = provider.seedFile({ relativePath: 'note.txt', content: 'v1' })
  await withEngine({ providers: [provider] }, async ({ rootPath, engine }) => {
    await engine.syncOnce()
    assert.equal(await fs.promises.readFile(path.join(rootPath, 'note.txt'), 'utf8'), 'v1')
    assert.equal(provider.listCalls, 1)

    // An out-of-band Drive edit appears in the change feed and forces the
    // authoritative reconcile, which downloads the new content.
    provider.mutateRemote(seeded.driveFileId, { content: 'v2' })
    await engine.syncOnce()
    assert.ok(provider.listCalls >= 2)
    assert.equal(await fs.promises.readFile(path.join(rootPath, 'note.txt'), 'utf8'), 'v2')
  })
})

test('incremental idle sync propagates a local deletion without re-listing', async () => {
  const provider = drive('drive-a', { trackChanges: true })
  provider.seedFile({ relativePath: 'a.txt', content: 'content' })
  await withEngine({ providers: [provider] }, async ({ rootPath, engine, store }) => {
    await engine.syncOnce()
    await fs.promises.unlink(path.join(rootPath, 'a.txt'))

    await engine.syncOnce()
    assert.equal(provider.listCalls, 1) // still idle -> synthesized remote, no re-list
    assert.equal((await provider.listManagedFiles(provider.rootFolderId)).length, 0)
    assert.equal(store.getFile('a.txt').sync_state, 'tombstone')
  })
})

test('treats a local file move as a rename without re-uploading or trashing', async () => {
  const provider = drive('drive-a')
  await withEngine({ localFiles: { 'docs/notes.txt': 'content' }, providers: [provider] }, async ({ rootPath, engine, store }) => {
    await engine.syncOnce()
    const original = (await provider.listManagedFiles(provider.rootFolderId))[0]

    await fs.promises.mkdir(path.join(rootPath, 'archive'))
    await fs.promises.rename(path.join(rootPath, 'docs', 'notes.txt'), path.join(rootPath, 'archive', 'notes-moved.txt'))

    const result = await engine.syncOnce()

    assert.equal(result.completed, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.retrying, 0)

    // One Drive file remains, carrying the original Drive file id forward.
    const remote = await provider.listManagedFiles(provider.rootFolderId)
    assert.equal(remote.length, 1)
    assert.equal(remote[0].driveFileId, original.driveFileId)
    assert.equal(remote[0].relativePath, 'archive/notes-moved.txt')

    const moved = store.getFile('archive/notes-moved.txt')
    assert.equal(moved.drive_file_id, original.driveFileId)
    assert.equal(moved.sync_state, 'active')
    assert.match(store.getFile('docs/notes.txt')?.sync_state, /forgotten/)

    // Idempotent: a follow-up sync queues nothing new.
    assert.equal((await engine.syncOnce()).actionsQueued, 0)
  })
})

test('renames every file when a whole local folder is moved, preserving Drive ids', async () => {
  const provider = drive('drive-a')
  await withEngine({
    localFiles: { 'photos/a.txt': 'content-a', 'photos/b.txt': 'content-b' },
    providers: [provider],
  }, async ({ rootPath, engine, store }) => {
    await engine.syncOnce()
    const before = new Map((await provider.listManagedFiles(provider.rootFolderId)).map((file) => [file.relativePath, file.driveFileId]))

    await fs.promises.rename(path.join(rootPath, 'photos'), path.join(rootPath, 'album'))
    const result = await engine.syncOnce()

    assert.equal(result.failed, 0)
    assert.equal(store.getFile('album/a.txt').drive_file_id, before.get('photos/a.txt'))
    assert.equal(store.getFile('album/b.txt').drive_file_id, before.get('photos/b.txt'))
    assert.match(store.getFile('photos/a.txt')?.sync_state, /forgotten/)
    assert.match(store.getFile('photos/b.txt')?.sync_state, /forgotten/)
    assert.equal((await provider.listManagedFiles(provider.rootFolderId)).length, 2)
    assert.equal((await engine.syncOnce()).actionsQueued, 0)
  })
})

test('does not treat an ambiguous identical copy as a rename', async () => {
  const provider = drive('drive-a')
  await withEngine({ localFiles: { 'keep.txt': 'same' }, providers: [provider] }, async ({ rootPath, engine, store }) => {
    await engine.syncOnce()
    const original = (await provider.listManagedFiles(provider.rootFolderId))[0]

    // Copy keep.txt to two places and remove the original: the match is ambiguous,
    // so the deletion must propagate and both copies upload as new Drive files.
    await fs.promises.writeFile(path.join(rootPath, 'a.txt'), 'same')
    await fs.promises.writeFile(path.join(rootPath, 'b.txt'), 'same')
    await fs.promises.unlink(path.join(rootPath, 'keep.txt'))

    const result = await engine.syncOnce()
    assert.equal(result.failed, 0)

    const remote = await provider.listManagedFiles(provider.rootFolderId)
    assert.equal(remote.length, 2)
    const ids = new Set(remote.map((file) => file.driveFileId))
    assert.ok(!ids.has(original.driveFileId))
    assert.match(store.getFile('keep.txt')?.sync_state, /tombstone/)
  })
})

test('re-uploads when a file is moved and edited at the same time', async () => {
  const provider = drive('drive-a')
  await withEngine({ localFiles: { 'file.txt': 'v1' }, providers: [provider] }, async ({ rootPath, engine, store }) => {
    await engine.syncOnce()
    const original = (await provider.listManagedFiles(provider.rootFolderId))[0]

    await fs.promises.writeFile(path.join(rootPath, 'renamed.txt'), 'v2')
    await fs.promises.unlink(path.join(rootPath, 'file.txt'))

    await engine.syncOnce()

    // Content changed, so it is a new upload (new id); the old copy is trashed.
    const remote = await provider.listManagedFiles(provider.rootFolderId)
    assert.equal(remote.length, 1)
    assert.equal(remote[0].relativePath, 'renamed.txt')
    assert.notEqual(remote[0].driveFileId, original.driveFileId)
    assert.match(store.getFile('file.txt')?.sync_state, /tombstone/)
    assert.equal(await fs.promises.readFile(path.join(rootPath, 'renamed.txt'), 'utf8'), 'v2')
  })
})
