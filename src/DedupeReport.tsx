import { useState } from 'react'
import { Copy, FileArchive, HardDrive, Sparkles } from 'lucide-react'
import type { DuplicateFile, DuplicateGroup } from './dedup'

type Props = {
  groups: DuplicateGroup[]
  isDemoData: boolean
  applying: boolean
  onApplyDedupe: (removals: Array<{ relativePath: string }>) => void
}

function formatBytes(bytes: number) {
  const gib = 1024 ** 3
  const tib = 1024 ** 4
  if (bytes >= tib) return `${(bytes / tib).toFixed(1)} TB`
  if (bytes >= gib) return `${(bytes / gib).toFixed(bytes / gib < 10 ? 1 : 0)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function DedupeReport({ groups, isDemoData, applying, onApplyDedupe }: Props) {
  const [keepers, setKeepers] = useState<Record<string, string>>({})
  const totalWaste = groups.reduce((total, group) => total + group.wasteBytes, 0)
  const clusters = groups.length

  const groupKey = (group: DuplicateGroup) => group.files.map((file) => file.path).join('|')
  const keeperFor = (group: DuplicateGroup) => keepers[groupKey(group)] ?? group.keeperPath
  const pickKeeper = (group: DuplicateGroup, path: string) => setKeepers((current) => ({ ...current, [groupKey(group)]: path }))

  function handleDelete(group: DuplicateGroup, file: DuplicateFile) {
    if (file.path === keeperFor(group) || applying || isDemoData) return
    const name = file.path.split('/').at(-1) || file.path
    const keeper = keeperFor(group)
    const confirmed = window.confirm(
      `Delete this duplicate copy?\n\n` +
        `"${name}" moves to your Recycle Bin and to Google Drive's trash (both recoverable).\n` +
        `The keeper "${keeper}" stays unchanged.`,
    )
    if (confirmed) onApplyDedupe([{ relativePath: file.path }])
  }

  return (
    <section className="storage-page-section">
      <div className="dedup-summary">
        <span className="dedup-icon"><Sparkles size={18} /></span>
        <div className="dedup-summary-copy">
          <p className="eyebrow">STORAGE SAVER</p>
          <h2>Duplicate files across your drives</h2>
          <p>
            {clusters
              ? `Identical content found in ${clusters} group${clusters === 1 ? '' : 's'}. On each line, click Keep to make that copy the keeper, or Delete to remove it (recoverable). This can free up ${formatBytes(totalWaste)}.`
              : isDemoData
                ? 'Sample records only. Connect your Google drives to scan for real duplicates.'
                : 'No duplicate file content found. Files are compared by content hash, so the same file in different folders is only counted once.'}
          </p>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="dedup-empty"><Copy size={18} /><p>{isDemoData ? 'This is the duplicate report. It stays empty here because you are viewing sample data.' : 'Nothing to reclaim right now. Duplicates are found by comparing the content hash stored in the sync manifest.'}</p></div>
      ) : (
        <div className="duplicate-list">
          {groups.map((group) => {
            const keeper = keeperFor(group)
            return (
              <article className="duplicate-group" key={`${group.sizeBytes}-${group.files.map((file) => file.path).join('|')}`}>
                <div className="duplicate-group-head">
                  <span className="duplicate-file-icon"><FileArchive size={16} /></span>
                  <div className="duplicate-group-title">
                    <strong>{group.files[0].path.split('/').at(-1)}</strong>
                    <p>{group.count} copies · {formatBytes(group.sizeBytes)} each · reduce to one</p>
                  </div>
                  <span className="duplicate-badge">{formatBytes(group.wasteBytes)} saved</span>
                </div>
                <ul className="duplicate-copies">
                  {group.files.map((file) => {
                    const isKeeper = file.path === keeper
                    return (
                      <li className={`duplicate-copy ${isKeeper ? 'keeper' : ''}`} key={file.path}>
                        <span className="duplicate-copy-label">{isKeeper ? 'Keep' : 'Copy'}</span>
                        <span className="duplicate-copy-path" title={file.path}>{file.path}</span>
                        <span className="duplicate-copy-drive" title={file.accountEmail}>{file.accountEmail}</span>
                        <span className="copy-actions">
                          <button
                            type="button"
                            className={`copy-action copy-keep${isKeeper ? ' is-keeper' : ''}`}
                            disabled={applying || isDemoData}
                            onClick={() => pickKeeper(group, file.path)}
                            aria-pressed={isKeeper}
                          >
                            Keep
                          </button>
                          <button
                            type="button"
                            className="copy-action copy-delete"
                            disabled={applying || isDemoData || isKeeper}
                            onClick={() => handleDelete(group, file)}
                            title={isKeeper ? 'This is the keeper — pick Keep on another copy to change it' : 'Delete this copy'}
                          >
                            Delete
                          </button>
                        </span>
                      </li>
                    )
                  })}
                </ul>
                <p className="duplicate-note"><HardDrive size={13} /> {isDemoData ? 'Preview only — no real files to clean up.' : 'Keep marks the copy that survives; Delete trashes that single copy to the Recycle Bin and Drive trash.'}</p>
              </article>
            )
          })}
        </div>
      )}

      {isDemoData && <div className="demo-notice"><Sparkles size={15} /><span>Sample duplicate groups are shown so you can preview the report. Your live files carry a content hash in the sync manifest for real detection and cleanup.</span></div>}
    </section>
  )
}

export default DedupeReport