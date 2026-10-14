const fs = require('node:fs')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { planFirstSync, createConflictPath } = require('./first-sync.cjs')
const { planSyncAction } = require('./sync-policy.cjs')
const { planRebalance } = require('./rebalance.cjs')
const { SyncRunner } = require('./sync-runner.cjs')
const { hashFileMd5, moveLocalFileToTrash, scanSyncRoot, snapshotFile, writeStreamAtomically } = require('./file-ops.cjs')

function manifestToRecord(manifest) {
  return {
    relativePath: manifest.relative_path,
    accountId: manifest.account_id,
    driveFileId: manifest.drive_file_id,
    baselineHash: manifest.baseline_hash,
    sizeBytes: manifest.size_bytes,
    localModifiedAt: manifest.local_modified_at,
    remoteModifiedAt: manifest.remote_modified_at,
    syncState: manifest.sync_state,
    deletedAt: manifest.deleted_at,
  }
}

class SyncEngine {
  constructor({ rootPath, store, providers, settings, trashLocal, runnerOptions }) {
    this.rootPath = rootPath
    this.store = store
    this.providers = providers
    this.settings = settings
    this.trashLocal = trashLocal ?? require('electron').shell.trashItem
    this.runnerOptions = runnerOptions
  }

  async syncOnce({ retryFailed = false } = {}) {
    if (!this.rootPath) throw new Error('A local sync folder has not been selected')
    if (this.providers.length === 0) {
      const error = new Error('Connect at least one Google Drive account before syncing')
      error.code = 'NO_DRIVE_ACCOUNTS'
      throw error
    }
    const rootPath = await fs.promises.realpath(this.rootPath)
    const previousRoot = this.store.getMetadata('activeSyncRoot')
    if (previousRoot && previousRoot !== rootPath) {
      const error = new Error('The selected sync folder changed. Reset sync state before using a different folder; remote files will be preserved.')
      error.code = 'SYNC_ROOT_CHANGED'
      throw error
    }
    if (!previousRoot) this.store.setMetadata('activeSyncRoot', rootPath)
    if (retryFailed) this.store.requeueFailedOperations()
    const roots = await this.#prepareProviders()
    if (!this.store.getMetadata('firstSyncComplete')) {
      await this.#queueInitialSync(rootPath, roots)
    } else {
      await this.#queueIncrementalSync(rootPath, roots)
    }

    const runner = new SyncRunner(this.store, this.#createHandlers(rootPath), this.runnerOptions)
    const results = []
    let result = await runner.runNext()
    while (result) {
      results.push(result)
      result = await runner.runNext()
    }
    const remainingOperations = this.store.listOperations().filter((operation) => ['queued', 'retry', 'running', 'failed'].includes(operation.state))
    if (!this.store.getMetadata('firstSyncComplete') && remainingOperations.length === 0) {
      this.store.setMetadata('firstSyncComplete', true)
      await this.#recordStartTokens()
    }
    this.store.pruneOperations()
    return {
      actionsQueued: results.length,
      completed: results.filter((item) => item.state === 'completed').length,
      retrying: results.filter((item) => item.state === 'retry').length,
      failed: results.filter((item) => item.state === 'failed').length,
      firstSyncComplete: Boolean(this.store.getMetadata('firstSyncComplete')),
      files: this.store.listFiles(),
      operations: this.store.listOperations(),
    }
  }

  // Remove specific duplicate copies (the non-keeper entries of a dedupe group).
  // Each copy is moved to the OS trash and its Drive copy to Drive trash, then the
  // manifest row is tombstoned so a later scan does not re-import it.
  async applyDedupe(removals) {
    return this.#removeCopies(removals, { requireDuplicate: true })
  }

  // Remove specific files the user explicitly chose (for example one photo out of a
  // similar-photo group). These are not byte-for-byte copies, so — unlike dedupe —
  // no identical sibling must remain. The local copy and its Drive copy are both
  // moved to trash (recoverable) and the manifest row is tombstoned; local-only
  // files that have not synced yet are handled too.
  async removeFiles(removals) {
    return this.#removeCopies(removals, { requireDuplicate: false })
  }

  // Rebalance the connected drives on request: decide which already-synced files
  // should move to a different account so every drive ends up at roughly the same
  // fill level, and (unless this is a preview) queue those moves. The planner is
  // pure, so a preview and the applied run agree exactly. Moves are ordinary runner
  // operations, so they appear in the transfer queue, retry on failure, and can be
  // cancelled before they start.
  async rebalance({ apply = false, maxBytes = null, maxMoves = null, thresholdPercent = undefined } = {}) {
    if (!this.rootPath) throw new Error('A local sync folder has not been selected')
    if (this.providers.length === 0) {
      const error = new Error('Connect at least one Google Drive account before rebalancing')
      error.code = 'NO_DRIVE_ACCOUNTS'
      throw error
    }
    const accounts = []
    for (const provider of this.providers) {
      const quota = await provider.getQuota()
      accounts.push({
        id: provider.accountId,
        email: provider.email,
        limitBytes: quota.limitBytes == null ? null : Number(quota.limitBytes),
        usageBytes: Number(quota.usageBytes ?? 0),
      })
    }
    const files = this.store.listFiles()
    const plan = planRebalance({
      accounts,
      files,
      reservePercent: this.settings.storageReservePercent,
      options: {
        thresholdPercent,
        maxBytes: maxBytes ?? undefined,
        maxMoves: maxMoves ?? undefined,
      },
    })
    if (!apply || plan.moves.length === 0) {
      return { applied: false, queued: 0, ...plan }
    }
    const manifestByPath = new Map(files.map((file) => [file.relative_path, file]))
    let queued = 0
    for (const move of plan.moves) {
      const manifest = manifestByPath.get(move.relativePath)
      if (!manifest?.account_id || !manifest?.drive_file_id) continue
      this.#enqueue('move-remote', move.relativePath, manifest.account_id, manifest.drive_file_id, {
        targetAccountId: move.toAccountId,
        expectedHash: manifest.baseline_hash ?? null,
        sizeBytes: move.sizeBytes,
      })
      queued += 1
    }
    return { applied: true, queued, ...plan }
  }

  async #removeCopies(removals, { requireDuplicate }) {
    if (!Array.isArray(removals) || removals.length === 0) return { removed: [], errors: [] }
    const removed = []
    const errors = []
    const requestedPaths = new Set(removals.filter((item) => typeof item?.relativePath === 'string').map((item) => item.relativePath))
    const liveFiles = this.store.listFiles().filter((file) => file.sync_state !== 'tombstone' && file.sync_state !== 'forgotten')
    for (const removal of removals) {
      const relativePath = removal?.relativePath
      if (typeof relativePath !== 'string' || !relativePath) {
        errors.push({ relativePath, message: 'A file path is required' })
        continue
      }
      const manifest = this.store.getFile(relativePath)
      const isGone = !manifest || manifest.sync_state === 'tombstone' || manifest.sync_state === 'forgotten'
      if (requireDuplicate) {
        if (isGone) {
          errors.push({ relativePath, message: 'This copy is no longer part of the sync plan' })
          continue
        }
        // Only actual duplicates are removable: another fully-synced copy with the
        // same content hash must remain after this batch, so a bug or compromised
        // renderer can never trash the last (or only) copy through this channel.
        const remainingDuplicates = manifest.baseline_hash
          ? liveFiles.filter((file) =>
              file.baseline_hash === manifest.baseline_hash &&
              file.relative_path !== relativePath &&
              !requestedPaths.has(file.relative_path) &&
              Boolean(file.account_id && file.drive_file_id),
            )
          : []
        if (remainingDuplicates.length === 0) {
          errors.push({ relativePath, message: 'Removing this file would delete its last copy, so it cannot be removed' })
          continue
        }
      }
      // A file that has never synced has no manifest row and no Drive copy to trash.
      const tracked = isGone ? null : manifest
      if (tracked?.drive_file_id && tracked.account_id) {
        let provider
        try {
          provider = this.#provider(tracked.account_id)
        } catch (error) {
          errors.push({ relativePath, message: error.message })
          continue
        }
        try {
          await provider.trashFile(tracked.drive_file_id)
        } catch (error) {
          errors.push({ relativePath, message: `Could not move the Google Drive copy to trash: ${error.message}` })
          continue
        }
      }
      try {
        await moveLocalFileToTrash(this.rootPath, relativePath, this.trashLocal)
      } catch (error) {
        if (error.code !== 'ENOENT') {
          errors.push({ relativePath, message: `Could not move the local copy to trash: ${error.message}` })
          continue
        }
      }
      if (tracked) {
        this.store.upsertFile({
          relativePath,
          accountId: tracked.account_id,
          driveFileId: tracked.drive_file_id,
          syncState: 'tombstone',
          deletedAt: new Date().toISOString(),
        })
      }
      removed.push(relativePath)
    }
    return { removed, errors }
  }

  async #prepareProviders() {
    const roots = {}
    for (const provider of this.providers) {
      const root = await provider.ensureManagedRoot()
      const quota = await provider.getQuota()
      roots[provider.accountId] = root.rootFolderId
      this.store.upsertAccount({
        id: provider.accountId,
        email: provider.email,
        rootFolderId: root.rootFolderId,
        quotaBytes: quota.limitBytes,
      })
    }
    return roots
  }

  async #queueInitialSync(rootPath, roots) {
    const localFiles = await scanSyncRoot(rootPath)
    const remoteFiles = []
    for (const provider of this.providers) {
      const files = await provider.listManagedFiles(roots[provider.accountId])
      remoteFiles.push(...files)
    }
    const plan = planFirstSync({ localFiles, remoteFiles, managedRoots: roots })
    for (const action of plan.actions) await this.#queuePlanAction(action)
  }

  // Find local moves/renames before reconcile: a vanished manifest whose last
  // synced content hash matches a newly-appeared untracked file is a rename, not
  // a deletion plus re-upload. Only unambiguous 1:1 matches by content are treated
  // as renames; anything ambiguous or edited falls back to the normal plan.
  #detectLocalRenames(manifests, localByPath) {
    const oldByHash = new Map()
    for (const manifest of manifests) {
      if (manifest.sync_state !== 'active' || !manifest.drive_file_id || !manifest.baseline_hash) continue
      if (localByPath.has(manifest.relative_path)) continue
      if (!oldByHash.has(manifest.baseline_hash)) oldByHash.set(manifest.baseline_hash, [])
      oldByHash.get(manifest.baseline_hash).push(manifest.relative_path)
    }
    const newByHash = new Map()
    for (const [relativePath, local] of localByPath) {
      if (manifests.some((manifest) => manifest.relative_path === relativePath)) continue
      if (!local.hash) continue
      if (!newByHash.has(local.hash)) newByHash.set(local.hash, [])
      newByHash.get(local.hash).push(relativePath)
    }
    const renames = new Map()
    for (const [hash, oldPaths] of oldByHash) {
      const newPaths = newByHash.get(hash)
      if (oldPaths.length === 1 && newPaths && newPaths.length === 1) renames.set(oldPaths[0], newPaths[0])
    }
    return renames
  }

  async #queueIncrementalSync(rootPath, roots) {
    const manifests = this.store.listFiles().filter((file) => file.sync_state !== 'forgotten')
    const manifestByPath = new Map(manifests.map((file) => [file.relative_path, file]))
    const manifestByDriveId = new Set(manifests.map((file) => file.drive_file_id).filter(Boolean))
    const localFiles = await scanSyncRoot(rootPath)
    const localByPath = new Map(localFiles.map((file) => [file.relativePath, file]))
    const renames = this.#detectLocalRenames(manifests, localByPath)
    const claimedNew = new Set(renames.values())

    // A file with a pending rebalance move must not also be planned as a normal
    // upload/download/trash; the move owns it until it finishes (or is cancelled).
    const pendingMovePaths = new Set()
    for (const operation of this.store.listOperations()) {
      if (operation.kind === 'move-remote' && ['queued', 'running', 'retry', 'failed'].includes(operation.state)) {
        pendingMovePaths.add(operation.relative_path)
      }
    }

    const changesSupported = this.providers.length > 0 && this.providers.every((provider) => this.#supportsChanges(provider))
    const consumed = changesSupported ? await this.#consumeChanges() : null
    const anyPending = Boolean(consumed && consumed.count > 0)

    const remoteFiles = []
    const remoteByDriveId = new Map()
    if (anyPending || !changesSupported) {
      // Authoritative reconcile against the live remote tree. Also the safe
      // fallback whenever a provider does not expose the changes API.
      for (const provider of this.providers) {
        const files = await provider.listManagedFiles(roots[provider.accountId])
        for (const file of files) {
          remoteFiles.push(file)
          remoteByDriveId.set(file.driveFileId, file)
        }
      }
    } else {
      // No drive activity since our cursor: the remote state is exactly what we
      // last reconciled (recorded in the manifest rows), so re-listing is not
      // needed. Untracked remote files cannot have appeared without a change.
      for (const manifest of manifests) {
        if (!manifest.drive_file_id) continue
        const remote = this.#synthesizeRemote(manifest, roots[manifest.account_id])
        remoteFiles.push(remote)
        remoteByDriveId.set(manifest.drive_file_id, remote)
      }
    }

    for (const manifest of manifests) {
      if (pendingMovePaths.has(manifest.relative_path)) continue
      const renamedDestination = renames.get(manifest.relative_path)
      if (renamedDestination) {
        this.#enqueue('rename-remote', renamedDestination, manifest.account_id, manifest.drive_file_id, {
          sourcePath: manifest.relative_path,
          destinationPath: renamedDestination,
        })
        continue
      }
      const local = localByPath.get(manifest.relative_path)
      const remote = remoteByDriveId.get(manifest.drive_file_id)
      const action = planSyncAction({
        baselineHash: manifest.baseline_hash,
        localExists: Boolean(local),
        localHash: local?.hash ?? null,
        remoteExists: Boolean(remote),
        remoteHash: remote?.hash ?? null,
        conflictPolicy: this.settings.conflictPolicy,
        deletionPolicy: this.settings.deletionPolicy,
      })
      if (action.type === 'unchanged') {
        if (manifest.size_bytes == null) {
          const sizeBytes = local?.size ?? remote?.size ?? null
          if (sizeBytes != null) this.store.upsertFile({ ...manifestToRecord(manifest), sizeBytes })
        }
        continue
      }
      if (action.type === 'forget') continue
      if (action.type === 'in-sync') {
        this.store.upsertFile({ ...manifestToRecord(manifest), baselineHash: action.baselineHash, sizeBytes: local?.size ?? remote?.size ?? manifest.size_bytes ?? null, syncState: 'active' })
        continue
      }
      await this.#queuePlanAction({ ...action, relativePath: manifest.relative_path, local, remote, manifest })
    }

    const untrackedLocal = localFiles.filter((file) => !manifestByPath.has(file.relativePath) && !claimedNew.has(file.relativePath))
    const occupiedPaths = new Set([
      ...localFiles.map((file) => file.relativePath),
      ...manifests.map((file) => file.relative_path),
    ])
    const untrackedRemote = remoteFiles
      .filter((file) => !manifestByDriveId.has(file.driveFileId))
      .map((file) => {
        if (!occupiedPaths.has(file.relativePath)) return file
        const conflictPath = createConflictPath(file.relativePath, file, occupiedPaths)
        return { ...file, relativePath: conflictPath }
      })
    const untrackedPlan = planFirstSync({ localFiles: untrackedLocal, remoteFiles: untrackedRemote, managedRoots: roots })
    for (const action of untrackedPlan.actions) await this.#queuePlanAction(action)

    if (changesSupported) this.#advanceTokens(consumed.tokens)
  }

  async #queuePlanAction(action) {
    if (action.type === 'adopt') {
      this.store.upsertFile({
        relativePath: action.relativePath,
        accountId: action.accountId,
        driveFileId: action.driveFileId,
        baselineHash: action.baselineHash,
        sizeBytes: action.size ?? null,
        syncState: 'active',
      })
      return
    }

    if (action.type === 'move-remote-to-conflict-path') {
      this.#enqueue('rename-remote', action.relativePath, action.remote.accountId, action.remote.driveFileId, {
        destinationPath: action.relativePath,
        sourcePath: action.fromRelativePath,
        remote: action.remote,
      })
      return
    }

    if (action.type === 'upload-local') {
      const local = action.local ?? { relativePath: action.relativePath, hash: action.localHash, size: action.size }
      const existingDriveId = action.driveFileId ?? action.manifest?.drive_file_id ?? null
      const assignedAccountId = action.accountId ?? action.manifest?.account_id
      const provider = existingDriveId && assignedAccountId
        ? this.#provider(assignedAccountId)
        : await this.#selectProvider(local.size ?? 0, assignedAccountId)
      this.#enqueue('upload', action.relativePath, provider.accountId, existingDriveId, {
        expectedHash: local.hash ?? action.localHash ?? null,
      })
      return
    }

    if (action.type === 'download') {
      const remote = action.remote
      this.#enqueue('download', action.relativePath, remote.accountId, remote.driveFileId, {
        expectedHash: remote.hash ?? action.baselineHash ?? null,
        remoteModifiedAt: remote.modifiedAt ?? null,
      })
      return
    }

    if (action.type === 'keep-both') {
      const remote = action.remote
      const conflictPath = createConflictPath(action.relativePath, remote, new Set(this.store.listFiles().map((file) => file.relative_path)))
      const accountId = (await this.#selectProvider(action.local?.size ?? 0)).accountId
      this.#enqueue('keep-both', action.relativePath, accountId, remote.driveFileId, {
        conflictPath,
        localHash: action.local?.hash ?? null,
        remote,
      })
      return
    }

    if (action.type === 'trash-remote' || action.type === 'restore-local' || action.type === 'download-as-conflict-copy') {
      const remote = action.remote ?? await this.#findRemote(action.manifest?.account_id, action.manifest?.drive_file_id)
      if (!remote) return
      const relativePath = action.type === 'download-as-conflict-copy'
        ? createConflictPath(action.relativePath, remote, new Set(this.store.listFiles().map((file) => file.relative_path)))
        : action.relativePath
      if (action.type === 'download-as-conflict-copy') {
        this.#enqueue('rename-remote', relativePath, remote.accountId, remote.driveFileId, {
          destinationPath: relativePath,
          sourcePath: action.relativePath,
          remote,
        })
      }
      this.#enqueue(action.type === 'trash-remote' ? 'trash-remote' : 'download', relativePath, remote.accountId, remote.driveFileId, {
        sourcePath: action.relativePath,
        expectedHash: remote.hash ?? null,
        remoteModifiedAt: remote.modifiedAt ?? null,
      })
      return
    }

    if (action.type === 'trash-local') {
      this.#enqueue('trash-local', action.relativePath, action.manifest?.account_id, action.manifest?.drive_file_id, {})
      return
    }

    if (action.type === 'restore-remote' || action.type === 'upload' || action.type === 'upload-as-conflict-copy') {
      const local = action.local ?? action.manifest
      const relativePath = action.type === 'upload-as-conflict-copy'
        ? createConflictPath(action.relativePath, { accountId: action.manifest?.account_id ?? 'drive', modifiedAt: new Date().toISOString() }, new Set(this.store.listFiles().map((file) => file.relative_path)))
        : action.relativePath
      const provider = await this.#selectProvider(local?.size ?? 0, action.manifest?.account_id)
      this.#enqueue(action.type === 'restore-remote' ? 'restore-remote' : 'upload', relativePath, provider.accountId, action.manifest?.drive_file_id ?? null, {
        expectedHash: local?.hash ?? null,
      })
    }
  }

  #enqueue(kind, relativePath, accountId, driveFileId, payload) {
    const fingerprint = JSON.stringify({ kind, relativePath, accountId, driveFileId, payload })
    const id = createHash('sha256').update(fingerprint).digest('hex')
    return this.store.enqueueOperation({ id, kind, relativePath, accountId, driveFileId, payload })
  }

  async #selectProvider(requiredBytes, preferredAccountId) {
    const manualPreferred = this.settings.autoRoute === false ? this.settings.preferredAccountId : null
    if (!preferredAccountId && manualPreferred) preferredAccountId = manualPreferred
    const candidates = []
    for (const provider of this.providers) {
      const quota = await provider.getQuota()
      const reserve = Number(this.settings.storageReservePercent ?? 5) / 100
      const limit = quota.limitBytes == null ? Number.POSITIVE_INFINITY : Number(quota.limitBytes)
      const usage = Number(quota.usageBytes ?? 0)
      const available = Math.max(0, limit * (1 - reserve) - usage)
      if (available >= requiredBytes) candidates.push({ provider, available })
    }
    candidates.sort((first, second) => {
      if (first.provider.accountId === preferredAccountId) return -1
      if (second.provider.accountId === preferredAccountId) return 1
      return second.available - first.available
    })
    if (!candidates.length) {
      const error = new Error('No connected Drive has enough space while preserving the configured reserve')
      error.code = 'INSUFFICIENT_STORAGE'
      throw error
    }
    return candidates[0].provider
  }

  #provider(accountId) {
    const provider = this.providers.find((item) => item.accountId === accountId)
    if (!provider) throw new Error(`Drive account is no longer connected: ${accountId}`)
    return provider
  }

  #supportsChanges(provider) {
    return provider.changesCapable === true && typeof provider.getStartPageToken === 'function' && typeof provider.listChanges === 'function'
  }

  #synthesizeRemote(manifest, rootFolderId) {
    return {
      accountId: manifest.account_id,
      driveFileId: manifest.drive_file_id,
      rootFolderId,
      relativePath: manifest.relative_path,
      hash: manifest.baseline_hash ?? null,
      size: manifest.size_bytes ?? null,
      modifiedAt: manifest.remote_modified_at ?? null,
    }
  }

  async #consumeChanges() {
    let count = 0
    const tokens = new Map()
    for (const provider of this.providers) {
      if (!this.#supportsChanges(provider)) continue
      let pageToken = this.store.getChangesPageToken(provider.accountId)
      if (!pageToken) {
        // No cursor for this account yet: force an authoritative reconcile this
        // poll and immediately seed the cursor so later polls are incremental.
        tokens.set(provider.accountId, await provider.getStartPageToken())
        count += 1
        continue
      }
      let finalToken = null
      let total = 0
      for (let pageNumber = 0; pageNumber < 500; pageNumber += 1) {
        const page = await provider.listChanges({ pageToken })
        total += page.changes.length
        if (page.newStartPageToken) finalToken = page.newStartPageToken
        if (!page.nextPageToken) break
        pageToken = page.nextPageToken
      }
      tokens.set(provider.accountId, finalToken ?? pageToken)
      count += total
    }
    return { count, tokens }
  }

  #advanceTokens(tokens) {
    for (const provider of this.providers) {
      const token = tokens.get(provider.accountId)
      if (token) this.store.setChangesPageToken(provider.accountId, token)
    }
  }

  async #recordStartTokens() {
    for (const provider of this.providers) {
      if (!this.#supportsChanges(provider)) continue
      const token = await provider.getStartPageToken()
      this.store.setChangesPageToken(provider.accountId, token)
    }
  }

  async #findRemote(accountId, driveFileId) {
    const provider = this.providers.find((item) => item.accountId === accountId)
    if (!provider || !driveFileId) return null
    const account = this.store.getAccount(accountId)
    if (!account?.root_folder_id) return null
    const files = await provider.listManagedFiles(account.root_folder_id)
    return files.find((file) => file.driveFileId === driveFileId) ?? null
  }

  #createHandlers(rootPath) {
    const upload = async (operation, { newFile = false } = {}) => {
      let provider = this.#provider(operation.account_id)
      const local = await snapshotFile(rootPath, operation.relative_path)
      if (operation.payload.expectedHash && operation.payload.expectedHash !== local.hash) {
        const error = new Error('Local file changed before its queued upload began')
        error.code = 'FILE_CHANGED_BEFORE_UPLOAD'
        throw error
      }
      let remote
      try {
        remote = await provider.uploadFile({
          rootFolderId: this.store.getAccount(provider.accountId).root_folder_id,
          relativePath: operation.relative_path,
          readable: createReadStream(local.absolutePath),
          size: local.size,
          hash: local.hash,
          driveFileId: newFile ? null : operation.drive_file_id,
          idempotencyKey: operation.id,
        })
      } catch (error) {
        if (error.code !== 'INSUFFICIENT_STORAGE' || !operation.drive_file_id) throw error
        provider = await this.#selectProvider(local.size, operation.account_id)
        if (provider.accountId === operation.account_id) throw error
        remote = await provider.uploadFile({
          rootFolderId: this.store.getAccount(provider.accountId).root_folder_id,
          relativePath: operation.relative_path,
          readable: createReadStream(local.absolutePath),
          size: local.size,
          hash: local.hash,
          idempotencyKey: `${operation.id}-move`,
        })
        await this.#provider(operation.account_id).trashFile(operation.drive_file_id)
      }
      const after = await snapshotFile(rootPath, operation.relative_path)
      if (after.hash !== local.hash) {
        const error = new Error('Local file changed during upload; it will be checked again')
        error.code = 'FILE_CHANGED_DURING_UPLOAD'
        throw error
      }
      this.store.upsertFile({
        relativePath: operation.relative_path,
        accountId: provider.accountId,
        driveFileId: remote.driveFileId,
        baselineHash: local.hash,
        sizeBytes: local.size,
        localModifiedAt: local.modifiedAt,
        remoteModifiedAt: remote.modifiedAt,
        syncState: 'active',
      })
      return remote
    }

    return {
      upload: (operation) => upload(operation),
      download: async (operation) => {
        const provider = this.#provider(operation.account_id)
        const remote = await provider.downloadFile(operation.drive_file_id)
        const result = await writeStreamAtomically(rootPath, operation.relative_path, remote.readable)
        if (operation.payload.expectedHash && result.hash !== operation.payload.expectedHash) {
          throw new Error('Downloaded content does not match the remote file hash')
        }
        this.store.upsertFile({
          relativePath: operation.relative_path,
          accountId: provider.accountId,
          driveFileId: operation.drive_file_id,
          baselineHash: result.hash,
          sizeBytes: result.size,
          localModifiedAt: result.modifiedAt,
          remoteModifiedAt: remote.modifiedAt,
          syncState: 'active',
        })
      },
      'rename-remote': async (operation) => {
        const provider = this.#provider(operation.account_id)
        const remote = await provider.renameFile(operation.drive_file_id, operation.payload.destinationPath)
        this.store.upsertFile({
          relativePath: operation.payload.destinationPath,
          accountId: provider.accountId,
          driveFileId: remote.driveFileId,
          baselineHash: remote.hash,
          sizeBytes: remote.size,
          remoteModifiedAt: remote.modifiedAt,
          syncState: 'active',
        })
        const sourcePath = operation.payload.sourcePath
        if (sourcePath && sourcePath !== operation.payload.destinationPath) {
          const previous = this.store.getFile(sourcePath)
          if (previous) {
            this.store.upsertFile({
              relativePath: sourcePath,
              accountId: previous.account_id,
              driveFileId: previous.drive_file_id,
              baselineHash: previous.baseline_hash,
              sizeBytes: previous.size_bytes,
              localModifiedAt: previous.local_modified_at,
              remoteModifiedAt: previous.remote_modified_at,
              syncState: 'forgotten',
              deletedAt: previous.deleted_at,
            })
          }
        }
      },
      'trash-remote': async (operation) => {
        await this.#provider(operation.account_id).trashFile(operation.drive_file_id)
        this.store.upsertFile({ relativePath: operation.payload.sourcePath ?? operation.relative_path, accountId: operation.account_id, driveFileId: operation.drive_file_id, syncState: 'tombstone', deletedAt: new Date().toISOString() })
      },
      'trash-local': async (operation) => {
        try {
          await moveLocalFileToTrash(rootPath, operation.relative_path, this.trashLocal)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        this.store.upsertFile({ relativePath: operation.relative_path, accountId: operation.account_id, driveFileId: operation.drive_file_id, syncState: 'tombstone', deletedAt: new Date().toISOString() })
      },
      'restore-local': async (operation) => {
        const provider = this.#provider(operation.account_id)
        await provider.restoreFile(operation.drive_file_id)
        const remote = await provider.downloadFile(operation.drive_file_id)
        const local = await writeStreamAtomically(rootPath, operation.relative_path, remote.readable)
        if (operation.payload.expectedHash && local.hash !== operation.payload.expectedHash) {
          throw new Error('Restored content does not match the remote file hash')
        }
        this.store.upsertFile({ relativePath: operation.relative_path, accountId: provider.accountId, driveFileId: operation.drive_file_id, baselineHash: local.hash, sizeBytes: local.size, localModifiedAt: local.modifiedAt, remoteModifiedAt: remote.modifiedAt, syncState: 'active' })
      },
      'restore-remote': async (operation) => {
        const provider = this.#provider(operation.account_id)
        try {
          await provider.restoreFile(operation.drive_file_id)
          return upload(operation)
        } catch (error) {
          if (error.code !== 'FILE_NOT_FOUND') throw error
          return upload(operation, { newFile: true })
        }
      },
      // Move a synced file to a different account: copy the local bytes to the
      // target, verify them, repoint the manifest, then permanently delete the
      // source copy. Deleting (rather than trashing) is deliberate — Drive trash
      // still counts against the quota, so trashing would free no usable space.
      'move-remote': async (operation) => {
        const targetAccountId = operation.payload?.targetAccountId
        if (!targetAccountId || targetAccountId === operation.account_id) return { skipped: 'no-target' }
        const source = this.#provider(operation.account_id)
        const target = this.#provider(targetAccountId)
        let local
        try {
          local = await snapshotFile(rootPath, operation.relative_path)
        } catch (error) {
          if (error.code === 'ENOENT') return { skipped: 'local-missing' }
          throw error
        }
        // The plan was built from the synced baseline. If the file changed since
        // then, leave it where it is and let the normal sync handle the edit.
        if (operation.payload.expectedHash && operation.payload.expectedHash !== local.hash) {
          return { skipped: 'local-changed' }
        }
        const targetRootFolderId = this.store.getAccount(target.accountId)?.root_folder_id
        if (!targetRootFolderId) throw new Error(`The managed Drive folder for ${target.accountId} is not ready`)
        // Idempotent by operation id: a retry updates the same target file rather
        // than creating a second copy.
        const remote = await target.uploadFile({
          rootFolderId: targetRootFolderId,
          relativePath: operation.relative_path,
          readable: createReadStream(local.absolutePath),
          size: local.size,
          hash: local.hash,
          driveFileId: null,
          idempotencyKey: operation.id,
        })
        // Drop the provisional copy (best effort) if the transfer cannot be
        // trusted, so a failed attempt never leaves an orphan on the target drive.
        const discardCopy = async () => {
          try {
            await target.deleteFile(remote.driveFileId)
          } catch (error) {
            if (error.code !== 'FILE_NOT_FOUND') throw error
          }
        }
        if (remote.md5Checksum) {
          const localMd5 = await hashFileMd5(local.absolutePath)
          if (localMd5 !== remote.md5Checksum) {
            await discardCopy()
            const error = new Error('The copied file did not match its source checksum; the move will be retried')
            error.code = 'REBALANCE_VERIFY_FAILED'
            throw error
          }
        }
        // If the file changed while it was being copied, do not delete the
        // original: discard the provisional copy and let the next sync upload
        // the edit to whichever drive the file still lives on.
        const after = await snapshotFile(rootPath, operation.relative_path)
        if (after.hash !== local.hash) {
          await discardCopy()
          return { skipped: 'local-changed-during-copy' }
        }
        // Point the manifest at the new copy before removing the old one, so a
        // crash between the two steps can never lose track of the file.
        this.store.upsertFile({
          relativePath: operation.relative_path,
          accountId: target.accountId,
          driveFileId: remote.driveFileId,
          baselineHash: local.hash,
          sizeBytes: local.size,
          localModifiedAt: local.modifiedAt,
          remoteModifiedAt: remote.modifiedAt,
          syncState: 'active',
        })
        if (operation.drive_file_id) {
          try {
            await source.deleteFile(operation.drive_file_id)
          } catch (error) {
            if (error.code !== 'FILE_NOT_FOUND') throw error
          }
        }
        return remote
      },
      'keep-both': async (operation) => {
        const provider = this.#provider(operation.payload.remote.accountId)
        const remoteConflict = await provider.renameFile(operation.drive_file_id, operation.payload.conflictPath)
        const conflictContent = await provider.downloadFile(operation.drive_file_id)
        const conflictLocal = await writeStreamAtomically(rootPath, operation.payload.conflictPath, conflictContent.readable)
        this.store.upsertFile({ relativePath: operation.payload.conflictPath, accountId: provider.accountId, driveFileId: remoteConflict.driveFileId, baselineHash: conflictLocal.hash, sizeBytes: conflictLocal.size, remoteModifiedAt: conflictContent.modifiedAt, localModifiedAt: conflictLocal.modifiedAt, syncState: 'active' })
        await upload({ ...operation, drive_file_id: null }, { newFile: true })
      },
    }
  }
}

module.exports = { SyncEngine }
