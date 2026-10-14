import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react'
import {
  AlertTriangle,
  ArrowUp,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  File,
  FileArchive,
  FileImage,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SquareCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useConfirm } from './confirm'

type FsEntry = {
  name: string
  isDirectory: boolean
  size: number | null
  mtime: string | null
  accountEmail?: string | null
  syncState?: string | null
}

type MoveTarget = {
  name: string
  isDirectory: boolean
  path: string
}

type MoveRequest = {
  from: string
  to: string
}

function pathLabel(segments: string[]) {
  return segments.length ? segments.join('/') : ''
}

function childPath(segments: string[], name: string) {
  const parent = pathLabel(segments)
  return parent ? `${parent}/${name}` : name
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm
}

function formatBytes(value: number | null) {
  if (value == null) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
}

function formatTime(value: string | null) {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}

function fileIcon(name: string) {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? ''
  if (['zip', 'rar', '7z'].includes(extension)) return <FileArchive size={16} />
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(extension)) return <FileImage size={16} />
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'xls', 'xlsx', 'ppt', 'pptx'].includes(extension)) return <FileText size={16} />
  return <File size={16} />
}

function syncLabel(state: string | null | undefined) {
  switch (state) {
    case 'active': return 'Synced'
    case 'tombstone': return 'Deleted'
    case 'forgotten': return 'Moved'
    default: return 'Pending'
  }
}

function syncTone(state: string | null | undefined) {
  switch (state) {
    case 'active': return 'sync-ok'
    case 'tombstone': return 'sync-dead'
    case 'forgotten': return 'sync-moved'
    default: return 'sync-pending'
  }
}

