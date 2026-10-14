import { useState } from 'react'
import { Copy, Image, Sparkles, X } from 'lucide-react'
import type { SimilarFile, SimilarGroup } from './similar'
import { useConfirm } from './confirm'

type Props = {
  groups: SimilarGroup[]
  isDemoData: boolean
  loading: boolean
  error: string
  applying: boolean
  onRemoveFiles: (removals: Array<{ relativePath: string }>) => void
}

function formatBytes(bytes: number) {
  const gib = 1024 ** 3
  const tib = 1024 ** 4
  if (bytes >= tib) return `${(bytes / tib).toFixed(1)} TB`
  if (bytes >= gib) return `${(bytes / gib).toFixed(bytes / gib < 10 ? 1 : 0)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function SimilarReport({ groups, isDemoData, loading, error, applying, onRemoveFiles }: Props) {
  const confirm = useConfirm()
  const [keepers, setKeepers] = useState<Record<string, string>>({})
  const [compareIndex, setCompareIndex] = useState<number | null>(null)

  const groupKey = (group: SimilarGroup) => group.files.map((file) => file.path).join('|')
  const keeperFor = (group: SimilarGroup) => keepers[groupKey(group)] ?? group.keeperPath
  const pickKeeper = (group: SimilarGroup, path: string) => setKeepers((current) => ({ ...current, [groupKey(group)]: path }))

  const totalWaste = groups.reduce((total, group) => total + group.wasteBytes, 0)

  async function handleDelete(group: SimilarGroup, file: SimilarFile) {
    if (file.path === keeperFor(group) || applying || isDemoData) return
    const name = file.path.split('/').at(-1) || file.path
    const keeper = keeperFor(group)
    const confirmed = await confirm({
      tone: 'danger',
      eyebrow: 'DELETE SIMILAR COPY',
      title: `Delete this copy of “${name}”?`,
      message: `“${name}” moves to your Recycle Bin and to Google Drive's trash — both recoverable. The keeper “${keeper}” stays unchanged.`,
      confirmLabel: 'Delete copy',
    })
    if (confirmed) onRemoveFiles([{ relativePath: file.path }])
  }

  return (
    <section className="storage-page-section">
      <div className="dedup-summary">
        <span className="dedup-icon"><Image size={18} /></span>
        <div className="dedup-summary-copy">
          <p className="eyebrow">GET THE GOOD FRAME</p>
          <h2>Similar photos across your drives</h2>
          <p>
            {loading
              ? 'Scanning your local photos by visual similarity…'
              : groups.length
                ? `Burst shots and near-identical captures found in ${groups.length} group${groups.length === 1 ? '' : 's'}. Tap an image to compare and pick the keeper; Keep/Delete trims the rest (recoverable). This can free up ${formatBytes(totalWaste)}.`
                : isDemoData
                  ? 'Sample records only. Connect your Google drives to scan your real photos.'
                  : 'No visually similar photos found. Files are matched by perceptual hash, so burst and multi-shot captures are caught even when they differ.'}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="dedup-empty"><Image size={18} /><p>Comparing photos. This only reads image files that are already in your local sync folder.</p></div>
      ) : error ? (
        <div className="dedup-empty"><Sparkles size={18} /><p>{error}</p></div>
      ) : groups.length === 0 ? (
        <div className="dedup-empty"><Copy size={18} /><p>{isDemoData ? 'This is the similar-photo report. It stays empty here because you are viewing sample data.' : 'Nothing to sort through right now. The scan looks at image files in your local sync folder by content similarity.'}</p></div>
      ) : (
        <div className="similar-list">
          {groups.map((group, index) => {
            const keeper = keeperFor(group)
            const removals = group.files.length - 1
            return (
              <article className="similar-group" key={groupKey(group)}>
                <div className="duplicate-group-head">
                  <span className="duplicate-file-icon"><Image size={16} /></span>
                  <div className="duplicate-group-title">
                    <strong>{group.files[0].path.split('/').at(-1)}</strong>
                    <p>{group.count} similar captures · keep one</p>
                  </div>
                  <button type="button" className="compare-trigger" onClick={() => setCompareIndex(index)}>Compare</button>
                  <span className="duplicate-badge">{formatBytes(group.wasteBytes)} freed</span>
                </div>
                <div className="similar-thumbs">
                  {group.files.map((file) => {
                    const isKeeper = file.path === keeper
                    return (
                      <figure className={`similar-thumb ${isKeeper ? 'keeper' : ''}`} key={file.path}>
                        <button
                          type="button"
                          className="similar-thumb-pick"
                          onClick={() => pickKeeper(group, file.path)}
                          title="Click to make this the keeper"
                        >
                          {file.thumbnail ? <img src={file.thumbnail} alt={file.path.split('/').at(-1) ?? file.path} loading="lazy" /> : <span className="similar-thumb-fallback"><Image size={18} /></span>}
                          <span className="similar-thumb-label">{isKeeper ? 'Keep' : 'Copy'}</span>
                        </button>
                        <figcaption>
                          <span className="similar-thumb-name">{file.path.split('/').at(-1) ?? file.path}</span>
                          <span className="similar-thumb-drive">{file.accountEmail}</span>
                          <span className="similar-thumb-size">{formatBytes(file.sizeBytes)}</span>
                        </figcaption>
                        <span className="similar-thumb-actions">
                          <button
                            type="button"
                            className="copy-action copy-keep"
                            disabled={applying || isDemoData || isKeeper}
                            onClick={() => pickKeeper(group, file.path)}
                          >
                            Keep
                          </button>
                          <button
                            type="button"
                            className="copy-action copy-delete"
                            disabled={applying || isDemoData || isKeeper}
                            onClick={() => { void handleDelete(group, file) }}
                          >
                            Delete
                          </button>
                        </span>
                      </figure>
                    )
                  })}
                </div>
                <p className="duplicate-note"><Image size={13} /> {repText(group.files[0].path.split('/').at(-1) || group.files[0].path, keeper, removals, isDemoData)}</p>
              </article>
            )
          })}
        </div>
      )}

      {isDemoData && <div className="demo-notice"><Sparkles size={15} /><span>Sample photo groups are shown so you can preview the report. Your live photos are scanned locally for similarity — nothing is deleted automatically.</span></div>}

      {compareIndex !== null && groups[compareIndex] && (
        <CompareModal
          group={groups[compareIndex]}
          keeperPath={keeperFor(groups[compareIndex])}
          applying={applying}
          isDemoData={isDemoData}
          onPick={(path) => pickKeeper(groups[compareIndex], path)}
          onClose={() => setCompareIndex(null)}
          onDelete={(file) => { void handleDelete(groups[compareIndex], file) }}
        />
      )}
    </section>
  )
}

