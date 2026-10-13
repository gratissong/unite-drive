const fs = require('node:fs')
const path = require('node:path')
const { assertNoSymlinkPath, ignoredNames, moveLocalPathToTrash, resolveSafePath } = require('./file-ops.cjs')

// Filesystem operations backing the local file explorer. Kept separate from
// main.cjs so the path-safety, collision, and move rules can be unit tested.

function isIgnoredEntry(name) {
  return ignoredNames.has(name.toLowerCase()) || name.startsWith('~$') || name.endsWith('.part') || name.endsWith('.tmp')
}

function resolveDirectory(rootPath, relativePath) {
  const normalized = typeof relativePath === 'string' && relativePath ? relativePath : ''
  return normalized
    ? resolveSafePath(rootPath, normalized)
    : { root: path.resolve(rootPath), target: path.resolve(rootPath), relativePath: '' }
}

async function listDirectory(rootPath, relativePath = '') {
  const resolved = resolveDirectory(rootPath, relativePath)
  let dirents
  try {
    dirents = await fs.promises.readdir(resolved.target, { withFileTypes: true })
  } catch (error) {
    const wrapped = new Error(`Could not read that folder: ${error.message}`)
    wrapped.code = error.code ?? 'READ_FAILED'
    throw wrapped
  }
  const items = []
  for (const entry of dirents) {
    if (isIgnoredEntry(entry.name) || entry.isSymbolicLink()) continue
    const fullPath = path.join(resolved.target, entry.name)
    let stats
    try {
      stats = await fs.promises.lstat(fullPath)
    } catch {
      continue
    }
    const isDirectory = entry.isDirectory()
    items.push({
      name: entry.name,
      isDirectory,
      size: isDirectory ? null : (stats.size ?? 0),
      mtime: stats.mtime ? stats.mtime.toISOString() : null,
      relativePath: path.relative(resolved.root, fullPath).replaceAll('\\', '/'),
    })
  }
  items.sort((first, second) => (first.isDirectory === second.isDirectory ? first.name.localeCompare(second.name) : first.isDirectory ? -1 : 1))
  return items
}

async function pathExists(target) {
  try {
    await fs.promises.lstat(target)
    return true
  } catch {
    return false
  }
}

async function createFolder(rootPath, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) throw new TypeError('A folder path is required')
  const resolved = resolveSafePath(rootPath, relativePath)
  await assertNoSymlinkPath(rootPath, resolved.relativePath)
  try {
    await fs.promises.mkdir(resolved.target, { recursive: false })
  } catch (error) {
    if (error.code === 'EEXIST') {
      const conflict = new Error('A file or folder with that name already exists')
      conflict.code = 'DESTINATION_EXISTS'
      throw conflict
    }
    if (error.code === 'ENOENT') {
      const missing = new Error('That location is missing or outside the sync folder')
      missing.code = 'INVALID_DESTINATION'
      throw missing
    }
    throw error
  }
  return { path: resolved.relativePath }
}

async function movePath(rootPath, from, to) {
  if (typeof from !== 'string' || !from) throw new TypeError('A source path is required')
  if (typeof to !== 'string' || !to) throw new TypeError('A destination path is required')
  const source = resolveSafePath(rootPath, from)
  const destination = resolveSafePath(rootPath, to)
  await assertNoSymlinkPath(rootPath, from)
  await assertNoSymlinkPath(rootPath, to, false)

  let sourceStats = null
  try {
    sourceStats = await fs.promises.lstat(source.target)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  if (!sourceStats) {
    // A duplicate submit (for example a double-click that races the dialog
    // unmount) can arrive after the first move already relocated the item. If
    // the destination now exists, treat it as the move having succeeded.
    if (await pathExists(destination.target)) {
      return { from: source.relativePath, to: destination.relativePath, alreadyMoved: true }
    }
    const error = new TypeError('The source file or folder does not exist')
    error.code = 'NOT_FOUND'
    throw error
  }

  if (sourceStats.isDirectory()) {
    const inside = path.relative(source.target, destination.target)
    if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))) {
      const error = new Error('Cannot move a folder into itself or one of its subfolders')
      error.code = 'INVALID_MOVE'
      throw error
    }
  }

  if (await pathExists(destination.target)) {
    const error = new Error('A file or folder with that name already exists at the destination')
    error.code = 'DESTINATION_EXISTS'
    throw error
  }

  await fs.promises.rename(source.target, destination.target)
  return { from: source.relativePath, to: destination.relativePath }
}

