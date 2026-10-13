const path = require('node:path')
const { normalizeRelativePath } = require('./sync-store.cjs')

function planFirstSync({ localFiles, remoteFiles, managedRoots }) {
  if (!Array.isArray(localFiles) || !Array.isArray(remoteFiles)) throw new TypeError('Local and remote file lists are required')
  const localByPath = new Map()
  const remoteByPath = new Map()
  const usedPaths = new Set()

  for (const file of localFiles) {
    const relativePath = normalizeRelativePath(file.relativePath)
    if (localByPath.has(relativePath)) throw new Error(`Duplicate local path: ${relativePath}`)
    localByPath.set(relativePath, { ...file, relativePath })
    usedPaths.add(relativePath)
  }

  let ignoredRemoteCount = 0
  for (const file of remoteFiles) {
    const relativePath = normalizeRelativePath(file.relativePath)
    if (!file.accountId || !file.driveFileId || managedRoots[file.accountId] !== file.rootFolderId) {
      ignoredRemoteCount += 1
      continue
    }
    const normalized = { ...file, relativePath }
    const matches = remoteByPath.get(relativePath) ?? []
    matches.push(normalized)
    remoteByPath.set(relativePath, matches)
    usedPaths.add(relativePath)
  }

  const actions = []
  const allPaths = new Set([...localByPath.keys(), ...remoteByPath.keys()])
  for (const relativePath of [...allPaths].sort()) {
    const local = localByPath.get(relativePath)
    const remotes = (remoteByPath.get(relativePath) ?? []).sort((first, second) =>
      String(second.modifiedAt ?? '').localeCompare(String(first.modifiedAt ?? '')),
    )

    if (!local && remotes.length === 1) {
      actions.push({ type: 'download', relativePath, remote: remotes[0], baselineHash: remotes[0].hash ?? null })
      continue
    }

    if (!local && remotes.length > 1) {
      remotes.forEach((remote, index) => {
        const destinationPath = index === 0 ? relativePath : createConflictPath(relativePath, remote, usedPaths)
        if (destinationPath !== relativePath) {
          actions.push({ type: 'move-remote-to-conflict-path', fromRelativePath: relativePath, relativePath: destinationPath, remote })
        }
        actions.push({ type: 'download', relativePath: destinationPath, remote, baselineHash: remote.hash ?? null })
      })
      continue
    }

    if (!local) continue
    if (remotes.length === 0) {
      actions.push({ type: 'upload-local', relativePath, localHash: local.hash ?? null, size: local.size ?? 0 })
      continue
    }

    const matchingRemote = remotes.find((remote) => remote.hash && remote.hash === local.hash)
    if (matchingRemote) {
      actions.push({
        type: 'adopt',
        relativePath,
        accountId: matchingRemote.accountId,
        driveFileId: matchingRemote.driveFileId,
        baselineHash: matchingRemote.hash,
        size: local.size ?? matchingRemote.size ?? 0,
      })
      for (const remote of remotes) {
        if (remote === matchingRemote) continue
        const conflictPath = createConflictPath(relativePath, remote, usedPaths)
        actions.push({ type: 'move-remote-to-conflict-path', fromRelativePath: relativePath, relativePath: conflictPath, remote })
        actions.push({ type: 'download', relativePath: conflictPath, remote, baselineHash: remote.hash ?? null })
      }
      continue
    }

    for (const remote of remotes) {
      const conflictPath = createConflictPath(relativePath, remote, usedPaths)
      actions.push({ type: 'move-remote-to-conflict-path', fromRelativePath: relativePath, relativePath: conflictPath, remote })
      actions.push({ type: 'download', relativePath: conflictPath, remote, baselineHash: remote.hash ?? null })
    }
    actions.push({ type: 'upload-local', relativePath, localHash: local.hash ?? null, size: local.size ?? 0 })
  }

  return { actions, ignoredRemoteCount }
}

function createConflictPath(relativePath, remote, usedPaths) {
  const parsed = path.posix.parse(relativePath)
  const account = String(remote.accountId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 18) || 'drive'
  const timestamp = String(remote.modifiedAt ?? 'unknown').replace(/[^0-9]/g, '').slice(0, 14) || 'unknown'
  const stem = `${parsed.name} (conflict from ${account} ${timestamp})`
  let name = `${stem}${parsed.ext}`
  let suffix = 2
  let candidate = parsed.dir ? path.posix.join(parsed.dir, name) : name
  while (usedPaths.has(candidate)) {
    name = `${stem} ${suffix}${parsed.ext}`
    candidate = parsed.dir ? path.posix.join(parsed.dir, name) : name
    suffix += 1
  }
  usedPaths.add(candidate)
  return candidate
}

module.exports = { createConflictPath, planFirstSync }
