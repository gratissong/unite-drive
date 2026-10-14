// Pure planner for the "rebalance drives" feature. Given the current per-account
// usage and the files recorded in the sync manifest, it decides which files to
// move from fuller drives to emptier ones so the drives end up at roughly the
// same percentage full. It performs no I/O and mutates nothing, so the engine
// can preview a plan (and the user can confirm it) before anything is transferred.

const defaultThresholdPercent = 5

function normalizeLimit(limitBytes) {
  if (limitBytes == null) return null
  const limit = Number(limitBytes)
  return Number.isFinite(limit) && limit > 0 ? limit : null
}

function summarizeAccount(account, usageBytes) {
  return {
    id: account.id,
    email: account.email ?? null,
    limitBytes: account.limitBytes,
    usageBytes,
    fillPercent: account.limitBytes > 0 ? (usageBytes / account.limitBytes) * 100 : 0,
  }
}

function planRebalance({ accounts = [], files = [], reservePercent = 5, options = {} } = {}) {
  const thresholdPercent = Number.isFinite(options.thresholdPercent)
    ? Math.max(0, options.thresholdPercent)
    : defaultThresholdPercent
  const maxMoves = Number.isFinite(options.maxMoves) && options.maxMoves > 0 ? Math.floor(options.maxMoves) : Infinity
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? Math.floor(options.maxBytes) : Infinity
  const reserveRatio = Math.max(0, Math.min(1, (Number(reservePercent) || 0) / 100))

  // Only accounts with a real (finite, positive) quota can be balanced. Google
  // reports `null` limits for unlimited plans, and those have no meaningful fill
  // to equalize, so they are left alone rather than treated as bottomless sinks.
  const finite = []
  for (const account of accounts) {
    if (!account?.id) continue
    const limitBytes = normalizeLimit(account.limitBytes)
    if (limitBytes == null) continue
    finite.push({
      id: account.id,
      email: account.email ?? null,
      limitBytes,
      usageBytes: Math.max(0, Number(account.usageBytes) || 0),
    })
  }

  const usage = new Map(finite.map((account) => [account.id, account.usageBytes]))
  const limits = new Map(finite.map((account) => [account.id, account.limitBytes]))
  const fill = (id) => (usage.get(id) / limits.get(id)) * 100
  const freeBytes = (id) => Math.max(0, limits.get(id) * (1 - reserveRatio) - usage.get(id))

  // A file is movable only when it is fully in sync: an active manifest row that
  // still points at a Drive file, with a known positive size.
  const movableByAccount = new Map(finite.map((account) => [account.id, []]))
  let movableCount = 0
  for (const file of files) {
    if (file.sync_state !== 'active') continue
    if (!file.account_id || !file.drive_file_id) continue
    const sizeBytes = Number(file.size_bytes)
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) continue
    const list = movableByAccount.get(file.account_id)
    if (!list) continue
    list.push({ relativePath: file.relative_path, sizeBytes })
    movableCount += 1
  }
  for (const list of movableByAccount.values()) list.sort((first, second) => second.sizeBytes - first.sizeBytes)

  const moves = []
  let totalBytes = 0
  let capped = false

  if (finite.length >= 2) {
    let guard = 0
    while (moves.length < maxMoves && totalBytes < maxBytes && guard <= movableCount) {
      const ordered = [...finite].sort((first, second) => fill(second.id) - fill(first.id))
      let chosen = null
      for (const donor of ordered) {
        const donorFiles = movableByAccount.get(donor.id)
        if (!donorFiles || donorFiles.length === 0) continue
        for (let index = ordered.length - 1; index >= 0; index -= 1) {
          const receiver = ordered[index]
          if (receiver.id === donor.id) continue
          // Skip pairs that are already balanced; also skip a receiver that the
          // donor is not actually fuller than.
          if (fill(donor.id) - fill(receiver.id) <= thresholdPercent) continue
          const available = freeBytes(receiver.id)
          if (available <= 0) continue
          // Move the largest file that fits the receiver's free space and does
          // not push the receiver past the donor's post-move fill, so every move
          // strictly narrows the gap and the loop always terminates.
          const fileIndex = donorFiles.findIndex((file) =>
            file.sizeBytes <= available &&
            (usage.get(receiver.id) + file.sizeBytes) / limits.get(receiver.id) <= (usage.get(donor.id) - file.sizeBytes) / limits.get(donor.id),
          )
          if (fileIndex === -1) continue
          chosen = { donor, receiver, fileIndex }
          break
        }
        if (chosen) break
      }
      if (!chosen) break

      const donorFiles = movableByAccount.get(chosen.donor.id)
      const [file] = donorFiles.splice(chosen.fileIndex, 1)
      usage.set(chosen.donor.id, usage.get(chosen.donor.id) - file.sizeBytes)
      usage.set(chosen.receiver.id, usage.get(chosen.receiver.id) + file.sizeBytes)
      moves.push({
        relativePath: file.relativePath,
        fromAccountId: chosen.donor.id,
        toAccountId: chosen.receiver.id,
        sizeBytes: file.sizeBytes,
      })
      totalBytes += file.sizeBytes
      guard += 1
    }
    if (Number.isFinite(maxMoves) && moves.length >= maxMoves) capped = true
    if (Number.isFinite(maxBytes) && totalBytes >= maxBytes) capped = true
  }

  const projected = finite.map((account) => summarizeAccount(account, usage.get(account.id)))
  const fills = projected.map((account) => account.fillPercent)
  const balanced = fills.length < 2 || Math.max(...fills) - Math.min(...fills) <= thresholdPercent

  return {
    moves,
    totalBytes,
    totalFiles: moves.length,
    thresholdPercent,
    capped,
    balanced,
    accounts: finite.map((account) => summarizeAccount(account, account.usageBytes)),
    projected,
  }
}

module.exports = { planRebalance, defaultThresholdPercent }