async function trashPath(rootPath, relativePath, trashItem) {
  if (typeof relativePath !== 'string' || !relativePath) throw new TypeError('A path to remove is required')
  if (!(await pathExists(resolveSafePath(rootPath, relativePath).target))) {
    const error = new Error('The file or folder no longer exists')
    error.code = 'NOT_FOUND'
    throw error
  }
  await moveLocalPathToTrash(rootPath, relativePath, trashItem)
  return { trashed: relativePath }
}

// Move several items in one pass (drag-and-drop / multi-select). Per-item
// failures are collected so one bad entry cannot abort the whole batch.
async function movePaths(rootPath, moves) {
  if (!Array.isArray(moves) || moves.length === 0) throw new TypeError('At least one move is required')
  const moved = []
  const errors = []
  const destinations = new Set()
  for (const move of moves) {
    const from = typeof move?.from === 'string' ? move.from : ''
    const to = typeof move?.to === 'string' ? move.to : ''
    if (!from || !to) {
      errors.push({ from, to, message: 'A source and destination path are required', code: 'INVALID_MOVE' })
      continue
    }
    if (from === to) continue
    if (destinations.has(to)) {
      errors.push({ from, to, message: 'Two selected items would land on the same name', code: 'DESTINATION_EXISTS' })
      continue
    }
    destinations.add(to)
    try {
      moved.push(await movePath(rootPath, from, to))
    } catch (error) {
      errors.push({ from, to, message: error.message, code: error.code })
    }
  }
  return { moved, errors }
}

async function trashPaths(rootPath, paths, trashItem) {
  if (!Array.isArray(paths) || paths.length === 0) throw new TypeError('At least one path is required')
  if (typeof trashItem !== 'function') throw new TypeError('A system trash handler is required')
  const trashed = []
  const errors = []
  for (const relativePath of paths) {
    try {
      await trashPath(rootPath, relativePath, trashItem)
      trashed.push(relativePath)
    } catch (error) {
      errors.push({ path: relativePath, message: error.message, code: error.code })
    }
  }
  return { trashed, errors }
}

// Breadth-first walk of the sync folder by name. Skips ignored artefacts and
// symlinks (never followed), and stops at `limit` matches or `maxEntries`
// scanned to keep a huge tree from stalling the main process.
async function searchLocalFolder(rootPath, query, options = {}) {
  const limit = options.limit ?? 50
  const maxEntries = options.maxEntries ?? 20000
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!needle) return []

  const root = path.resolve(rootPath)
  const results = []
  const queue = ['']
  let scanned = 0

  while (queue.length && results.length < limit && scanned < maxEntries) {
    const relativeDir = queue.shift()
    const dirPath = relativeDir ? path.join(root, ...relativeDir.split('/')) : root
    let dirents
    try {
      dirents = await fs.promises.readdir(dirPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of dirents) {
      if (results.length >= limit || scanned >= maxEntries) break
      if (isIgnoredEntry(entry.name) || entry.isSymbolicLink()) continue
      scanned += 1
      const childRelative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      const isDirectory = entry.isDirectory()
      if (isDirectory) queue.push(childRelative)
      if (!entry.name.toLowerCase().includes(needle)) continue
      const fullPath = path.join(root, ...childRelative.split('/'))
      let stats
      try {
        stats = await fs.promises.lstat(fullPath)
      } catch {
        continue
      }
      const separator = childRelative.lastIndexOf('/')
      results.push({
        name: entry.name,
        isDirectory,
        size: isDirectory ? null : (stats.size ?? 0),
        mtime: stats.mtime ? stats.mtime.toISOString() : null,
        relativePath: childRelative,
        parentPath: separator === -1 ? '' : childRelative.slice(0, separator),
      })
    }
  }

  results.sort((first, second) => first.relativePath.localeCompare(second.relativePath))
  return results
}

module.exports = { createFolder, listDirectory, movePath, movePaths, searchLocalFolder, trashPath, trashPaths }
