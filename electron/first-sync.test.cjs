const test = require('node:test')
const assert = require('node:assert/strict')
const { planFirstSync } = require('./first-sync.cjs')

const managedRoots = { 'drive-a': 'root-a' }
const remote = (overrides = {}) => ({
  relativePath: 'docs/plan.txt',
  accountId: 'drive-a',
  driveFileId: 'file-a',
  rootFolderId: 'root-a',
  hash: 'remote-hash',
  modifiedAt: '2026-10-10T12:00:00.000Z',
  ...overrides,
})

test('uploads local-only files into the managed root', () => {
  const result = planFirstSync({ localFiles: [{ relativePath: 'docs/local.txt', hash: 'local' }], remoteFiles: [], managedRoots })
  assert.deepEqual(result.actions, [{ type: 'upload-local', relativePath: 'docs/local.txt', localHash: 'local', size: 0 }])
})

test('downloads remote-only files without deleting anything', () => {
  const result = planFirstSync({ localFiles: [], remoteFiles: [remote()], managedRoots })
  assert.equal(result.actions[0].type, 'download')
  assert.equal(result.actions[0].relativePath, 'docs/plan.txt')
  assert.equal(result.actions.some((action) => action.type.startsWith('trash')), false)
})

test('adopts matching content without copying it again', () => {
  const result = planFirstSync({
    localFiles: [{ relativePath: 'docs/plan.txt', hash: 'same', size: 42 }],
    remoteFiles: [remote({ hash: 'same' })],
    managedRoots,
  })
  assert.deepEqual(result.actions, [{ type: 'adopt', relativePath: 'docs/plan.txt', accountId: 'drive-a', driveFileId: 'file-a', baselineHash: 'same', size: 42 }])
})

test('keeps divergent pre-existing copies and creates a conflict path', () => {
  const result = planFirstSync({
    localFiles: [{ relativePath: 'docs/plan.txt', hash: 'local-hash' }],
    remoteFiles: [remote()],
    managedRoots,
  })
  assert.equal(result.actions[0].type, 'move-remote-to-conflict-path')
  assert.match(result.actions[0].relativePath, /conflict from drive-a/)
  assert.equal(result.actions[1].type, 'download')
  assert.deepEqual(result.actions[2], { type: 'upload-local', relativePath: 'docs/plan.txt', localHash: 'local-hash', size: 0 })
})

test('ignores files outside each app-managed account root', () => {
  const result = planFirstSync({ localFiles: [], remoteFiles: [remote({ rootFolderId: 'user-root' })], managedRoots })
  assert.deepEqual(result.actions, [])
  assert.equal(result.ignoredRemoteCount, 1)
})

test('preserves duplicate remote paths under unique conflict names', () => {
  const result = planFirstSync({
    localFiles: [],
    remoteFiles: [remote(), remote({ accountId: 'drive-b', rootFolderId: 'root-b', driveFileId: 'file-b' })],
    managedRoots: { ...managedRoots, 'drive-b': 'root-b' },
  })
  const downloads = result.actions.filter((action) => action.type === 'download')
  assert.equal(downloads.length, 2)
  assert.notEqual(downloads[0].relativePath, downloads[1].relativePath)
})
