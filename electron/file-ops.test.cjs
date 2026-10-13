const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const { moveLocalFileToTrash, resolveSafePath, scanSyncRoot, snapshotFile, writeStreamAtomically, writeStreamIfAbsent } = require('./file-ops.cjs')

async function withRoot(run) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unite-drive-files-'))
  try {
    await run(root)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

test('atomically writes streamed content and returns a verified hash', async () => {
  await withRoot(async (root) => {
    const result = await writeStreamAtomically(root, 'nested/file.txt', Readable.from(['complete content']))
    assert.equal(await fs.promises.readFile(result.absolutePath, 'utf8'), 'complete content')
    assert.equal(result.hash, await snapshotFile(root, 'nested/file.txt').then((file) => file.hash))
    assert.deepEqual(await fs.promises.readdir(path.join(root, 'nested')), ['file.txt'])
  })
})

test('failed streams leave the existing destination untouched and remove temporary files', async () => {
  await withRoot(async (root) => {
    await fs.promises.writeFile(path.join(root, 'file.txt'), 'old version')
    async function* interruptedStream() {
      yield 'partial version'
      throw new Error('connection lost')
    }

    await assert.rejects(writeStreamAtomically(root, 'file.txt', Readable.from(interruptedStream())), /connection lost/)
    assert.equal(await fs.promises.readFile(path.join(root, 'file.txt'), 'utf8'), 'old version')
    assert.deepEqual(await fs.promises.readdir(root), ['file.txt'])
  })
})

test('imports only into unused local names and never overwrites existing content', async () => {
  await withRoot(async (root) => {
    await writeStreamIfAbsent(root, 'picked.txt', Readable.from(['first']))
    await assert.rejects(writeStreamIfAbsent(root, 'picked.txt', Readable.from(['second'])), { code: 'DESTINATION_EXISTS' })
    assert.equal(await fs.promises.readFile(path.join(root, 'picked.txt'), 'utf8'), 'first')
    assert.deepEqual((await fs.promises.readdir(root)).sort(), ['picked.txt'])
  })
})

test('scans nested files in stable order and ignores partial transfer artifacts', async () => {
  await withRoot(async (root) => {
    await fs.promises.mkdir(path.join(root, 'z-folder'))
    await fs.promises.writeFile(path.join(root, 'z-folder', 'item.txt'), 'item')
    await fs.promises.writeFile(path.join(root, 'pending.part'), 'partial')
    await fs.promises.writeFile(path.join(root, 'desktop.ini'), 'windows metadata')

    const files = await scanSyncRoot(root)
    assert.deepEqual(files.map((file) => file.relativePath), ['z-folder/item.txt'])
  })
})

test('rejects paths escaping the chosen root', () => {
  assert.throws(() => resolveSafePath('C:\\Sync', '../outside.txt'), /inside the sync root/)
  assert.throws(() => resolveSafePath('C:\\Sync', 'C:\\outside.txt'), /inside the sync root/)
})

test('delegates local deletions to the recoverable system trash', async () => {
  await withRoot(async (root) => {
    const filePath = path.join(root, 'remove.txt')
    await fs.promises.writeFile(filePath, 'recoverable')
    let trashedPath
    const moved = await moveLocalFileToTrash(root, 'remove.txt', async (target) => {
      trashedPath = target
      await fs.promises.rename(target, `${target}.trashed`)
    })
    assert.equal(moved, true)
    assert.equal(trashedPath, filePath)
    assert.equal(await fs.promises.readFile(`${filePath}.trashed`, 'utf8'), 'recoverable')
  })
})
