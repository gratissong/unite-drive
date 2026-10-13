export type SimilarFile = {
  path: string
  sizeBytes: number
  accountId: string
  accountEmail: string
  thumbnail: string | null
}

export type SimilarGroup = {
  sizeBytes: number
  count: number
  wasteBytes: number
  keeperPath: string
  files: SimilarFile[]
}

type RawSimilarFile = { path: string; sizeBytes: number; accountId: string | null; thumbnail: string | null }

/**
 * Shape raw scanner output into the report model. The suggested keeper is the
 * highest-resolution copy (largest file); the user can override it in the UI.
 * `wasteBytes` is what reclaiming the non-keepers would free.
 */
export function mapSimilarGroups(raw: Array<RawSimilarFile[]>, accountsById: Map<string, string>): SimilarGroup[] {
  const groups: SimilarGroup[] = []
  for (const files of raw ?? []) {
    if (!Array.isArray(files) || files.length < 2) continue
    const mapped: SimilarFile[] = files.map((file) => ({
      path: file.path,
      sizeBytes: file.sizeBytes,
      accountId: file.accountId ?? '',
      accountEmail: accountsById.get(file.accountId ?? '') ?? 'Drive account',
      thumbnail: file.thumbnail,
    }))
    const keeper = mapped.reduce((best, file) => (file.sizeBytes > best.sizeBytes ? file : best), mapped[0])
    const sizeBytes = keeper.sizeBytes
    const wasteBytes = mapped.reduce((total, file) => (file.path === keeper.path ? total : total + file.sizeBytes), 0)
    groups.push({ sizeBytes, count: mapped.length, wasteBytes, keeperPath: keeper.path, files: mapped })
  }
  return groups.sort((first, second) => second.wasteBytes - first.wasteBytes)
}

function svgColor(color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="${color}"/><circle cx="92" cy="66" r="26" fill="#ffffff77"/></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export const demoSimilarGroups: SimilarGroup[] = [
  {
    sizeBytes: 3400 * 1024,
    count: 3,
    wasteBytes: 6200 * 1024,
    keeperPath: 'holiday/PXL_20241002_143011.jpg',
    files: [
      { path: 'holiday/PXL_20241002_143011.jpg', sizeBytes: 3400 * 1024, accountId: 'account', accountEmail: 'you@gmail.com', thumbnail: svgColor('#86a58f') },
      { path: 'holiday/PXL_20241002_143012.jpg', sizeBytes: 1700 * 1024, accountId: 'account', accountEmail: 'you@gmail.com', thumbnail: svgColor('#a8bca6'), },
      { path: 'burst/PXL_20241002_143012-burst.jpg', sizeBytes: 1100 * 1024, accountId: 'account', accountEmail: 'you@gmail.com', thumbnail: svgColor('#c2cfc5') },
    ],
  },
  {
    sizeBytes: 5000 * 1024,
    count: 2,
    wasteBytes: 4800 * 1024,
    keeperPath: 'street/PXL_20241005_102211.jpg',
    files: [
      { path: 'street/PXL_20241005_102211.jpg', sizeBytes: 5000 * 1024, accountId: 'account', accountEmail: 'team@example.com', thumbnail: svgColor('#b3936e') },
      { path: 'street/PXL_20241005_102212.jpg', sizeBytes: 4800 * 1024, accountId: 'account', accountEmail: 'team@example.com', thumbnail: svgColor('#c4ab86') },
    ],
  },
]