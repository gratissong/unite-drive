const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const { FakeDriveProvider } = require('./fake-drive-provider.cjs')

function provider(options = {}) {
  return new FakeDriveProvider({ accountId: 'drive-a', email: 'a@example.com', quotaBytes: 8, ...options })
}

async function upload(drive, content, idempotencyKey = 'operation-1') {
  const root = await drive.ensureManagedRoot()
  const data = Buffer.from(content)
  return drive.uploadFile({
    rootFolderId: root.rootFolderId,
    relativePath: 'notes.txt',
    readable: Readable.from([data]),
    size: data.length,
    idempotencyKey,
  })
}

test('uploads idempotently and downloads the exact content', async () => {
  const drive = provider()
  const first = await upload(drive, 'hello')
  const second = await upload(drive, 'hello')
  const download = await drive.downloadFile(first.driveFileId)
  const chunks = []
  for await (const chunk of download.readable) chunks.push(chunk)

  assert.equal(first.driveFileId, second.driveFileId)
  assert.equal(Buffer.concat(chunks).toString(), 'hello')
  assert.equal((await drive.listManagedFiles()).length, 1)
})

test('enforces account quota and retains quota usage for trashed files', async () => {
  const drive = provider()
  const file = await upload(drive, '12345678')
  await drive.trashFile(file.driveFileId)
  assert.equal((await drive.listManagedFiles()).length, 0)
  assert.equal((await drive.getQuota()).usageBytes, 8)
  await assert.rejects(upload(drive, 'x', 'operation-2'), { code: 'INSUFFICIENT_STORAGE' })
  await drive.restoreFile(file.driveFileId)
  assert.equal((await drive.listManagedFiles()).length, 1)
})

test('injects a transient provider failure without mutating remote content', async () => {
  const drive = provider()
  const file = await upload(drive, 'original')
  drive.failNext('downloadFile', new Error('temporary network error'))
  await assert.rejects(drive.downloadFile(file.driveFileId), /temporary network error/)
  const download = await drive.downloadFile(file.driveFileId)
  const chunks = []
  for await (const chunk of download.readable) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).toString(), 'original')
})