export default function ExplorerTab({ onNotify, focus }: { onNotify?: (message: string) => void; focus?: { path: string; nonce: number } | null }) {
  const bridge = window.uniteDrive
  const confirm = useConfirm()
  // When opened from the search palette, start in the matching item's folder
  // with its name filtered so the row is visible and highlighted.
  const initialFocus = (() => {
    if (!focus) return { segments: [] as string[], name: '' }
    const separator = focus.path.lastIndexOf('/')
    return {
      segments: separator === -1 ? [] : focus.path.slice(0, separator).split('/'),
      name: separator === -1 ? focus.path : focus.path.slice(separator + 1),
    }
  })()
  const [segments, setSegments] = useState<string[]>(initialFocus.segments)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState(initialFocus.name)
  const [highlightName, setHighlightName] = useState<string | null>(initialFocus.name || null)
  const [editing, setEditing] = useState<{ name: string; isNewFolder: boolean } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [moving, setMoving] = useState<MoveTarget[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [dragging, setDragging] = useState(false)
  const [dragCount, setDragCount] = useState(0)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const submitGuard = useRef(false)
  const dragNamesRef = useRef<string[]>([])

  const currentPath = pathLabel(segments)
  const filtered = search.trim()
    ? entries.filter((entry) => entry.name.toLowerCase().includes(search.trim().toLowerCase()))
    : entries
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)
  const selectedTargets: MoveTarget[] = entries
    .filter((entry) => selected.has(entry.name))
    .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory, path: childPath(segments, entry.name) }))

  const reload = useCallback(async (targetSegments: string[]) => {
    if (!bridge) return
    try {
      const list = await bridge.listDirectory(pathLabel(targetSegments))
      setEntries(list)
      setSelected((current) => {
        if (!current.size) return current
        const names = new Set(list.map((item) => item.name))
        const next = new Set([...current].filter((name) => names.has(name)))
        return next.size === current.size ? current : next
      })
      setError('')
    } catch (cause) {
      setEntries([])
      const message = cause instanceof Error ? cause.message : 'Could not read that folder.'
      setError(message)
      onNotify?.(message)
    } finally {
      setLoading(false)
    }
  }, [bridge, onNotify])

  // Load the directory when navigating, and refresh whenever a sync pass lands.
  useEffect(() => {
    if (!bridge) return
    let active = true
    bridge.listDirectory(pathLabel(segments)).then((list) => {
      if (!active) return
      setEntries(list)
      setError('')
      setLoading(false)
    }).catch((cause) => {
      if (!active) return
      setEntries([])
      const message = cause instanceof Error ? cause.message : 'Could not read that folder.'
      setError(message)
      onNotify?.(message)
      setLoading(false)
    })
    return () => { active = false }
  }, [bridge, segments, onNotify])

  useEffect(() => {
    const unsubscribe = bridge?.onSyncStatus?.((status) => {
      if (['idle', 'retrying', 'error'].includes(status.status)) void reload(segments)
    })
    return unsubscribe
  }, [bridge, segments, reload])

  useEffect(() => {
    if (!highlightName) return
    const timer = window.setTimeout(() => setHighlightName(null), 4000)
    return () => window.clearTimeout(timer)
  }, [highlightName])

  // Ctrl/Cmd+A selects everything visible (or all matching the filter); Escape clears.
  const filteredRef = useRef(filtered)
  useEffect(() => { filteredRef.current = filtered }, [filtered])
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        const names = filteredRef.current.map((item) => item.name)
        setSelected(new Set(names))
        setAnchor(names.at(-1) ?? null)
      } else if (event.key === 'Escape') {
        setSelected(new Set())
        setAnchor(null)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  const goTo = (nextSegments: string[]) => {
    setLoading(true)
    setSegments(nextSegments)
    setSearch('')
    setSelected(new Set())
    setAnchor(null)
    setPage(1)
  }

  const openFolder = (name: string) => goTo([...segments, name])

  function runMutation(task: () => Promise<unknown>, success: string) {
    void (async () => {
      try {
        await task()
        onNotify?.(success)
        void reload(segments)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'The operation failed.'
        onNotify?.(message)
      }
    })()
  }

  const createNewFolder = () => {
    submitGuard.current = false
    setEditing({ name: '', isNewFolder: true })
    setEditValue('')
  }

  const startRename = (name: string) => {
    submitGuard.current = false
    setEditing({ name, isNewFolder: false })
    setEditValue(name)
  }

  const submitEdit = () => {
    if (!editing || submitGuard.current) return
    const value = editValue.trim()
    if (!value) return
    submitGuard.current = true
    const parentPath = currentPath
    const createPath = parentPath ? `${parentPath}/${value}` : value
    if (editing.isNewFolder) {
      runMutation(() => bridge!.createFolder(createPath), `Created "${value}".`)
    } else {
      const oldName = editing.name
      const from = childPath(segments, oldName)
      const to = parentPath ? `${parentPath}/${value}` : value
      if (from === to) {
        setEditing(null)
        return
      }
      runMutation(() => bridge!.movePath(from, to), `Renamed "${oldName}" to "${value}".`)
    }
    setEditing(null)
  }

  const requestDelete = async (name: string) => {
    const target = childPath(segments, name)
    const confirmed = await confirm({
      tone: 'danger',
      eyebrow: 'MOVE TO RECYCLE BIN',
      title: `Move “${name}” to the Recycle Bin?`,
      message: 'Its cloud copy will follow your deletion policy. You can restore it from the Recycle Bin.',
      confirmLabel: 'Move to Recycle Bin',
    })
    if (!confirmed) return
    runMutation(() => bridge!.trashPath(target), `Moved "${name}" to the Recycle Bin.`)
  }

  const reveal = (name: string) => {
    void bridge?.revealInExplorer(childPath(segments, name))
  }

  const uploadHere = () => {
    void (async () => {
      try {
        const result = await bridge!.importIntoFolder(currentPath)
        if (result.imported) onNotify?.(`Imported ${result.imported} file${result.imported === 1 ? '' : 's'}.`)
        if (result.skipped.length) onNotify?.(`Skipped ${result.skipped.length} existing name${result.skipped.length === 1 ? '' : 's'}.`)
        if (result.errors.length) onNotify?.(`${result.errors.length} file${result.errors.length === 1 ? '' : 's'} could not be added.`)
        void reload(segments)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Could not add files.'
        onNotify?.(message)
      }
    })()
  }

  // ---- Selection -----------------------------------------------------------

  const handleRowSelect = (name: string, index: number, event: ReactMouseEvent<HTMLElement>) => {
    if (event.shiftKey && anchor) {
      const anchorIndex = filtered.findIndex((item) => item.name === anchor)
      const start = anchorIndex === -1 ? index : Math.min(anchorIndex, index)
      const end = anchorIndex === -1 ? index : Math.max(anchorIndex, index)
      setSelected(new Set(filtered.slice(start, end + 1).map((item) => item.name)))
      return
    }
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selected)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      setSelected(next)
      setAnchor(name)
      return
    }
    setSelected(new Set([name]))
    setAnchor(name)
  }

  const selectAll = () => {
    const names = filtered.map((item) => item.name)
    setSelected(new Set(names))
    setAnchor(names.at(-1) ?? null)
  }

  const clearSelection = () => {
    setSelected(new Set())
    setAnchor(null)
  }

  // ---- Drag and drop -------------------------------------------------------

  const beginDrag = (name: string, event: ReactDragEvent<HTMLDivElement>) => {
    const names = selected.has(name) ? [...selected] : [name]
    dragNamesRef.current = names
    if (!selected.has(name)) {
      setSelected(new Set([name]))
      setAnchor(name)
    }
    setDragging(true)
    setDragCount(names.length)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', names.join('\n'))
  }

  const endDrag = () => {
    setDragging(false)
    setDragCount(0)
    setDropTarget(null)
  }

  const moveNamesInto = (names: string[], destinationDir: string) => {
    const moves: MoveRequest[] = names
      .map((name) => ({ from: childPath(segments, name), to: destinationDir ? `${destinationDir}/${name}` : name }))
      .filter((move) => move.from !== move.to)
    dragNamesRef.current = []
    endDrag()
    if (!moves.length) return
    void (async () => {
      try {
        const result = await bridge!.movePaths(moves)
        if (result.moved.length) onNotify?.(`Moved ${result.moved.length} ${plural(result.moved.length, 'item')}.`)
        if (result.errors.length) onNotify?.(`${result.errors.length} ${plural(result.errors.length, 'item')} could not be moved.`)
      } catch (cause) {
        onNotify?.(cause instanceof Error ? cause.message : 'The move failed.')
      } finally {
        // The filesystem may have changed even if the call rejected, so always
        // drop the selection and re-read the folder rather than strand the bar.
        clearSelection()
        void reload(segments)
      }
    })()
  }

  const canDropInto = (name: string) => !dragNamesRef.current.includes(name)

  const handleFolderDragOver = (event: ReactDragEvent<HTMLDivElement>, entry: FsEntry) => {
    if (!entry.isDirectory || !canDropInto(entry.name)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dropTarget !== entry.name) setDropTarget(entry.name)
  }

  const handleFolderDrop = (event: ReactDragEvent<HTMLDivElement>, entry: FsEntry) => {
    event.preventDefault()
    if (!dragNamesRef.current.length || !canDropInto(entry.name)) return
    moveNamesInto(dragNamesRef.current, childPath(segments, entry.name))
  }

  const crumbDrop = (targetSegments: string[]) => ({
    onDragOver: (event: ReactDragEvent<HTMLButtonElement>) => {
      if (!dragNamesRef.current.length) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDropTarget(`crumb:${pathLabel(targetSegments)}`)
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: (event: ReactDragEvent<HTMLButtonElement>) => {
      event.preventDefault()
      if (!dragNamesRef.current.length) return
      moveNamesInto(dragNamesRef.current, pathLabel(targetSegments))
    },
  })

  const deleteSelected = async () => {
    if (!selectedTargets.length) return
    const label = selectedTargets.length === 1 ? `"${selectedTargets[0].name}"` : `${selectedTargets.length} items`
    const confirmed = await confirm({
      tone: 'danger',
      eyebrow: 'MOVE TO RECYCLE BIN',
      title: `Move ${label} to the Recycle Bin?`,
      message: selectedTargets.length === 1
        ? 'Its cloud copy will follow your deletion policy. You can restore it from the Recycle Bin.'
        : 'Their cloud copies will follow your deletion policy. You can restore them from the Recycle Bin.',
      confirmLabel: 'Move to Recycle Bin',
    })
    if (!confirmed) return
    const paths = selectedTargets.map((target) => target.path)
    void (async () => {
      try {
        const result = await bridge!.trashPaths(paths)
        if (result.trashed.length) onNotify?.(`Moved ${result.trashed.length} ${plural(result.trashed.length, 'item')} to the Recycle Bin.`)
        if (result.errors.length) onNotify?.(`${result.errors.length} ${plural(result.errors.length, 'item')} could not be removed.`)
      } catch (cause) {
        onNotify?.(cause instanceof Error ? cause.message : 'The delete failed.')
      } finally {
        clearSelection()
        void reload(segments)
      }
    })()
  }

  const breadcrumbs = [
    { label: 'Unite Drive', segments: [] as string[] },
    ...segments.map((segment, index) => {
      const upTo = segments.slice(0, index + 1)
      return { label: segment, segments: upTo }
    }),
  ]

  return (
    <section className="explorer-page-section table-page-section">
      <div className="explorer-breadcrumb" aria-label="Current folder">
        {breadcrumbs.map((crumb, index) => (
          <span className="explorer-crumb" key={`${crumb.label}-${index}`}>
            {index > 0 && <ChevronRight size={14} className="explorer-crumb-chevron" />}
            <button
              className={`explorer-crumb-button ${index === breadcrumbs.length - 1 ? 'active' : ''}${dropTarget === `crumb:${pathLabel(crumb.segments)}` ? ' is-drop-target' : ''}`}
              onClick={() => goTo(crumb.segments)}
              {...crumbDrop(crumb.segments)}
            >{crumb.label}</button>
          </span>
        ))}
      </div>

      <div className="explorer-toolbar table-toolbar">
        <div className="search-field"><Search size={16} /><input aria-label="Filter this folder" placeholder="Filter this folder" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); clearSelection() }} /></div>
        <button className="button button-secondary" onClick={() => goTo(segments)}><RefreshCw size={15} /> Refresh</button>
        <button className="button button-secondary" onClick={createNewFolder}><Plus size={15} /> New folder</button>
        <button className="button button-secondary" onClick={uploadHere}><Upload size={15} /> Upload here</button>
        <button className="button button-secondary" onClick={() => bridge?.revealInExplorer(currentPath)}><ArrowUpRight size={15} /> Open in Explorer</button>
        <button className="button button-secondary" onClick={selectAll} disabled={!filtered.length} title="Select all (Ctrl+A)"><SquareCheck size={15} /> Select all</button>
      </div>

      {selected.size > 0 && (
        <div className="explorer-selection-bar" role="status">
          <SquareCheck size={15} />
          <span><strong>{selected.size}</strong> selected</span>
          <button className="button button-primary" onClick={() => setMoving(selectedTargets)}><FolderInput size={14} /> Move…</button>
          <button className="button button-secondary" onClick={() => { void deleteSelected() }}><Trash2 size={14} /> Delete</button>
          <span className="explorer-selection-spacer" />
          <span className="explorer-selection-hint">Drag onto a folder or breadcrumb to move</span>
          <button className="text-button" onClick={clearSelection}>Clear</button>
        </div>
      )}

      {currentPath && <div className="explorer-parent"><button className="text-button" onClick={() => goTo(segments.slice(0, -1))}><ArrowUp size={14} /> Up one level</button></div>}

      <div className="file-table expanded">
        <div className="file-table-head"><span>NAME</span><span>SIZE</span><span>DRIVE</span><span>SYNC</span><span>MODIFIED</span><span /></div>

        {editing?.isNewFolder && (
          <div className="file-table-row">
            <span className="file-name-cell">
              <FolderOpen size={16} />
              <span className="explorer-inline-edit" onClick={(event) => event.stopPropagation()}>
                <input autoFocus value={editValue} onChange={(event) => setEditValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitEdit(); if (event.key === 'Escape') setEditing(null) }} placeholder="Folder name" aria-label="New folder name" />
                <button className="explorer-inline-confirm" onClick={submitEdit}>Create</button>
                <button className="explorer-inline-cancel" onClick={() => setEditing(null)}><X size={14} /></button>
              </span>
            </span>
            <span /><span /><span /><span /><span />
          </div>
        )}

        {loading ? (
          <div className="empty-files">Loading this folder…</div>
        ) : error && !entries.length ? (
          <div className="explorer-error"><AlertTriangle size={16} /><span>{error}</span></div>
        ) : filtered.length === 0 ? (
          <div className="empty-files">{search ? 'No matches in this folder.' : 'This folder is empty.'}</div>
        ) : visible.map((entry, index) => {
          const rowIndex = (safePage - 1) * pageSize + index
          const showEditInput = editing && !editing.isNewFolder && editing.name === entry.name
          const isSelected = selected.has(entry.name)
          return (
            <div
              className={`file-table-row${isSelected ? ' is-selected' : ''}${entry.name === highlightName ? ' explorer-row-focus' : ''}${dropTarget === entry.name ? ' is-drop-target' : ''}`}
              key={entry.name}
              draggable={!editing && !moving}
              onClick={(event) => handleRowSelect(entry.name, rowIndex, event)}
              onDoubleClick={() => { if (entry.isDirectory) openFolder(entry.name); else reveal(entry.name) }}
              onDragStart={(event) => beginDrag(entry.name, event)}
              onDragEnd={endDrag}
              onDragOver={(event) => handleFolderDragOver(event, entry)}
              onDragLeave={() => { if (dropTarget === entry.name) setDropTarget(null) }}
              onDrop={(event) => handleFolderDrop(event, entry)}
            >
              <span className="file-name-cell">
                {entry.isDirectory ? <Folder size={16} /> : fileIcon(entry.name)}
                {showEditInput ? (
                  <span className="explorer-inline-edit" onClick={(event) => event.stopPropagation()}>
                    <input autoFocus value={editValue} onChange={(event) => setEditValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitEdit(); if (event.key === 'Escape') setEditing(null) }} aria-label={`Rename ${entry.name}`} />
                    <button className="explorer-inline-confirm" onClick={submitEdit}>Save</button>
                    <button className="explorer-inline-cancel" onClick={() => setEditing(null)}><X size={14} /></button>
                  </span>
                ) : (
                  <button
                    className="explorer-name"
                    title={entry.name}
                    onClick={(event) => { event.stopPropagation(); handleRowSelect(entry.name, rowIndex, event) }}
                    onDoubleClick={(event) => { event.stopPropagation(); if (entry.isDirectory) openFolder(entry.name); else reveal(entry.name) }}
                  >{entry.name}</button>
                )}
              </span>
              <span className="file-size-cell">{entry.isDirectory ? '—' : formatBytes(entry.size)}</span>
              <span className="file-drive-cell">{entry.isDirectory ? '—' : (entry.accountEmail ?? 'Not assigned')}</span>
              <span className="queue-state"><span className={`queue-kind-label ${syncTone(entry.syncState)}`}>{entry.isDirectory ? 'Folder' : syncLabel(entry.syncState)}</span></span>
              <span className="file-time-cell">{formatTime(entry.mtime)}</span>
              <span className="explorer-actions" onClick={(event) => event.stopPropagation()}>
                <button title="Rename" aria-label={`Rename ${entry.name}`} onClick={() => startRename(entry.name)}><Pencil size={14} /></button>
                <button title="Move" aria-label={`Move ${entry.name}`} onClick={() => setMoving([{ name: entry.name, isDirectory: entry.isDirectory, path: childPath(segments, entry.name) }])}><FolderInput size={14} /></button>
                <button title="Reveal in Explorer" aria-label={`Reveal ${entry.name}`} onClick={() => reveal(entry.name)}><ArrowUpRight size={14} /></button>
                <button className="explorer-remove" title="Move to Recycle Bin" aria-label={`Delete ${entry.name}`} onClick={() => { void requestDelete(entry.name) }}><Trash2 size={14} /></button>
              </span>
            </div>
          )
        })}
      </div>

      {filtered.length > 0 && (
        <div className="pagination-bar">
          <span className="pagination-count">{filtered.length} {plural(filtered.length, 'item')}</span>
          <label className="pagination-size">Rows
            <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }} aria-label="Rows per page">
              <option value={10}>10</option><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option>
            </select>
          </label>
          <div className="pagination-controls">
            <button className="pagination-button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label="Previous page"><ChevronLeft size={15} /></button>
            <span className="pagination-page">Page {safePage} of {totalPages}</span>
            <button className="pagination-button" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} aria-label="Next page"><ChevronRight size={15} /></button>
          </div>
        </div>
      )}

      {dragging && <div className="explorer-drag-hint" role="status"><FolderInput size={14} /> Drop on a folder or breadcrumb to move {dragCount} {plural(dragCount, 'item')}</div>}

      {moving && <MoveDialog targets={moving} bridge={bridge!} onCancel={() => setMoving(null)} onMoved={(message) => { setMoving(null); clearSelection(); onNotify?.(message); void reload(segments) }} />}
    </section>
  )
}

