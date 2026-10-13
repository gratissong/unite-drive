const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { randomUUID } = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const { createWriteStream } = require('node:fs')
const { normalizeRelativePath } = require('./sync-store.cjs')

const ignoredNames = new Set(['.unite-drive', 'desktop.ini', 'thumbs.db', '.ds_store'])

function resolveSafePath(rootPath, relativePath) {
  const root = path.resolve(rootPath)
  const normalized = normalizeRelativePath(relativePath)
  const target = path.resolve(root, ...normalized.split('/'))
  const relative = path.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError('Operation must target a file inside the sync root')
  }
  return { root, target, relativePath: normalized }
}

async function assertNoSymlinkPath(root, relativePath, includeTarget = true) {
  let currentPath = root
  const segments = relativePath.split('/')
  const count = includeTarget ? segments.length : segments.length - 1
  for (const segment of segments.slice(0, count)) {
    currentPath = path.join(currentPath, segment)
    try {
      if ((await fs.promises.lstat(currentPath)).isSymbolicLink()) {
        throw new TypeError('Sync operations do not follow symbolic links')
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const input = fs.createReadStream(filePath)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

async function snapshotFile(rootPath, relativePath) {
  const { root, target, relativePath: normalized } = resolveSafePath(rootPath, relativePath)
  await assertNoSymlinkPath(root, normalized)
  const before = await fs.promises.stat(target)
  if (!before.isFile()) throw new TypeError('Only regular files can be synchronized')
  const hash = await hashFile(target)
  const after = await fs.promises.stat(target)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    const error = new Error(`File changed while hashing: ${normalized}`)
    error.code = 'FILE_CHANGED_DURING_READ'
    throw error
  }
  return { relativePath: normalized, absolutePath: target, size: after.size, modifiedAt: after.mtime.toISOString(), hash }
}

async function scanSyncRoot(rootPath) {
  const root = await fs.promises.realpath(rootPath)
  const results = []

  async function visit(directoryPath, relativeDirectory) {
    const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true })
    entries.sort((first, second) => first.name.localeCompare(second.name))
    for (const entry of entries) {
      if (ignoredNames.has(entry.name.toLowerCase()) || entry.name.endsWith('.part') || entry.name.endsWith('.tmp') || entry.name.startsWith('~$')) continue
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const absolutePath = path.join(directoryPath, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath)
      } else if (entry.isFile()) {
        try {
          results.push(await snapshotFile(root, relativePath))
        } catch (error) {
          if (error.code !== 'FILE_CHANGED_DURING_READ') throw error
        }
      }
    }
  }

  await visit(root, '')
  return results
}

async function writeStreamAtomically(rootPath, relativePath, readable) {
  const { root, target, relativePath: normalized } = resolveSafePath(rootPath, relativePath)
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await assertNoSymlinkPath(root, normalized)
  const temporaryPath = path.join(path.dirname(target), `.unite-${randomUUID()}.part`)

  try {
    await pipeline(readable, createWriteStream(temporaryPath, { flags: 'wx' }))
    const fileHandle = await fs.promises.open(temporaryPath, 'r+')
    try {
      await fileHandle.sync()
    } finally {
      await fileHandle.close()
    }
    await assertNoSymlinkPath(root, normalized)
    await fs.promises.rename(temporaryPath, target)
    return snapshotFile(root, normalized)
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

async function writeStreamIfAbsent(rootPath, relativePath, readable) {
  const { root, target, relativePath: normalized } = resolveSafePath(rootPath, relativePath)
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await assertNoSymlinkPath(root, normalized)
  const temporaryPath = path.join(path.dirname(target), `.unite-${randomUUID()}.part`)

  try {
    await pipeline(readable, createWriteStream(temporaryPath, { flags: 'wx' }))
    const fileHandle = await fs.promises.open(temporaryPath, 'r+')
    try {
      await fileHandle.sync()
    } finally {
      await fileHandle.close()
    }
    await assertNoSymlinkPath(root, normalized)
    await fs.promises.link(temporaryPath, target)
    await fs.promises.unlink(temporaryPath)
    return snapshotFile(root, normalized)
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {})
    if (error.code === 'EEXIST') error.code = 'DESTINATION_EXISTS'
    throw error
  }
}

async function moveLocalFileToTrash(rootPath, relativePath, trashItem) {
  if (typeof trashItem !== 'function') throw new TypeError('A system trash handler is required')
  const { root, target, relativePath: normalized } = resolveSafePath(rootPath, relativePath)
  await assertNoSymlinkPath(root, normalized)
  const stats = await fs.promises.lstat(target)
  if (!stats.isFile()) throw new TypeError('Only regular files can be moved to trash')
  await trashItem(target)
  return true
}

module.exports = { hashFile, moveLocalFileToTrash, resolveSafePath, scanSyncRoot, snapshotFile, writeStreamAtomically, writeStreamIfAbsent }
