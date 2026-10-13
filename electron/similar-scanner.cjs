const path = require('node:path')
const fs = require('node:fs')
const { resolveSafePath } = require('./file-ops.cjs')

// Only treat common image types. Everything else is byte-compared by the exact
// content-hash dedupe instead.
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.jfif', '.tif', '.tiff'])
// dHash produces 64 bits. Two "similar" photos should differ in well under a
// quarter of the bits; keep the threshold conservative to avoid merging photos
// that actually differ.
const HAMMING_THRESHOLD = 10
const THUMBNAIL_WIDTH = 180

// Sum of the RGB channels. Because we add all three, this is independent of the
// platform's pixel byte order, so we never guess RGBA vs BGRA vs ARGB.
function brightness(bitmap, index) {
  return bitmap[index] + bitmap[index + 1] + bitmap[index + 2]
}

// 64-bit gradient hash: resize to 9x8, then for each of 8 columns record
// whether the pixel to the right is brighter. Robust to resolution/exposure
// differences while still separating genuinely different images.
function dHashOf(image) {
  const resized = image.resize({ width: 9, height: 8, quality: 'best' })
  if (resized.isEmpty()) return null
  const size = resized.getSize()
  if (size.width < 9 || size.height < 8) return null
  const bitmap = resized.toBitmap()
  if (!bitmap || size.width * size.height * 4 > bitmap.length) return null

  const gray = new Array(72)
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      gray[y * 9 + x] = brightness(bitmap, (y * 9 + x) * 4)
    }
  }

  let hash = 0n
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      hash = (hash << 1n) | (gray[y * 9 + x + 1] > gray[y * 9 + x] ? 1n : 0n)
    }
  }
  return hash
}

function hammingDistance(a, b) {
  let x = a ^ b
  let count = 0
  while (x) {
    count += Number(x & 1n)
    x >>= 1n
  }
  return count
}

// Greedy cluster: each record either joins an existing group whose hash is
// close enough (threshold or fewer differing bits) or starts a new group.
function clusterSimilar(records) {
  const groups = []
  for (const record of records) {
    let placed = false
    for (const group of groups) {
      if (hammingDistance(group.repr.hash, record.hash) <= HAMMING_THRESHOLD) {
        group.files.push(record)
        placed = true
        break
      }
    }
    if (!placed) groups.push({ repr: record, files: [record] })
  }
  return groups
}

function thumbnailDataUrl(image) {
  const size = image.getSize()
  if (!size.width || !size.height) return null
  if (size.width > THUMBNAIL_WIDTH) return image.resize({ width: THUMBNAIL_WIDTH }).toDataURL()
  return image.toDataURL()
}

/**
 * Walk managed files that are image types and actually present on disk, compute
 * a perceptual hash for each, and cluster near-duplicates. Returns groups where
 * `files` carries the thumbnail data URL, local size and account id for the
 * renderer report. Non-destructive and computed on demand.
 */
function scanSimilarGroups({ rootPath, store }) {
  if (!rootPath || typeof store?.listFiles !== 'function') return []

  // Electron's nativeImage is only needed here; require lazily so the rest of
  // this module (and its unit tests) run under plain Node.
  const { nativeImage } = require('electron')

  const records = []
  for (const manifest of store.listFiles()) {
    if (!manifest.relative_path) continue
    if (['forgotten', 'tombstone'].includes(manifest.sync_state)) continue
    if (!IMAGE_EXTENSIONS.has(path.extname(manifest.relative_path).toLowerCase())) continue

    let resolved
    try {
      resolved = resolveSafePath(rootPath, manifest.relative_path)
    } catch {
      continue
    }
    if (!fs.existsSync(resolved.target)) continue

    let image
    try {
      image = nativeImage.createFromPath(resolved.target)
    } catch {
      continue
    }
    if (image.isEmpty()) continue

    const hash = dHashOf(image)
    if (hash === null) continue

    let sizeBytes = manifest.size_bytes
    if (!sizeBytes) {
      try {
        sizeBytes = fs.statSync(resolved.target).size
      } catch {
        sizeBytes = 0
      }
    }

    records.push({
      path: manifest.relative_path,
      sizeBytes: sizeBytes ?? 0,
      accountId: manifest.account_id,
      hash,
      thumbnail: thumbnailDataUrl(image),
    })
  }

  return clusterSimilar(records)
    .filter((group) => group.files.length >= 2)
    .map((group) => group.files.map((record) => ({
      path: record.path,
      sizeBytes: record.sizeBytes,
      accountId: record.accountId,
      thumbnail: record.thumbnail,
    })))
}

module.exports = { clusterSimilar, hammingDistance, scanSimilarGroups }