function MoveDialog({ targets, bridge, onCancel, onMoved }: {
  targets: MoveTarget[]
  bridge: NonNullable<Window['uniteDrive']>
  onCancel: () => void
  onMoved: (message: string) => void
}) {
  const [segments, setSegments] = useState<string[]>([])
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [moveError, setMoveError] = useState('')
  const busyRef = useRef(false)

  const currentPath = pathLabel(segments)
  const heading = targets.length === 1 ? `Move "${targets[0].name}"` : `Move ${targets.length} items`

  useEffect(() => {
    let active = true
    bridge.listDirectory(currentPath).then((list) => {
      if (!active) return
      const folders = list.filter((entry) => entry.isDirectory)
      setEntries(folders)
      setError('')
      setLoading(false)
    }).catch((cause) => {
      if (!active) return
      setError(cause instanceof Error ? cause.message : 'Could not load folders.')
      setLoading(false)
    })
    return () => { active = false }
  }, [bridge, currentPath])

  const pendingMoves: MoveRequest[] = targets
    .map((target) => ({ from: target.path, to: currentPath ? `${currentPath}/${target.name}` : target.name }))
    .filter((move) => move.from !== move.to)

  const moveHere = () => {
    // Guard against a duplicate submit (e.g. a double-click) racing the first
    // move: the first call relocates the file, so a second would find no source.
    if (busyRef.current || !pendingMoves.length) return
    busyRef.current = true
    setBusy(true)
    setMoveError('')
    void (async () => {
      try {
        const result = await bridge.movePaths(pendingMoves)
        const moved = result.moved.length
        const failed = result.errors.length
        if (!moved && failed) {
          busyRef.current = false
          setBusy(false)
          setMoveError(result.errors[0].message)
          return
        }
        const destination = currentPath || 'Unite Drive'
        const base = `Moved ${moved} ${plural(moved, 'item')} to "${destination}".`
        onMoved(failed ? `${base} ${failed} could not be moved.` : base)
      } catch (cause) {
        busyRef.current = false
        setBusy(false)
        setMoveError(cause instanceof Error ? cause.message : 'The move failed.')
      }
    })()
  }

  const goUp = () => {
    if (segments.length) setSegments(segments.slice(0, -1))
  }

  const crumbSegments = [
    { label: 'Unite Drive', segments: [] as string[] },
    ...segments.map((segment, index) => ({ label: segment, segments: segments.slice(0, index + 1) })),
  ]

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <section className="connect-modal move-modal" role="dialog" aria-modal="true" aria-labelledby="move-heading">
        <button className="modal-close" aria-label="Close dialog" onClick={onCancel}><X size={17} /></button>
        <span className="modal-icon"><FolderInput size={20} /></span>
        <p className="eyebrow">MOVE</p>
        <h2 id="move-heading">{heading}</h2>
        <p className="modal-copy">Choose a destination folder inside your synced Unite Drive folder.</p>

        <div className="explorer-breadcrumb move-crumbs" aria-label="Choose destination">
          {crumbSegments.map((crumb, index) => (
            <span className="explorer-crumb" key={`${crumb.label}-${index}`}>
              {index > 0 && <ChevronRight size={14} className="explorer-crumb-chevron" />}
              <button className={`explorer-crumb-button ${index === crumbSegments.length - 1 ? 'active' : ''}`} onClick={() => setSegments(crumb.segments)}>{crumb.label}</button>
            </span>
          ))}
        </div>

        {segments.length > 0 && <button className="text-button" onClick={goUp}><ArrowUp size={14} /> Up one level</button>}

        <div className="move-folder-list">
          {loading ? <div className="empty-files">Loading folders…</div>
            : error ? <div className="explorer-error"><AlertTriangle size={16} /><span>{error}</span></div>
            : entries.length === 0 ? <div className="empty-files">No subfolders here.</div>
            : entries.map((entry) => (
              <button className="move-folder-row" key={entry.name} onClick={() => setSegments([...segments, entry.name])}>
                <Folder size={16} />{entry.name}<ChevronRight size={14} className="move-folder-chevron" />
              </button>
            ))}
        </div>

        <div className="modal-confirm-actions">
          <button className="button button-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="button button-primary" onClick={moveHere} disabled={!pendingMoves.length || busy}>{busy ? 'Moving…' : 'Move here'}</button>
        </div>
        {moveError && <div className="explorer-error move-error"><AlertTriangle size={16} /><span>{moveError}</span></div>}
        <span className="modal-footnote"><ChevronRight size={13} /> Pick a folder (or the root) and press "Move here".</span>
      </section>
    </div>
  )
}
