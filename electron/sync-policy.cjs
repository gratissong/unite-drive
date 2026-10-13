const conflictPolicies = new Set(['keep-both', 'prefer-local', 'prefer-remote'])
const deletionPolicies = new Set(['propagate-to-trash', 'keep-other-copy'])

function planSyncAction({
  baselineHash = null,
  localExists = true,
  localHash = null,
  remoteExists = true,
  remoteHash = null,
  conflictPolicy = 'keep-both',
  deletionPolicy = 'propagate-to-trash',
}) {
  if (!conflictPolicies.has(conflictPolicy)) throw new TypeError('Unknown conflict policy')
  if (!deletionPolicies.has(deletionPolicy)) throw new TypeError('Unknown deletion policy')

  if (!localExists && !remoteExists) return { type: 'forget' }
  if (!localExists) {
    if (!baselineHash) return { type: 'download' }
    if (remoteHash !== baselineHash) return { type: 'download-as-conflict-copy' }
    return deletionPolicy === 'propagate-to-trash'
      ? { type: 'trash-remote' }
      : { type: 'restore-local' }
  }
  if (!remoteExists) {
    if (!baselineHash) return { type: 'upload' }
    if (localHash !== baselineHash) return { type: 'upload-as-conflict-copy' }
    return deletionPolicy === 'propagate-to-trash'
      ? { type: 'trash-local' }
      : { type: 'restore-remote' }
  }
  if (!baselineHash) {
    if (localHash === remoteHash) return { type: 'in-sync', baselineHash: localHash }
    return resolveConflict(conflictPolicy)
  }

  const localChanged = localHash !== baselineHash
  const remoteChanged = remoteHash !== baselineHash
  if (!localChanged && !remoteChanged) return { type: 'unchanged' }
  if (localHash === remoteHash) return { type: 'in-sync', baselineHash: localHash }
  if (localChanged && remoteChanged) return resolveConflict(conflictPolicy)
  return localChanged ? { type: 'upload' } : { type: 'download' }
}

function resolveConflict(policy) {
  if (policy === 'prefer-local') return { type: 'upload', replaceRemote: true }
  if (policy === 'prefer-remote') return { type: 'download', replaceLocal: true }
  return { type: 'keep-both', preserveRemoteAsConflictCopy: true, uploadLocal: true }
}

module.exports = {
  conflictPolicies: [...conflictPolicies],
  deletionPolicies: [...deletionPolicies],
  planSyncAction,
}
