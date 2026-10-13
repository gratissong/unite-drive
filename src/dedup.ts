export type DuplicateFile = {
  path: string
  accountId: string
  accountEmail: string
}

export type DuplicateGroup = {
  sizeBytes: number
  count: number
  wasteBytes: number
  keeperPath: string
  files: DuplicateFile[]
}

/**
 * Group pooled files by content hash and flag clusters that store identical
 * bytes in more than one place. Only report on files that have a recorded
 * baseline hash (live copies, not tombstones). The recommended "keeper" is the
 * copy already sitting in the drive with the most free space.
 */
export function buildDuplicateGroups(
  files: Array<{ baseline_hash: string | null; size_bytes: number | null; sync_state: string; relative_path: string; account_id: string | null }>,
  accountsById: Map<string, string>,
  freeById: Map<string, number>,
): DuplicateGroup[] {
  const byHash = new Map<string, Array<{ path: string; accountId: string; size: number }>>()
  for (const file of files) {
    if (!file.baseline_hash || !(file.size_bytes ?? 0) || !file.account_id) continue
    if (['forgotten', 'tombstone'].includes(file.sync_state)) continue
    const entries = byHash.get(file.baseline_hash) ?? []
    entries.push({ path: file.relative_path, accountId: file.account_id, size: file.size_bytes ?? 0 })
    byHash.set(file.baseline_hash, entries)
  }

  const groups: DuplicateGroup[] = []
  for (const entries of byHash.values()) {
    if (entries.length < 2) continue
    const mapped: DuplicateFile[] = entries.map((entry) => ({
      path: entry.path,
      accountId: entry.accountId,
      accountEmail: accountsById.get(entry.accountId) ?? 'Drive account',
    }))
    let keeper = mapped[0]
    let keeperFree = freeById.get(keeper.accountId) ?? -1
    for (const file of mapped.slice(1)) {
      const free = freeById.get(file.accountId) ?? -1
      if (free > keeperFree) {
        keeper = file
        keeperFree = free
      }
    }
    groups.push({
      sizeBytes: entries[0].size,
      count: entries.length,
      wasteBytes: entries[0].size * (entries.length - 1),
      keeperPath: keeper.path,
      files: mapped,
    })
  }

  return groups.sort((first, second) => second.wasteBytes - first.wasteBytes)
}