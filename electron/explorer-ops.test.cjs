const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createFolder, listDirectory, movePath, movePaths, searchLocalFolder, trashPath, trashPaths } = require('./explorer-ops.cjs')

async function withRoot(run) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unite-drive-explorer-'))
  try {
    await run(root)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

async function writeFile(root, relativePath, content = 'content') {
  const target = path.join(root, ...relativePath.split('/'))
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await fs.promises.writeFile(target, content)
}

async function rejectedCode(promise) {
  try {
    await promise
  } catch (error) {
    return error.code ?? error.constructor.name
  }
  throw new Error('Expected the operation to reject')
}

test('lists a directory with folders first, safe relative paths, and ignored entries removed', async () => {
  await withRoot(async (root) => {
    await fs.promises.mkdir(path.join(root, 'zeta'))
    await fs.promises.mkdir(path.join(root, 'alpha'))
    await writeFile(root, 'b.txt')
    await writeFile(root, 'A.txt')
    await writeFile(root, 'nested/inside.txt')
    await writeFile(root, '.unite-drive')
    await writeFile(root, 'desktop.ini')
    await writeFile(root, 'temp.part')

    const items = await listDirectory(root, '')
    const names = items.map((item) => item.name)
    assert.ok(!names.includes('.unite-drive'))
    assert.ok(!names.includes('desktop.ini'))
    assert.ok(!names.includes('temp.part'))

    const lastDirectory = items.map((item) => item.isDirectory).lastIndexOf(true)
    const firstFile = items.findIndex((item) => !item.isDirectory)
    assert.ok(lastDirectory < firstFile, 'directories should sort before files')

    const nested = await listDirectory(root, 'nested')
    assert.deepEqual(nested.map((item) => item.relativePath), ['nested/inside.txt'])
    assert.equal(nested[0].isDirectory, false)
    assert.equal(typeof nested[0].mtime, 'string')
  })
})

test('skips symlinked entries when listing', async (t) => {
  await withRoot(async (root) => {
    await writeFile(root, 'real.txt')
    try {
      await fs.promises.symlink(path.join(root, 'real.txt'), path.join(root, 'link.txt'))
    } catch {
      t.skip('symlink creation is not permitted on this system')
      return
    }
    const items = await listDirectory(root, '')
    assert.deepEqual(items.map((item) => item.name), ['real.txt'])
  })
})

test('refuses to list a path outside the sync root', async () => {
  await withRoot(async (root) => {
    assert.equal(await rejectedCode(listDirectory(root, '../escape')), 'TypeError')
  })
})

test('creates folders, rejecting collisions and unsafe names', async () => {
  await withRoot(async (root) => {
    const created = await createFolder(root, 'alpha')
    assert.equal(created.path, 'alpha')
    assert.equal((await fs.promises.lstat(path.join(root, 'alpha'))).isDirectory(), true)

    await fs.promises.mkdir(path.join(root, 'taken'))
    assert.equal(await rejectedCode(createFolder(root, 'taken')), 'DESTINATION_EXISTS')
    // The parent must already exist; a nested path with a missing parent is invalid.
    assert.equal(await rejectedCode(createFolder(root, 'missing/child')), 'INVALID_DESTINATION')
    assert.equal(await rejectedCode(createFolder(root, '../escape')), 'TypeError')
    assert.equal(await rejectedCode(createFolder(root, '')), 'TypeError')
  })
})

test('moves a file and reports the new relative path', async () => {
  await withRoot(async (root) => {
    await writeFile(root, 'note.txt', 'hello')
    await fs.promises.mkdir(path.join(root, 'docs'))

    const result = await movePath(root, 'note.txt', 'docs/note.txt')
    assert.deepEqual(result, { from: 'note.txt', to: 'docs/note.txt' })
    assert.equal(await fs.promises.readFile(path.join(root, 'docs', 'note.txt'), 'utf8'), 'hello')
    assert.equal(await rejectedCode(fs.promises.lstat(path.join(root, 'note.txt'))), 'ENOENT')
  })
})

test('moves a directory into another directory', async () => {
  await withRoot(async (root) => {
    await fs.promises.mkdir(path.join(root, 'source', 'inner'), { recursive: true })
    await writeFile(root, 'source/inner/file.txt')
    await fs.promises.mkdir(path.join(root, 'target'))

    const result = await movePath(root, 'source', 'target/source')
    assert.equal(result.to, 'target/source')
    assert.equal((await fs.promises.lstat(path.join(root, 'target', 'source', 'inner'))).isDirectory(), true)
  })
})

test('blocks moving a folder into itself or its own subtree', async () => {
  await withRoot(async (root) => {
    await fs.promises.mkdir(path.join(root, 'parent', 'child'), { recursive: true })
    assert.equal(await rejectedCode(movePath(root, 'parent', 'parent')), 'INVALID_MOVE')
    assert.equal(await rejectedCode(movePath(root, 'parent', 'parent/child/deeper')), 'INVALID_MOVE')
  })
})

test('refuses to overwrite an existing destination', async () => {
  await withRoot(async (root) => {
    await writeFile(root, 'a.txt', 'source')
    await writeFile(root, 'sub/a.txt', 'existing')
    assert.equal(await rejectedCode(movePath(root, 'a.txt', 'sub/a.txt')), 'DESTINATION_EXISTS')
    assert.equal(await fs.promises.readFile(path.join(root, 'sub', 'a.txt'), 'utf8'), 'existing')
  })
})

test('reports NOT_FOUND when the source is gone', async () => {
  await withRoot(async (root) => {
    await fs.promises.mkdir(path.join(root, 'sub'))
    assert.equal(await rejectedCode(movePath(root, 'ghost.txt', 'sub/ghost.txt')), 'NOT_FOUND')
  })
})

test('treats a repeated move as already completed once the destination exists', async () => {
  await withRoot(async (root) => {
    await writeFile(root, 'note.txt', 'hello')
    await fs.promises.mkdir(path.join(root, 'docs'))

    const first = await movePath(root, 'note.txt', 'docs/note.txt')
    assert.equal(first.alreadyMoved, undefined)

    // A second submit that races the dialog unmount must not surface NOT_FOUND.
    const second = await movePath(root, 'note.txt', 'docs/note.txt')
    assert.deepEqual(second, { from: 'note.txt', to: 'docs/note.txt', alreadyMoved: true })
  })
})

test('sends files and directories to trash through the provided handler', async () => {
  await withRoot(async (root) => {
    await writeFile(root, 'trash-me.txt')
    await fs.promises.mkdir(path.join(root, 'trash-folder', 'inner'), { recursive: true })
    const trashed = []
    const trashItem = async (target) => {
      trashed.push(path.basename(target))
      await fs.promises.rm(target, { recursive: true, force: true })
    }

    assert.deepEqual(await trashPath(root, 'trash-me.txt', trashItem), { trashed: 'trash-me.txt' })
    assert.deepEqual(await trashPath(root, 'trash-folder', trashItem), { trashed: 'trash-folder' })
    assert.deepEqual(trashed.sort(), ['trash-folder', 'trash-me.txt'])
    assert.equal(await rejectedCode(fs.promises.lstat(path.join(root, 'trash-folder'))), 'ENOENT')
  })
})

test('rejects trashing a missing path or one outside the sync root', async () => {
  await withRoot(async (root) => {
    const trashItem = async () => {}
    assert.equal(await rejectedCode(trashPath(root, 'missing.txt', trashItem)), 'NOT_FOUND')
    assert.equal(await rejectedCode(trashPath(root, '../escape', trashItem)), 'TypeError')
  })
})

test('searches the sync folder recursively by name', async () => {
  await withRoot(async (root) => {
    await writeFile(root, 'report-final.txt')
    await writeFile(root, 'docs/report-draft.txt')
    await writeFile(root, 'docs/notes.md')
    await fs.promises.mkdir(path.join(root, 'docs', 'reports'))
    await writeFile(root, '.unite-drive')

    const results = await searchLocalFolder(root, 'report')
    assert.deepEqual(results.map((entry) => entry.relativePath).sort(), ['docs/report-draft.txt', 'docs/reports', 'report-final.txt'].sort())

    const byPath = new Map(results.map((entry) => [entry.relativePath, entry]))
    assert.equal(byPath.get('report-final.txt').parentPath, '')
    assert.equal(byPath.get('report-final.txt').isDirectory, false)
    assert.equal(byPath.get('docs/report-draft.txt').parentPath, 'docs')
    assert.equal(byPath.get('docs/reports').parentPath, 'docs')
    assert.equal(byPath.get('docs/reports').isDirectory, true)
    assert.equal(byPath.get('docs/reports').size, null)
    // Ignored artefacts never surface in search results.
    assert.equal(results.some((entry) => entry.name === '.unite-drive'), false)
  })
})

test('search is case-insensitive, ignores blank queries, and honours the limit', async () => {
  await withRoot(async (root) => {
    await writeFile(root, 'Photo.PNG')
    await writeFile(root, 'photos/Photo-2.png')

    assert.deepEqual((await searchLocalFolder(root, 'photo')).map((entry) => entry.name).sort(), ['Photo.PNG', 'Photo-2.png', 'photos'].sort())
    assert.deepEqual(await searchLocalFolder(root, ''), [])
    assert.deepEqual(await searchLocalFolder(root, '   '), [])
    assert.equal((await searchLocalFolder(root, 'photo', { limit: 1 })).length, 1)
  })
})

test('moves several items in one batch and skips no-op moves', async () => {
  await withRoot(async (root) => {
    await writeFile(root, 'one.txt', '1')
    await writeFile(root, 'two.txt', '2')
    await fs.promises.mkdir(path.join(root, 'docs', 'nested'), { recursive: true })
    await fs.promises.mkdir(path.join(root, 'archive'))

    const result = await movePaths(root, [
      { from: 'one.txt', to: 'docs/one.txt' },
      { from: 'two.txt', to: 'archive/two.txt' },
      { from: 'docs', to: 'docs' },
    ])
    assert.deepEqual(result.moved, [
      { from: 'one.txt', to: 'docs/one.txt' },
      { from: 'two.txt', to: 'archive/two.txt' },
    ])
    assert.deepEqual(result.errors, [])
    assert.equal(await fs.promises.readFile(path.join(root, 'archive', 'two.txt'), 'utf8'), '2')
  })
})

test('batch move keeps going after a failure and reports each error', async () => {
  await withRoot(async (root) => {
    await writeFile(root, 'keeper.txt', 'keep')
    await writeFile(root, 'taken.txt', 'existing')
    await fs.promises.mkdir(path.join(root, 'dest'))
    await writeFile(root, 'dest/taken.txt', 'already here')

    const result = await movePaths(root, [
      { from: 'keeper.txt', to: 'dest/keeper.txt' },
      { from: 'ghost.txt', to: 'dest/ghost.txt' },
      { from: 'taken.txt', to: 'dest/taken.txt' },
    ])
    assert.deepEqual(result.moved, [{ from: 'keeper.txt', to: 'dest/keeper.txt' }])
    assert.deepEqual(result.errors.map((error) => [error.code, error.from]).sort(), [['DESTINATION_EXISTS', 'taken.txt'], ['NOT_FOUND', 'ghost.txt']].sort())
    assert.equal(await fs.promises.readFile(path.join(root, 'taken.txt'), 'utf8'), 'existing')
  })
})

test('batch move refuses two items landing on the same destination', async () => {
  await withRoot(async (root) => {
    await writeFile(root, 'a/note.txt', 'a')
    await writeFile(root, 'b/note.txt', 'b')
    await fs.promises.mkdir(path.join(root, 'dest'))

    const result = await movePaths(root, [
      { from: 'a/note.txt', to: 'dest/note.txt' },
      { from: 'b/note.txt', to: 'dest/note.txt' },
    ])
    assert.equal(result.moved.length, 1)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].code, 'DESTINATION_EXISTS')
  })
})

test('trashes several paths at once and reports the misses', async () => {
  await withRoot(async (root) => {
    await writeFile(root, 'a.txt')
    await writeFile(root, 'b.txt')
    const trashed = []
    const trashItem = async (target) => {
      trashed.push(path.basename(target))
      await fs.promises.rm(target, { force: true })
    }

    const result = await trashPaths(root, ['a.txt', 'missing.txt', 'b.txt'], trashItem)
    assert.deepEqual(result.trashed, ['a.txt', 'b.txt'])
    assert.deepEqual(result.errors.map((error) => error.code), ['NOT_FOUND'])
    assert.deepEqual(trashed.sort(), ['a.txt', 'b.txt'])
  })
})