function repText(name: string, keeper: string, removals: number, isDemoData: boolean) {
  if (isDemoData) return 'Preview only — no real files to clean up.'
  if (name === keeper) return `This capture is the keeper. Keep/Delete on each image trims the others (recoverable).`
  return `${removals} similar cop${removals === 1 ? 'y' : 'ies'} can be trimmed; the keeper remains. Delete moves them to the Recycle Bin and Drive trash.`
}

type CompareModalProps = {
  group: SimilarGroup
  keeperPath: string
  applying: boolean
  isDemoData: boolean
  onPick: (path: string) => void
  onClose: () => void
  onDelete: (file: SimilarFile) => void
}

function CompareModal({ group, keeperPath, applying, isDemoData, onPick, onClose, onDelete }: CompareModalProps) {
  return (
    <div className="compare-overlay" onClick={onClose}>
      <div className="compare-panel" onClick={(event) => event.stopPropagation()}>
        <div className="compare-head">
          <strong>Compare · pick a keeper</strong>
          <button type="button" className="compare-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <p className="compare-hint">Click a photo to make it the keeper, then trim the rest.</p>
        <div className="compare-strip">
          {group.files.map((file) => {
            const isKeeper = file.path === keeperPath
            return (
              <figure className={`compare-item ${isKeeper ? 'keeper' : ''}`} key={file.path}>
                <button type="button" className="compare-image" onClick={() => onPick(file.path)} title="Set as keeper">
                  {file.thumbnail ? <img src={file.thumbnail} alt={file.path.split('/').at(-1) ?? file.path} /> : <span className="similar-thumb-fallback"><Image size={18} /></span>}
                </button>
                <figcaption>
                  <span className="compare-name">{file.path.split('/').at(-1) ?? file.path}</span>
                  <span className="compare-meta">{file.accountEmail} · {formatBytes(file.sizeBytes)}</span>
                  <div className="compare-actions">
                    <button
                      type="button"
                      className="copy-action copy-keep"
                      disabled={applying || isDemoData || isKeeper}
                      onClick={() => onPick(file.path)}
                    >
                      {isKeeper ? 'Keeping' : 'Keep this'}
                    </button>
                    <button
                      type="button"
                      className="copy-action copy-delete"
                      disabled={applying || isDemoData || isKeeper}
                      onClick={() => onDelete(file)}
                    >
                      Delete
                    </button>
                  </div>
                </figcaption>
              </figure>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default SimilarReport