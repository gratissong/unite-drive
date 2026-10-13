import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Cloud,
  CloudUpload,
  Download,
  File,
  FileArchive,
  FileImage,
  FileText,
  FolderOpen,
  HardDrive,
  Info,
  LayoutDashboard,
  Plus,
  Power,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import './Design.css'
import GoogleConnectionControls from './GoogleConnectionControls'
import SyncPolicyControls from './SyncPolicyControls'
import DedupeReport from './DedupeReport'
import { buildDuplicateGroups, type DuplicateGroup } from './dedup'
import SimilarReport from './SimilarReport'
import { demoSimilarGroups, mapSimilarGroups, type SimilarGroup } from './similar'
import ExplorerTab from './ExplorerTab'

type ConflictPolicy = 'keep-both' | 'prefer-local' | 'prefer-remote'
type DeletionPolicy = 'propagate-to-trash' | 'keep-other-copy'

type DriveAccount = {
  id: string
  name: string
  email: string
  used: number
  quota: number
  color: string
  initials: string
  connected?: boolean
  readWriteAccess?: boolean
}

type RoutedFile = {
  name: string
  size?: number
  account: string
  time: string
  path?: string
  preview?: boolean
}

type FolderSearchEntry = {
  name: string
  isDirectory: boolean
  size: number | null
  mtime: string | null
  accountEmail?: string | null
  syncState?: string | null
  relativePath: string
  parentPath: string
}

type SyncOperation = {
  id: string
  kind: string
  relative_path: string
  account_id: string | null
  drive_file_id: string | null
  state: string
  attempts: number
  next_attempt_at: string
  last_error: string | null
  created_at: string
  updated_at: string
}

type Page = 'Overview' | 'Files' | 'Explorer' | 'Transfers' | 'Storage' | 'Accounts' | 'Settings'

type NotificationKind = 'info' | 'success' | 'warning' | 'error'

type AppNotification = {
  id: number
  kind: NotificationKind
  title: string
  message: string
  time: Date
  read: boolean
  action?: 'reconnect'
}

const defaultNotifTitle: Record<NotificationKind, string> = {
  info: 'Info',
  success: 'Success',
  warning: 'Heads up',
  error: 'Something went wrong',
}

const gib = 1024 ** 3
const tib = 1024 ** 4

const initialAccounts: DriveAccount[] = [
  { id: 'work', name: 'Work Drive', email: 'work.account@example.com', used: 1.28 * tib, quota: 2 * tib, color: 'mint', initials: 'W', readWriteAccess: true },
  { id: 'personal', name: 'Personal', email: 'personal.account@example.com', used: 13.2 * gib, quota: 15 * gib, color: 'coral', initials: 'P', readWriteAccess: true },
  { id: 'archive', name: 'Archive', email: 'archive.account@example.com', used: 82 * gib, quota: 200 * gib, color: 'blue', initials: 'A', readWriteAccess: true },
  { id: 'family', name: 'Family storage', email: 'family.account@example.com', used: 455 * gib, quota: 2 * tib, color: 'gold', initials: 'F', readWriteAccess: true },
]

const recentFiles: RoutedFile[] = [
  { name: 'Brand refresh final.fig', size: 248 * 1024 ** 2, account: 'Work Drive', time: 'Today, 10:42 AM' },
  { name: 'Japan trip — originals.zip', size: 6.4 * gib, account: 'Family storage', time: 'Today, 9:18 AM' },
  { name: 'Q3 campaign assets', size: 1.8 * gib, account: 'Archive', time: 'Yesterday, 4:06 PM' },
  { name: 'Receipts 2024.pdf', size: 18 * 1024 ** 2, account: 'Personal', time: 'Yesterday, 1:32 PM' },
]

const demoDuplicateGroups: DuplicateGroup[] = [
  {
    sizeBytes: 6.4 * gib,
    count: 2,
    wasteBytes: 6.4 * gib,
    keeperPath: 'Backup/Japan trip — originals.zip',
    files: [
      { path: 'Photos/Japan trip — originals.zip', accountId: 'personal', accountEmail: 'personal.account@example.com' },
      { path: 'Backup/Japan trip — originals.zip', accountId: 'archive', accountEmail: 'archive.account@example.com' },
    ],
  },
  {
    sizeBytes: 1.8 * gib,
    count: 3,
    wasteBytes: 3.6 * gib,
    keeperPath: 'Work/Q3 campaign assets',
    files: [
      { path: 'Work/Q3 campaign assets', accountId: 'work', accountEmail: 'work.account@example.com' },
      { path: 'Archive/old/Q3 campaign assets', accountId: 'archive', accountEmail: 'archive.account@example.com' },
      { path: 'Personal/misc/Q3 campaign assets', accountId: 'personal', accountEmail: 'personal.account@example.com' },
    ],
  },
]

const navigation: { label: Page; icon: typeof LayoutDashboard }[] = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'Files', icon: File },
  { label: 'Explorer', icon: FolderOpen },
  { label: 'Transfers', icon: Activity },
  { label: 'Storage', icon: HardDrive },
  { label: 'Accounts', icon: Users },
]

function formatBytes(bytes: number) {
  if (bytes >= tib) return `${(bytes / tib).toFixed(1)} TB`
  if (bytes >= gib) return `${(bytes / gib).toFixed(bytes / gib < 10 ? 1 : 0)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function percentUsed(account: DriveAccount) {
  if (!account.quota) return 0
  return Math.min(100, Math.round((account.used / account.quota) * 100))
}

function fileCategory(name: string) {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'fig'].includes(extension)) return 'image'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) return 'archive'
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'xls', 'xlsx', 'csv', 'ppt', 'pptx'].includes(extension)) return 'document'
  return 'other'
}

function formatRelativeTime(date: Date, reference = Date.now()) {
  const seconds = Math.round((reference - date.getTime()) / 1000)
  if (seconds < 60) return 'Just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fileKindIcon(name: string) {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (['zip', 'rar', '7z'].includes(extension)) return <FileArchive size={16} />
  if (['jpg', 'jpeg', 'png', 'fig'].includes(extension)) return <FileImage size={16} />
  if (['pdf', 'doc', 'txt'].includes(extension)) return <FileText size={16} />
  return <File size={16} />
}

function driveColorClass(account: string) {
  if (account === 'Work Drive') return 'mint'
  if (account === 'Archive') return 'blue'
  if (account === 'Personal') return 'coral'
  return 'gold'
}

const operationLabels: Record<string, string> = {
  upload: 'Upload',
  download: 'Download',
  'rename-remote': 'Rename on Drive',
  'trash-local': 'Delete local copy',
  'trash-remote': 'Move to Drive trash',
  'restore-local': 'Restore local copy',
  'restore-remote': 'Restore on Drive',
  'keep-both': 'Keep both copies',
}

const operationStateLabels: Record<string, string> = {
  queued: 'Queued',
  running: 'Transferring',
  retry: 'Retrying',
  failed: 'Failed',
  completed: 'Done',
}

function operationIcon(kind: string) {
  if (kind === 'upload') return <CloudUpload size={15} />
  if (kind === 'download') return <Download size={15} />
  if (kind === 'trash-local' || kind === 'trash-remote') return <Trash2 size={15} />
  if (kind === 'restore-local' || kind === 'restore-remote') return <RefreshCw size={15} />
  return <File size={15} />
}

function nameInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'LU'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

function App() {
  const [page, setPage] = useState<Page>('Overview')
  const [accounts, setAccounts] = useState(initialAccounts)
  const [isDemoData, setIsDemoData] = useState(!window.uniteDrive)
  const [files, setFiles] = useState(window.uniteDrive ? [] : recentFiles)
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>(demoDuplicateGroups)
  const [applyingDedupe, setApplyingDedupe] = useState(false)
  const [storageView, setStorageView] = useState<'duplicates' | 'similar'>('duplicates')
  const [similarGroups, setSimilarGroups] = useState<SimilarGroup[]>(demoSimilarGroups)
  const [similarLoading, setSimilarLoading] = useState(false)
  const [similarError, setSimilarError] = useState('')
  const [autoRoute, setAutoRoute] = useState(true)
  const [preferredAccountId, setPreferredAccountId] = useState<string | null>(null)
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  const [userName, setUserName] = useState('')
  const [userAvatar, setUserAvatar] = useState<string | null>(null)
  const [reserve, setReserve] = useState(5)
  const [toast, setToast] = useState('')
  const [accountToRemove, setAccountToRemove] = useState<DriveAccount | null>(null)
  const [removingAccount, setRemovingAccount] = useState(false)
  const [menu, setMenu] = useState<'workspace' | 'profile' | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchActive, setSearchActive] = useState(0)
  const [search, setSearch] = useState('')
  const [searchScope, setSearchScope] = useState<'drives' | 'folder'>('drives')
  const [paletteQuery, setPaletteQuery] = useState('')
  const [folderSearch, setFolderSearch] = useState<{ query: string; state: 'idle' | 'loading' | 'error'; items: FolderSearchEntry[] }>({ query: '', state: 'idle', items: [] })
  const [explorerFocus, setExplorerFocus] = useState<{ path: string; nonce: number } | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterDrive, setFilterDrive] = useState('all')
  const [filterType, setFilterType] = useState<'all' | 'image' | 'archive' | 'document' | 'other'>('all')
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null)
  const [transferRange, setTransferRange] = useState<'24h' | '7d' | '30d' | 'all'>('7d')
  const [filesPage, setFilesPage] = useState(1)
  const [filesPageSize, setFilesPageSize] = useState(25)
  const [transfersPage, setTransfersPage] = useState(1)
  const [transfersPageSize, setTransfersPageSize] = useState(10)
  const [operations, setOperations] = useState<SyncOperation[]>([])
  const [pendingOperations, setPendingOperations] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [syncFolder, setSyncFolder] = useState<string | null>(null)
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>('keep-both')
  const [deletionPolicy, setDeletionPolicy] = useState<DeletionPolicy>('propagate-to-trash')
  const [googleClientId, setGoogleClientId] = useState('')
  const [hasOAuthSecret, setHasOAuthSecret] = useState(false)
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [syncStatus, setSyncStatus] = useState('paused')
  const [connectionStatus, setConnectionStatus] = useState('')
  const [manifestRevision, setManifestRevision] = useState(0)
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [notifOpen, setNotifOpen] = useState(false)
  const notifIdRef = useRef(0)
  const warnedReadAccessRef = useRef<Set<string>>(new Set())

  const notify = useCallback((kind: NotificationKind, message: string, title?: string, action?: AppNotification['action']) => {
    const id = ++notifIdRef.current
    setNotifications((current) => [{ id, kind, title: title ?? defaultNotifTitle[kind], message, time: new Date(), read: false, action }, ...current].slice(0, 100))
    setToast(message)
  }, [])

  const notifyInfo = useCallback((message: string) => notify('info', message), [notify])

  function markAllNotificationsRead() {
    setNotifications((current) => current.map((item) => ({ ...item, read: true })))
  }

  function dismissNotification(id: number) {
    setNotifications((current) => current.filter((item) => item.id !== id))
  }

  function clearNotifications() {
    setNotifications([])
  }

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 4200)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchActive(0)
        setSearchOpen((open) => !open)
      } else if (event.key === 'Escape') {
        setSearchOpen(false)
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [])

  // Debounced search of the local sync folder when the palette is in "This folder" mode.
  useEffect(() => {
    if (!searchOpen || searchScope !== 'folder') return
    const bridge = window.uniteDrive
    const query = paletteQuery.trim()
    if (!bridge || !query) return
    let active = true
    const timer = window.setTimeout(() => {
      setFolderSearch({ query, state: 'loading', items: [] })
      bridge.searchFolder(query).then((list) => {
        if (!active) return
        setFolderSearch({ query, state: 'idle', items: list })
      }).catch(() => {
        if (!active) return
        setFolderSearch({ query, state: 'error', items: [] })
      })
    }, 180)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [searchOpen, searchScope, paletteQuery])

  useEffect(() => {
    if (!window.uniteDrive || page !== 'Transfers') return
    const timer = window.setInterval(() => setManifestRevision((revision) => revision + 1), 2000)
    return () => window.clearInterval(timer)
  }, [page])

  useEffect(() => {
    let active = true
    window.uniteDrive?.getSyncSettings().then((settings) => {
      if (!active) return
      setSyncFolder(settings.folderPath)
      setConflictPolicy(settings.conflictPolicy)
      setDeletionPolicy(settings.deletionPolicy)
      setGoogleClientId(settings.googleClientId)
      setSyncEnabled(settings.syncEnabled)
      setReserve(settings.storageReservePercent)
      setAutoRoute(settings.autoRoute)
      setPreferredAccountId(settings.preferredAccountId)
      setLaunchAtLogin(settings.launchAtLogin)
    }).catch(() => notify('error', 'Could not load saved sync settings.'))
    return () => { active = false }
  }, [notify])

  useEffect(() => {
    let active = true
    window.uniteDrive?.getUserInfo?.().then((info) => {
      if (!active) return
      setUserName(info.name)
      setUserAvatar(info.avatar ?? null)
    }).catch(() => {})
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    window.uniteDrive?.getOAuthConfigStatus().then((status) => {
      if (!active) return
      setGoogleClientId(status.clientId)
      setHasOAuthSecret(status.hasClientSecret)
    }).catch(() => setConnectionStatus('Could not load saved Google OAuth configuration.'))
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!window.uniteDrive) return
    let active = true
    window.uniteDrive.getDriveAccounts().then((driveAccounts) => {
      if (!active) return
      const colors = ['mint', 'coral', 'blue', 'gold'] as const
      setAccounts(driveAccounts.map((account, index) => ({
        id: account.id,
        name: account.email.split('@')[0],
        email: account.email,
        used: account.usedBytes,
        quota: account.limitBytes ?? 0,
        color: colors[index % colors.length],
        initials: account.email.charAt(0).toUpperCase(),
        connected: account.connected,
        readWriteAccess: account.readWriteAccess ?? true,
      })))
      setLastCheckedAt(new Date())
      setIsDemoData(false)
    }).catch(() => notify('error', 'Could not load connected Google accounts.'))
    return () => { active = false }
  }, [notify])

  useEffect(() => {
    for (const account of accounts) {
      if (account.connected && account.readWriteAccess === false && !warnedReadAccessRef.current.has(account.id)) {
        warnedReadAccessRef.current.add(account.id)
        notify('warning', `Reconnect ${account.email} to read and sync files that were added outside Unite Drive.`, 'Two-way sync needs reconnect', 'reconnect')
      }
    }
  }, [accounts, notify])

  useEffect(() => window.uniteDrive?.onSyncStatus((status) => {
    setSyncStatus(status.status)
    if (status.message && ['connecting', 'connected'].includes(status.status)) setConnectionStatus(status.message)
    if (status.status === 'error' && status.message) notify('error', status.message)
    if (status.status === 'retrying' && status.message) notify('warning', status.message)
    if (status.status === 'connected' && status.message) notify('success', status.message, 'Drive connected')
    if (['idle', 'retrying', 'error'].includes(status.status)) setManifestRevision((revision) => revision + 1)
    if (['idle', 'connected'].includes(status.status)) setLastCheckedAt(new Date())
  }), [notify])

  useEffect(() => window.uniteDrive?.onSettingsChanged?.((settings) => {
    setSyncFolder(settings.folderPath)
    setConflictPolicy(settings.conflictPolicy)
    setDeletionPolicy(settings.deletionPolicy)
    setSyncEnabled(settings.syncEnabled)
    setReserve(settings.storageReservePercent)
    setAutoRoute(settings.autoRoute)
    setPreferredAccountId(settings.preferredAccountId)
    setLaunchAtLogin(settings.launchAtLogin)
  }), [])

  useEffect(() => {
    const bridge = window.uniteDrive
    if (!bridge || !['Overview', 'Files', 'Transfers', 'Storage'].includes(page)) return
    let active = true
    bridge.getSyncState().then((snapshot) => {
      if (!active) return
      const accountsById = new Map(snapshot.accounts.map((account) => [account.id, account.email]))
      const freeById = new Map(accounts.map((account) => [account.id, account.quota - account.used]))
      setDuplicateGroups(buildDuplicateGroups(snapshot.files, accountsById, freeById))
      setFiles(snapshot.files
        .filter((file) => !['forgotten', 'tombstone'].includes(file.sync_state))
        .map((file) => ({
          name: file.relative_path.split('/').at(-1) || file.relative_path,
          path: file.relative_path,
          size: file.size_bytes ?? undefined,
          account: file.account_id ? accountsById.get(file.account_id) ?? 'Drive account' : 'Pending route',
          time: file.local_modified_at ?? file.remote_modified_at ?? 'In sync',
        })))
      setOperations(snapshot.operations)
      setPendingOperations(snapshot.operations.filter((operation) => ['queued', 'running', 'retry', 'failed'].includes(operation.state)).length)
      setIsDemoData(false)
      if (page === 'Storage' && storageView === 'similar') {
        setSimilarLoading(true)
        setSimilarError('')
        bridge.getSimilarGroups().then((raw) => {
          if (active) {
            setSimilarGroups(mapSimilarGroups(raw ?? [], accountsById))
            setSimilarLoading(false)
          }
        }).catch(() => {
          if (active) {
            setSimilarGroups([])
            setSimilarLoading(false)
            setSimilarError('The photos could not be scanned for similarity.')
          }
        })
      }
    }).catch(() => {
      if (active) notify('error', 'Could not load the local sync manifest.')
    })
    return () => { active = false }
  }, [page, manifestRevision, storageView, notify, accounts])

  const totalUsed = accounts.reduce((total, account) => total + account.used, 0)
  const totalQuota = accounts.reduce((total, account) => total + account.quota, 0)
  const totalFree = totalQuota - totalUsed
  const profileStatus = accounts.length
    ? `${accounts.length} drive${accounts.length === 1 ? '' : 's'} · ${formatBytes(totalQuota)} pooled`
    : 'No drives connected'
  const avatarNode = userAvatar
    ? <img className="profile-avatar-img" src={userAvatar} alt="" />
    : nameInitials(userName || 'Local user')
  const pageCopy: Record<Page, string> = {
    Overview: 'Your cloud, in one place.',
    Files: 'Find where everything lives.',
    Explorer: 'Browse and manage your local sync folder.',
    Transfers: 'A clear view of every move.',
    Storage: 'Reclaim space from duplicate files.',
    Accounts: 'Your connected storage accounts.',
    Settings: 'Set the rules for your cloud.',
  }

  function previewFiles(fileList: FileList | null) {
    if (!fileList?.length) return
    if (!accounts.length) {
      notify('warning', 'Connect a Google Drive account before routing files.')
      return
    }
    if (!autoRoute && !preferredAccountId) {
      notify('warning', 'Auto-routing is off. Pick a default drive in Settings to preview destinations.')
      return
    }
    const freeFloor = (account: DriveAccount) => account.quota * (reserve / 100)
    let updatedAccounts = [...accounts]
    const routed: RoutedFile[] = []
    const rejected: string[] = []

    Array.from(fileList).forEach((file) => {
      const destination = updatedAccounts
        .filter((account) => account.quota - account.used - freeFloor(account) >= file.size)
        .sort((first, second) => {
          if (!autoRoute && preferredAccountId) {
            if (first.id === preferredAccountId) return -1
            if (second.id === preferredAccountId) return 1
          }
          return (second.quota - second.used) - (first.quota - first.used)
        })[0]

      if (!destination) {
        rejected.push(file.name)
        return
      }

      routed.push({ name: file.name, size: file.size, account: destination.name, time: 'Route preview', preview: true })
      updatedAccounts = updatedAccounts.map((account) =>
        account.id === destination.id ? { ...account, used: account.used + file.size } : account,
      )
    })

    if (routed.length) {
      setFiles((current) => [...routed.reverse(), ...current].slice(0, 12))
      notify('success', `${routed.length} file${routed.length === 1 ? '' : 's'} could fit. Preview only; nothing was uploaded.`)
    }
    if (rejected.length) {
      notify('warning', `${rejected.length} file${rejected.length === 1 ? '' : 's'} exceed available space or the reserve.`)
    }
  }

  async function chooseSyncFolder() {
    if (!window.uniteDrive) {
      notify('info', 'Choose a local folder from the Windows desktop app.')
      return
    }
    const folder = await window.uniteDrive.selectSyncFolder()
    if (!folder) return
    try {
      const settings = await window.uniteDrive.updateSyncSettings({ folderPath: folder })
      setSyncFolder(settings.folderPath)
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Could not save the selected sync folder.')
    }
  }

  async function openSyncFolder() {
    if (!window.uniteDrive) {
      notify('info', 'Opening the sync folder is available in the Windows desktop app.')
      return
    }
    try {
      await window.uniteDrive.openSyncFolder()
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Could not open the local sync folder.')
    }
  }

  async function importOAuthConfig() {
    if (!window.uniteDrive) {
      setConnectionStatus('Import a Desktop OAuth JSON from the Windows app.')
      return
    }
    try {
      const config = await window.uniteDrive.importOAuthConfig()
      if (!config) return
      setGoogleClientId(config.clientId)
      setHasOAuthSecret(config.hasClientSecret)
      setConnectionStatus('Desktop OAuth credentials imported and encrypted on this device.')
    } catch (error) {
      setConnectionStatus(error instanceof Error ? error.message : 'Could not import Desktop OAuth credentials.')
    }
  }

  async function refreshDriveAccounts() {
    if (!window.uniteDrive) return
    const driveAccounts = await window.uniteDrive.getDriveAccounts()
    const colors = ['mint', 'coral', 'blue', 'gold'] as const
    setAccounts(driveAccounts.map((account, index) => ({
      id: account.id,
      name: account.email.split('@')[0],
      email: account.email,
      used: account.usedBytes,
      quota: account.limitBytes ?? 0,
      color: colors[index % colors.length],
      initials: account.email.charAt(0).toUpperCase(),
      connected: account.connected,
      readWriteAccess: account.readWriteAccess ?? true,
    })))
    setIsDemoData(false)
  }

  async function connectGoogleAccount() {
    if (!window.uniteDrive) {
      notify('info', 'Google account sign-in is available in the Windows desktop app.')
      return
    }
    if (!googleClientId.trim() || !hasOAuthSecret) {
      setPage('Settings')
      setConnectionStatus('Import the Google Desktop OAuth credentials JSON in Settings first.')
      notify('warning', 'Import the Google Desktop OAuth credentials JSON in Settings first.')
      return
    }
    setConnectionStatus('Opening Google sign-in in your browser...')
    try {
      const account = await window.uniteDrive.connectGoogleAccount()
      await refreshDriveAccounts()
      setConnectionStatus(`Connected ${account.email}.`)
      notify('success', `Connected ${account.email}.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Google sign-in failed.'
      setConnectionStatus(message)
      notify('error', message)
    }
  }

  async function removeGoogleAccount() {
    const account = accountToRemove
    if (!account) return
    if (!window.uniteDrive) {
      notify('info', 'Removing an account is available in the Windows desktop app.')
      return
    }
    setRemovingAccount(true)
    try {
      await window.uniteDrive.removeGoogleAccount(account.id)
      if (preferredAccountId === account.id) await updatePreferredAccount('')
      setAccountToRemove(null)
      await refreshDriveAccounts()
      notify('success', `Removed ${account.email}. Its files stay in Google Drive.`)
    } catch (error) {
      setAccountToRemove(null)
      notify('error', error instanceof Error ? error.message : 'Could not remove the account.')
    } finally {
      setRemovingAccount(false)
    }
  }

  async function updateSyncEnabled(enabled: boolean) {
    setSyncEnabled(enabled)
    try {
      await window.uniteDrive?.updateSyncSettings({ syncEnabled: enabled })
    } catch {
      setSyncEnabled(!enabled)
      notify('error', 'Could not update sync status.')
    }
  }

  async function updateReserve(value: number) {
    const next = Math.max(0, Math.min(50, Math.round(value)))
    setReserve(next)
    try {
      await window.uniteDrive?.updateSyncSettings({ storageReservePercent: next })
    } catch {
      notify('error', 'Could not save the storage reserve.')
    }
  }

  async function updateAutoRoute(enabled: boolean) {
    setAutoRoute(enabled)
    try {
      await window.uniteDrive?.updateSyncSettings({ autoRoute: enabled })
    } catch {
      setAutoRoute(!enabled)
      notify('error', 'Could not save the routing preference.')
    }
  }

  async function updatePreferredAccount(value: string) {
    const next = value || null
    const previous = preferredAccountId
    setPreferredAccountId(next)
    try {
      await window.uniteDrive?.updateSyncSettings({ preferredAccountId: next })
    } catch {
      setPreferredAccountId(previous)
      notify('error', 'Could not save the default drive.')
    }
  }

  async function updateLaunchAtLogin(enabled: boolean) {
    setLaunchAtLogin(enabled)
    try {
      await window.uniteDrive?.updateSyncSettings({ launchAtLogin: enabled })
    } catch {
      setLaunchAtLogin(!enabled)
      notify('error', 'Could not save the launch at login preference.')
    }
  }

  async function syncNow() {
    if (!window.uniteDrive) {
      notify('info', 'Sample storage figures refreshed.')
      setLastCheckedAt(new Date())
      return
    }
    try {
      await window.uniteDrive.syncNow()
      await refreshDriveAccounts()
      setLastCheckedAt(new Date())
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Sync could not start.')
    }
  }

  async function addFiles() {
    if (!window.uniteDrive) {
      document.getElementById('local-file-input')?.click()
      return
    }
    try {
      const result = await window.uniteDrive.addFiles()
      const details = [
        result.imported ? `${result.imported} added to the synced folder` : '',
        result.skipped.length ? `${result.skipped.length} skipped because the name already exists` : '',
        result.errors.length ? `${result.errors.length} could not be added` : '',
      ].filter(Boolean)
      if (result.imported) setLastCheckedAt(new Date())
      notify('info', details.join('. ') || 'No files selected.')
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Could not add files to the sync folder.')
    }
  }

  async function applyDedupe(removals: Array<{ relativePath: string }>) {
    if (!window.uniteDrive) { notify('info', 'Duplicate cleanup is available in the Windows desktop app.'); return }
    setApplyingDedupe(true)
    try {
      const result = await window.uniteDrive.applyDedupe(removals)
      await refreshDriveAccounts()
      if (result.removed.length) notify('success', `Removed ${result.removed.length} duplicate cop${result.removed.length === 1 ? 'y' : 'ies'}. The keeper stays; everything moved to the trash.`)
      if (result.errors.length) notify('warning', `${result.errors.length} cop${result.errors.length === 1 ? 'y' : 'ies'} could not be removed. The failed copies were left as they were.`)
      setManifestRevision((revision) => revision + 1)
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Could not remove duplicate copies.')
    } finally {
      setApplyingDedupe(false)
    }
  }

  async function resetSyncState() {
    if (!window.uniteDrive) {
      notify('info', 'Sync state reset is available in the Windows desktop app.')
      return
    }
    if (!window.confirm('Clear local sync mappings and queued work? Files in Google Drive will not be deleted.')) return
    try {
      await window.uniteDrive.resetSyncState()
      notify('success', 'Local sync state reset. Drive files were left unchanged.')
    } catch {
      notify('error', 'Could not reset local sync state.')
    }
  }

  async function cancelOperation(operation: SyncOperation) {
    if (!window.uniteDrive) return
    const name = operation.relative_path.split('/').at(-1) || operation.relative_path
    try {
      const result = await window.uniteDrive.cancelOperation(operation.id)
      notify('info', result.cancelled ? `Cancelled the transfer of ${name}.` : 'That transfer was already cleared.')
      setManifestRevision((revision) => revision + 1)
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Could not cancel that transfer.')
    }
  }

  async function clearCompletedOperations() {
    if (!window.uniteDrive) return
    try {
      const result = await window.uniteDrive.clearCompletedOperations()
      notify('info', result.removed ? `Cleared ${result.removed} completed transfer${result.removed === 1 ? '' : 's'} from the queue.` : 'No completed transfers to clear.')
      setManifestRevision((revision) => revision + 1)
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Could not clear completed transfers.')
    }
  }

  async function updateConflictPolicy(policy: ConflictPolicy) {
    setConflictPolicy(policy)
    try {
      await window.uniteDrive?.updateSyncSettings({ conflictPolicy: policy })
    } catch {
      notify('error', 'Could not save the conflict policy.')
    }
  }

  async function updateDeletionPolicy(policy: DeletionPolicy) {
    setDeletionPolicy(policy)
    try {
      await window.uniteDrive?.updateSyncSettings({ deletionPolicy: policy })
    } catch {
      notify('error', 'Could not save the deletion policy.')
    }
  }

  const driveOptions = Array.from(new Set([...accounts.map((account) => account.email), ...files.map((item) => item.account)]))
  const activeFilterCount = (filterDrive !== 'all' ? 1 : 0) + (filterType !== 'all' ? 1 : 0)
  const filteredFiles = files.filter((item) => {
    if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterDrive !== 'all' && item.account !== filterDrive) return false
    if (filterType !== 'all' && fileCategory(item.name) !== filterType) return false
    return true
  })
  const filesTotalPages = Math.max(1, Math.ceil(filteredFiles.length / filesPageSize))
  const filesSafePage = Math.min(filesPage, filesTotalPages)
  const visibleFiles = filteredFiles.slice((filesSafePage - 1) * filesPageSize, filesSafePage * filesPageSize)
  const unreadCount = notifications.filter((item) => !item.read).length
  const todayLabel = new Date(now).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase()
  const rangeDays: Record<typeof transferRange, number> = { '24h': 1, '7d': 7, '30d': 30, all: Number.POSITIVE_INFINITY }
  const accountEmailById = new Map(accounts.map((account) => [account.id, account.email]))
  const accountColorById = new Map(accounts.map((account) => [account.id, account.color]))
  const operationTime = (operation: SyncOperation) => {
    const parsed = Date.parse(operation.updated_at || operation.created_at)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  const activeOperations = operations.filter((operation) => operation.state === 'queued' || operation.state === 'running')
  const retryOperations = operations.filter((operation) => operation.state === 'retry')
  const failedOperations = operations.filter((operation) => operation.state === 'failed')
  const completedOperations = operations
    .filter((operation) => operation.state === 'completed')
    .filter((operation) => transferRange === 'all' || now - operationTime(operation) <= rangeDays[transferRange] * 86_400_000)
    .sort((first, second) => operationTime(second) - operationTime(first))
    .slice(0, 20)
  const transfersTotalPages = Math.max(1, Math.ceil(completedOperations.length / transfersPageSize))
  const transfersSafePage = Math.min(transfersPage, transfersTotalPages)
  const pagedCompleted = completedOperations.slice((transfersSafePage - 1) * transfersPageSize, transfersSafePage * transfersPageSize)
  const transfersReady = accounts.length > 0 && Boolean(syncFolder)
  const transferTitle = !accounts.length ? 'No drives connected'
    : !syncFolder ? 'No local folder chosen'
    : syncStatus === 'syncing' ? 'Syncing files'
    : syncStatus === 'retrying' ? 'Retrying transfers'
    : syncStatus === 'error' ? 'Sync needs attention'
    : syncEnabled ? 'Sync is on'
    : 'Sync is paused'
  const transferMessage = !accounts.length ? 'Connect Google Drive to start routing and syncing files.'
    : !syncFolder ? 'Choose a local sync folder so transfers have somewhere to land.'
    : syncStatus === 'syncing' ? 'Moving changes between this device and your drives.'
    : syncStatus === 'retrying' ? 'Some items hit a temporary error and will retry automatically.'
    : syncStatus === 'error' ? 'Open the notification panel for details, then retry.'
    : syncEnabled ? 'Watching your local folder for changes.'
    : 'Turn on sync in Settings to keep this folder up to date.'
  const transferTone = syncStatus === 'error' ? 'error' : transfersReady ? 'active' : ''
  const paletteSearchQuery = paletteQuery.trim()
  const folderSearchState = !paletteSearchQuery ? 'idle' : (folderSearch.query === paletteSearchQuery ? folderSearch.state : 'loading')
  const folderResults = folderSearch.query === paletteSearchQuery ? folderSearch.items : []
  const driveMatches = paletteSearchQuery
    ? files.filter((item) => item.name.toLowerCase().includes(paletteSearchQuery.toLowerCase()) || (item.path ?? '').toLowerCase().includes(paletteSearchQuery.toLowerCase()))
    : files
  const driveResults = driveMatches.slice(0, 6)
  const activeResultCount = searchScope === 'folder' ? folderResults.length : driveResults.length
  const safeSearchActive = Math.min(searchActive, Math.max(activeResultCount - 1, 0))
  const paletteResultCount = searchScope === 'folder'
    ? folderResults.length
    : (paletteSearchQuery ? driveMatches.length : driveResults.length)

  function openExplorerResult(entry: FolderSearchEntry) {
    setExplorerFocus({ path: entry.relativePath, nonce: Date.now() })
    setSearchOpen(false)
    setPage('Explorer')
    setSearchActive(0)
  }

  function openFilesResults() {
    setSearch(paletteSearchQuery)
    setFilesPage(1)
    setSearchOpen(false)
    setPage('Files')
  }

  function openFilesUnfiltered() {
    setSearch('')
    setFilesPage(1)
    setSearchOpen(false)
    setPage('Files')
  }

  function activateSearchResult(index: number) {
    if (searchScope === 'folder') {
      const entry = folderResults[index]
      if (entry) openExplorerResult(entry)
      return
    }
    openFilesResults()
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSearchActive((index) => Math.min(index + 1, Math.max(activeResultCount - 1, 0)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSearchActive((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      activateSearchResult(safeSearchActive)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setSearchOpen(false)
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" onClick={(event) => { event.preventDefault(); setPage('Overview') }} title={`Unite Drive v${import.meta.env.VITE_APP_VERSION}`}>
          <span className="brand-mark"><Cloud size={18} strokeWidth={2.4} /></span>
          <span className="brand-text">unite<span className="brand-light">drive</span><span className="brand-version">v{import.meta.env.VITE_APP_VERSION}</span></span>
        </a>

        <div className="workspace-wrap">
          <button className="workspace-switcher" aria-haspopup="menu" aria-expanded={menu === 'workspace'} onClick={() => setMenu((current) => current === 'workspace' ? null : 'workspace')}>
            <span className="workspace-avatar">P</span>
            <span className="workspace-copy"><strong>Personal space</strong><small>{accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}</small></span>
            <ChevronDown size={15} />
          </button>
          {menu === 'workspace' && (
            <>
              <button className="menu-backdrop" aria-label="Close workspace menu" onClick={() => setMenu(null)} />
              <div className="app-menu" role="menu">
                <div className="app-menu-head"><span className="workspace-avatar">P</span><div><strong>Personal space</strong><small>{accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}</small></div><Check size={15} /></div>
                <button className="app-menu-item" role="menuitem" onClick={() => { setMenu(null); setPage('Accounts') }}><Users size={15} /> Manage accounts</button>
                <button className="app-menu-item" role="menuitem" onClick={() => { setMenu(null); void connectGoogleAccount() }}><Plus size={15} /> Connect a drive</button>
              </div>
            </>
          )}
        </div>

        <p className="nav-label">WORKSPACE</p>
        <nav className="primary-nav" aria-label="Main navigation">
          {navigation.map(({ label, icon: Icon }) => (
            <button className={`nav-item ${page === label ? 'active' : ''}`} key={label} onClick={() => { setPage(label); if (label === 'Files') setFilesPage(1); setExplorerFocus(null) }}>
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {label === 'Transfers' && pendingOperations > 0 && <span className="nav-count">{pendingOperations}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-accounts">
          <div className="sidebar-section-heading"><span>DRIVES</span><button aria-label="Connect a drive" onClick={connectGoogleAccount}><Plus size={15} /></button></div>
          {accounts.map((account) => (
            <button className="drive-nav-item" key={account.id} onClick={() => setPage('Accounts')}>
              <span className={`drive-dot ${account.color}`} />
              <span>{account.name}</span>
              <span className="drive-nav-free">{account.quota ? formatBytes(account.quota - account.used) : 'Unlimited'}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-bottom">
          <button className={`nav-item ${page === 'Settings' ? 'active' : ''}`} onClick={() => setPage('Settings')}>
            <Settings2 size={17} strokeWidth={1.8} /><span>Settings</span>
          </button>
          <div className="sidebar-profile">
            <span className="profile-avatar">{avatarNode}</span>
            <span className="workspace-copy"><strong>{userName || 'Local user'}</strong><small>{profileStatus}</small></span>
            <button aria-label="Help and quick start" onClick={() => setShowHelp(true)}><CircleHelp size={16} /></button>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>{page}</strong></div>
          <div className="topbar-actions">
            <span className="demo-pill"><span /> {isDemoData ? 'DEMO DATA' : 'LIVE ACCOUNTS'}</span>
            <span className="sync-indicator"><span className={`sync-dot ${syncStatus === 'idle' || syncStatus === 'connected' ? 'sync-active' : ''}`} /> {syncStatus === 'idle' ? syncEnabled ? 'Sync on' : 'Synced' : syncStatus === 'syncing' ? 'Syncing' : syncStatus === 'retrying' ? 'Retrying' : syncStatus === 'connecting' ? 'Connecting Drive' : syncStatus === 'connected' ? 'Drive connected' : syncStatus === 'error' ? 'Sync issue' : 'Sync paused'}</span>
            <button className="icon-button" aria-label="Search files" title="Search files (Ctrl+K)" aria-expanded={searchOpen} onClick={() => { setSearchActive(0); setSearchOpen(true) }}><Search size={17} /></button>
            <div className="notif-wrap">
              <button className="icon-button notif-button" aria-label="Notifications" aria-expanded={notifOpen} onClick={() => setNotifOpen((open) => !open)}>
                <Bell size={17} />
                {unreadCount > 0 && <span className="notif-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
              </button>
              {notifOpen && (
                <>
                  <button className="notif-backdrop" aria-label="Close notifications" onClick={() => setNotifOpen(false)} />
                  <aside className="notif-panel" role="dialog" aria-label="Notifications">
                    <div className="notif-header">
                      <div className="notif-title"><Bell size={15} /><strong>Notifications</strong><span className="notif-count">{notifications.length}</span></div>
                      <div className="notif-actions">
                        <button onClick={markAllNotificationsRead} disabled={!notifications.some((item) => !item.read)}>Mark all read</button>
                        <button aria-label="Clear all notifications" disabled={notifications.length === 0} onClick={clearNotifications}><Trash2 size={14} /></button>
                      </div>
                    </div>
                    <div className="notif-list">
                      {notifications.length === 0 ? (
                        <div className="notif-empty"><Bell size={20} /><p>No notifications yet.</p></div>
                      ) : notifications.map((item) => (
                        <article className={`notif-item ${item.kind} ${item.read ? 'read' : 'unread'}`} key={item.id}>
                          <span className="notif-icon">{item.kind === 'error' || item.kind === 'warning' ? <AlertTriangle size={14} /> : item.kind === 'success' ? <Check size={14} /> : <Info size={14} />}</span>
                          <div className="notif-body">
                            <p className="notif-item-title"><strong>{item.title}</strong><small>{formatRelativeTime(item.time)}</small></p>
                            <p className="notif-item-message">{item.message}</p>
                            {item.action === 'reconnect' && <button className="notif-action" onClick={() => { setNotifOpen(false); void connectGoogleAccount() }}>Reconnect now</button>}
                          </div>
                          <button className="notif-dismiss" aria-label="Dismiss notification" onClick={() => dismissNotification(item.id)}><X size={13} /></button>
                        </article>
                      ))}
                    </div>
                  </aside>
                </>
              )}
            </div>
            <div className="profile-wrap">
              <button className="profile-avatar top-profile" aria-label="Profile" aria-haspopup="menu" aria-expanded={menu === 'profile'} onClick={() => setMenu((current) => current === 'profile' ? null : 'profile')}>{avatarNode}</button>
              {menu === 'profile' && (
                <>
                  <button className="menu-backdrop" aria-label="Close profile menu" onClick={() => setMenu(null)} />
                  <div className="app-menu" role="menu">
                    <div className="app-menu-head"><span className="profile-avatar">{avatarNode}</span><div><strong>{userName || 'Local user'}</strong><small>{profileStatus}</small></div></div>
                    <button className="app-menu-item" role="menuitem" onClick={() => { setMenu(null); setPage('Accounts') }}><Users size={15} /> Manage accounts</button>
                    <button className="app-menu-item" role="menuitem" onClick={() => { setMenu(null); setPage('Settings') }}><Settings2 size={15} /> Settings</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        <div className="page-content">
          <section className="page-heading">
            <div>
              <p className="eyebrow">{todayLabel} <span className="eyebrow-divider">/</span> {page.toUpperCase()}</p>
              <h1>{page === 'Overview' ? 'Cloud overview' : page}</h1>
              <p className="page-subtitle">{pageCopy[page]}</p>
            </div>
            <div className="heading-actions">
              <span className="updated-label"><span className="updated-dot" /> Updated {lastCheckedAt ? formatRelativeTime(lastCheckedAt, now) : 'never'}</span>
              <button className="button button-secondary" onClick={syncNow}><RefreshCw size={15} /> Sync now</button>
              <button className="button button-primary" onClick={addFiles}><CloudUpload size={16} /> Add files</button>
              <input id="local-file-input" type="file" multiple hidden onChange={(event) => { previewFiles(event.target.files); event.target.value = '' }} />
            </div>
          </section>

          {page === 'Overview' && (
            <>
              <section className="summary-strip" aria-label="Combined storage summary">
                <div className="summary-primary">
                  <div className="summary-label"><span className="summary-icon"><HardDrive size={16} /></span> TOTAL STORAGE</div>
                  <div className="summary-value">{formatBytes(totalUsed)} <span>of {formatBytes(totalQuota)}</span></div>
                  <div className="summary-footnote">Across {accounts.length} connected drives</div>
                </div>
                <div className="summary-metric"><span className="metric-label">AVAILABLE</span><strong>{formatBytes(totalFree)}</strong><span className="metric-caption">Combined free space</span></div>
                <div className="summary-metric"><span className="metric-label">LOCAL FOLDER</span><strong className="local-status"><span className="status-hollow" /> {syncFolder ? 'Folder selected' : 'Not connected'}</strong><span className="metric-caption">{!syncFolder ? 'Choose a folder to sync' : syncStatus === 'syncing' ? 'Sync in progress' : syncStatus === 'retrying' ? 'Some items will retry' : syncStatus === 'error' ? 'Sync needs attention' : syncEnabled ? 'Continuous sync enabled' : syncStatus === 'idle' ? 'Manual sync complete' : 'Manual sync available'}</span></div>
                <div className="summary-metric last"><span className="metric-label">AUTO-ROUTING</span><strong className="routing-status"><span className="status-live" /> {autoRoute ? 'On' : 'Off'}</strong><span className="metric-caption">Space-aware destination</span></div>
              </section>

              <section className="storage-section">
                <div className="section-heading">
                  <div><h2>Storage by account</h2><p>Capacity and available space at a glance</p></div>
                  <button className="text-button" onClick={() => setPage('Accounts')}>View accounts <ArrowUpRight size={14} /></button>
                </div>
                <div className="storage-list">
                  {accounts.map((account) => {
                    const usedPercent = percentUsed(account)
                    const free = account.quota - account.used
                    return (
                      <article className="storage-row" key={account.id}>
                        <span className={`account-avatar ${account.color}`}>{account.initials}</span>
                        <div className="account-identity"><strong>{account.name}</strong><span>{account.email}</span></div>
                        <div className="capacity-wrap">
                          <div className="capacity-track"><span className={`capacity-fill ${account.color}`} style={{ width: `${usedPercent}%` }} /></div>
                          <div className="capacity-label"><span>{formatBytes(account.used)} used</span><span>{usedPercent}%</span></div>
                        </div>
                        <div className="available-space"><strong>{formatBytes(free)}</strong><span>free of {formatBytes(account.quota)}</span></div>
                        <span className={`account-health ${usedPercent >= 80 ? 'near-limit' : ''}`}>{usedPercent >= 80 ? 'Near limit' : 'Healthy'}</span>
                        <button className="row-more" aria-label={`Open ${account.name}`} onClick={() => setPage('Accounts')}><ArrowUpRight size={15} /></button>
                      </article>
                    )
                  })}
                </div>
                <div className="storage-footnote"><ShieldCheck size={14} /><span>Space totals are estimates from the latest account check.</span><span className="footnote-spacer" /><span className="legend-dot used" /> Used<span className="legend-dot free" /> Available</div>
              </section>

              <div className="lower-grid">
                <section className="files-section">
                  <div className="section-heading compact-heading">
                    <div><h2>Recently routed</h2><p>Latest files across your drives</p></div>
                    <button className="text-button" onClick={() => { setPage('Files'); setFilesPage(1) }}>All files <ArrowUpRight size={14} /></button>
                  </div>
                  <FileTable files={files.slice(0, 4)} />
                </section>

                <section className="routing-panel">
                  <div className="routing-panel-top"><span className="routing-icon"><Sparkles size={17} /></span><span className="panel-kicker">SMART ROUTING</span><button className="panel-settings" aria-label="Routing settings" onClick={() => setPage('Settings')}><SlidersHorizontal size={15} /></button></div>
                  <h2>Put every byte<br />in its right place.</h2>
                  <p>New files are matched to the drive with the most room, while keeping your reserve intact.</p>
                  <div className="rule-line"><span>Keep at least {reserve}% free on each drive</span><Check size={15} /></div>
                  <button className="routing-link" onClick={() => setPage('Settings')}>Adjust routing rules <ArrowUpRight size={14} /></button>
                </section>
              </div>
            </>
          )}

          {page === 'Files' && (
            <section className="table-page-section">
              <div className="table-toolbar"><div className="search-field"><Search size={16} /><input aria-label="Search files" placeholder="Search files" value={search} onChange={(event) => { setSearch(event.target.value); setFilesPage(1) }} /></div>
                <div className="filter-wrap">
                  <button className="button button-secondary" aria-expanded={filterOpen} onClick={() => setFilterOpen((open) => !open)}><SlidersHorizontal size={15} /> Filter{activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}</button>
                  {filterOpen && (
                    <>
                      <button className="filter-backdrop" aria-label="Close filters" onClick={() => setFilterOpen(false)} />
                      <div className="filter-panel" role="dialog" aria-label="Filter files">
                        <div className="filter-panel-head"><strong>Filter files</strong><button className="filter-clear" disabled={activeFilterCount === 0} onClick={() => { setFilterDrive('all'); setFilterType('all'); setFilesPage(1) }}>Clear all</button></div>
                        <label className="filter-field"><span>Drive</span><select value={filterDrive} onChange={(event) => { setFilterDrive(event.target.value); setFilesPage(1) }}><option value="all">All drives</option>{driveOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
                        <label className="filter-field"><span>File type</span><select value={filterType} onChange={(event) => { setFilterType(event.target.value as typeof filterType); setFilesPage(1) }}><option value="all">All types</option><option value="image">Images</option><option value="archive">Archives</option><option value="document">Documents</option><option value="other">Other</option></select></label>
                      </div>
                    </>
                  )}
                </div>
                <button className="button button-secondary" onClick={openSyncFolder} disabled={!syncFolder} title={syncFolder ? 'Open the local sync folder' : 'Choose a sync folder first'}><FolderOpen size={15} /> Local folder</button></div>
              <FileTable files={visibleFiles} expanded emptyMessage={search || activeFilterCount ? 'No matching files found.' : 'No synced files yet. Click Sync now to scan your connected Drive folders.'} />
              {filteredFiles.length > 0 && (
                <div className="pagination-bar">
                  <span className="pagination-count">{filteredFiles.length} file{filteredFiles.length === 1 ? '' : 's'}</span>
                  <label className="pagination-size">Rows
                    <select value={filesPageSize} onChange={(event) => { setFilesPageSize(Number(event.target.value)); setFilesPage(1) }} aria-label="Rows per page">
                      <option value={10}>10</option><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option>
                    </select>
                  </label>
                  <div className="pagination-controls">
                    <button className="pagination-button" disabled={filesSafePage <= 1} onClick={() => setFilesPage(filesSafePage - 1)} aria-label="Previous page"><ChevronLeft size={15} /></button>
                    <span className="pagination-page">Page {filesSafePage} of {filesTotalPages}</span>
                    <button className="pagination-button" disabled={filesSafePage >= filesTotalPages} onClick={() => setFilesPage(filesSafePage + 1)} aria-label="Next page"><ChevronRight size={15} /></button>
                  </div>
                </div>
              )}
              <div className="demo-notice"><CircleHelp size={15} /><span>{isDemoData ? 'These are sample records. File browsing and cloud downloads are not connected in this demo.' : 'File names and contents remain in the local sync folder; this view lists files recorded in the sync manifest.'}</span></div>
            </section>
          )}

          {page === 'Explorer' && (
            !syncFolder ? (
              <section className="table-page-section">
                <div className="empty-files">Choose a local sync folder before browsing it.</div>
                <div className="table-toolbar">
                  <button className="button button-primary" onClick={chooseSyncFolder}><FolderOpen size={16} /> Choose folder</button>
                </div>
              </section>
            ) : (
              <ExplorerTab key={explorerFocus?.nonce ?? 'root'} onNotify={notifyInfo} focus={explorerFocus} />
            )
          )}

          {page === 'Transfers' && (
            <section className="table-page-section"><div className="transfer-status-bar"><span className={`transfer-status-icon ${transferTone}`}><Activity size={18} /></span><div><strong>{transferTitle}</strong><p>{transferMessage}</p></div>{!accounts.length ? <button className="button button-primary" onClick={connectGoogleAccount}><Plus size={15} /> Connect a drive</button> : !syncFolder ? <button className="button button-secondary" onClick={chooseSyncFolder}><FolderOpen size={15} /> Choose folder</button> : !syncEnabled ? <button className="button button-secondary" onClick={() => setPage('Settings')}><Settings2 size={15} /> Sync settings</button> : <button className="button button-secondary" onClick={syncNow}><RefreshCw size={15} /> Sync now</button>}</div><div className="section-heading transfer-heading"><div><h2>Transfer queue</h2><p>{operations.length ? `${activeOperations.length} active · ${retryOperations.length} retrying · ${failedOperations.length} failed` : 'Uploads, downloads and cleanups'}</p></div><label className="filter-caption"><select aria-label="Activity range" value={transferRange} onChange={(event) => { setTransferRange(event.target.value as typeof transferRange); setTransfersPage(1) }}><option value="24h">LAST 24 HOURS</option><option value="7d">LAST 7 DAYS</option><option value="30d">LAST 30 DAYS</option><option value="all">ALL TIME</option></select></label></div>{failedOperations.length > 0 && <div className="queue-failure-bar"><AlertTriangle size={15} /><span>{failedOperations.length} transfer{failedOperations.length === 1 ? '' : 's'} failed after repeated attempts.</span><button className="button button-secondary" onClick={syncNow}><RefreshCw size={14} /> Retry failed</button></div>}{operations.length === 0 ? <div className="empty-files">No transfers recorded yet.{transfersReady ? ' Press Sync now to scan your drives.' : ' Connect a drive and choose a folder to start syncing.'}</div> : [{ key: 'active', label: 'Active', note: 'Queued and in progress', items: activeOperations }, { key: 'retry', label: 'Retrying', note: 'Waiting for the next attempt', items: retryOperations }, { key: 'failed', label: 'Failed', note: 'Needs a manual retry', items: failedOperations }, { key: 'history', label: 'Recent activity', note: 'Completed transfers', items: pagedCompleted }].map((group) => group.items.length > 0 && (<div className="queue-group" key={group.key}><div className="queue-group-head"><span className="queue-group-title">{group.label}</span><span className="queue-group-count">{group.items.length}</span><span className="queue-group-note">{group.note}</span>{group.key === 'history' && <button className="queue-clear" onClick={clearCompletedOperations}>Clear completed</button>}</div><div className="queue-list">{group.items.map((operation) => <QueueRow key={operation.id} operation={operation} now={now} accountLabel={operation.account_id ? accountEmailById.get(operation.account_id) ?? 'Drive account' : 'Unassigned'} color={operation.account_id ? accountColorById.get(operation.account_id) ?? 'gold' : 'gold'} onCancel={cancelOperation} />)}</div></div>))}{completedOperations.length > 0 && <div className="pagination-bar"><span className="pagination-count">{completedOperations.length} completed</span><label className="pagination-size">Rows<select value={transfersPageSize} onChange={(event) => { setTransfersPageSize(Number(event.target.value)); setTransfersPage(1) }} aria-label="Rows per page"><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option></select></label><div className="pagination-controls"><button className="pagination-button" disabled={transfersSafePage <= 1} onClick={() => setTransfersPage(transfersSafePage - 1)} aria-label="Previous page"><ChevronLeft size={15} /></button><span className="pagination-page">Page {transfersSafePage} of {transfersTotalPages}</span><button className="pagination-button" disabled={transfersSafePage >= transfersTotalPages} onClick={() => setTransfersPage(transfersSafePage + 1)} aria-label="Next page"><ChevronRight size={15} /></button></div></div>}<div className="demo-notice"><CircleHelp size={15} /><span>Every upload, download, rename and cleanup waits in this queue before it runs. Cancelled items can reappear on the next scan if the change is still pending.</span></div></section>
          )}

          {page === 'Storage' && (
            <div className="storage-page-section">
              <div className="storage-view-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={storageView === 'duplicates'} className={storageView === 'duplicates' ? 'active' : ''} onClick={() => setStorageView('duplicates')}><FileArchive size={13} /> Exact duplicates</button>
                <button type="button" role="tab" aria-selected={storageView === 'similar'} className={storageView === 'similar' ? 'active' : ''} onClick={() => setStorageView('similar')}><FileImage size={13} /> Similar photos</button>
              </div>
              {storageView === 'duplicates'
                ? <DedupeReport groups={duplicateGroups} isDemoData={isDemoData} applying={applyingDedupe} onApplyDedupe={applyDedupe} />
                : <SimilarReport groups={similarGroups} isDemoData={isDemoData} loading={similarLoading} error={similarError} applying={applyingDedupe} onApplyDedupe={applyDedupe} />}
            </div>
          )}

          {page === 'Accounts' && (
            <section className="accounts-page"><div className="accounts-toolbar"><p>Storage totals and account health for every connected drive.</p><button className="button button-primary" onClick={connectGoogleAccount}><Plus size={16} /> Connect Google Drive</button></div><div className="account-card-grid">{accounts.map((account) => { const usedPercent = percentUsed(account); return <article className="account-card" key={account.id}><div className="account-card-header"><span className={`account-avatar ${account.color}`}>{account.initials}</span><button className="row-more" aria-label={`Remove ${account.email}`} title="Remove account" onClick={() => setAccountToRemove(account)}><Trash2 size={15} /></button></div><h2>{account.name}</h2><p className="account-email">{account.email}</p><div className="account-card-capacity"><div className="capacity-label"><span>{formatBytes(account.used)} used</span><span>{usedPercent}%</span></div><div className="capacity-track"><span className={`capacity-fill ${account.color}`} style={{ width: `${usedPercent}%` }} /></div><div className="account-card-free"><strong>{formatBytes(account.quota - account.used)}</strong><span>available of {formatBytes(account.quota)}</span></div></div><div className="account-card-footer"><span className={`account-health ${usedPercent >= 80 ? 'near-limit' : ''}`}>{usedPercent >= 80 ? 'Near limit' : 'Healthy'}</span>{account.connected && account.readWriteAccess === false ? <button className="card-reconnect" onClick={connectGoogleAccount}>Reconnect for sync</button> : <span>Checked {lastCheckedAt ? formatRelativeTime(lastCheckedAt, now) : 'not yet'}</span>}</div></article> })}<button className="add-account-card" onClick={connectGoogleAccount}><span><Plus size={19} /></span><strong>Add another drive</strong><small>Connect a Google account</small></button></div><div className="demo-notice"><ShieldCheck size={15} /><span>Account names and storage values shown here are illustrative sample data.</span></div></section>
          )}

          {page === 'Settings' && <GoogleConnectionControls
            clientId={googleClientId}
            hasOAuthSecret={hasOAuthSecret}
            connectionStatus={connectionStatus}
            isConnecting={syncStatus === 'connecting'}
            syncEnabled={syncEnabled}
            folderSelected={Boolean(syncFolder)}
            reservePercent={reserve}
            accounts={accounts.map((account) => ({ id: account.id, email: account.email, usedBytes: account.used, limitBytes: account.quota || null, connected: account.connected ?? true, readWriteAccess: account.readWriteAccess ?? true }))}
            onImportOAuthConfig={importOAuthConfig}
            onConnectAccount={connectGoogleAccount}
            onRemoveAccount={(account) => setAccountToRemove(accounts.find((item) => item.id === account.id) ?? null)}
            onSyncEnabledChange={updateSyncEnabled}
            onReserveChange={updateReserve}
            onResetSyncState={resetSyncState}
          />}
          {page === 'Settings' && <SyncPolicyControls conflictPolicy={conflictPolicy} deletionPolicy={deletionPolicy} onConflictPolicyChange={updateConflictPolicy} onDeletionPolicyChange={updateDeletionPolicy} />}

          {page === 'Settings' && (
            <section className="settings-page"><div className="settings-group"><div className="settings-group-heading"><span className="settings-group-icon"><Sparkles size={16} /></span><div><h2>File routing</h2><p>Choose how new files are assigned to your drives.</p></div></div><div className="setting-row"><div><strong>Automatically select a drive</strong><p>{autoRoute ? 'New files go to the account with the most available space.' : 'New files go to your default drive when it has room.'}</p></div><button className={`toggle ${autoRoute ? 'on' : ''}`} role="switch" aria-checked={autoRoute} aria-label="Automatically select a drive" onClick={() => updateAutoRoute(!autoRoute)}><span /></button></div>{!autoRoute ? <div className="setting-row"><div><strong>Default drive</strong><p>Used for files that are not yet assigned to a drive.</p></div><label className="drive-select"><select value={preferredAccountId ?? ''} onChange={(event) => updatePreferredAccount(event.target.value)} aria-label="Default drive"><option value="">Most available space</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}</select></label></div> : null}<div className="setting-row"><div><strong>Minimum free space</strong><p>Do not route files if it would use this reserve.</p></div><label className="reserve-control"><input type="number" min="0" max="50" value={reserve} onChange={(event) => updateReserve(Number(event.target.value))} /><span>%</span></label></div></div><div className="settings-group"><div className="settings-group-heading"><span className="settings-group-icon power"><Power size={16} /></span><div><h2>Background &amp; startup</h2><p>Keep syncing without leaving the window open.</p></div></div><div className="setting-row"><div><strong>Keep running in the tray</strong><p>Closing the window hides Unite Drive to the system tray instead of quitting, so syncing continues. Use the tray icon to reopen or quit.</p></div><span className="setting-badge">Always on</span></div><div className="setting-row"><div><strong>Launch at login</strong><p>Start Unite Drive automatically when you sign in to Windows.</p></div><button className={`toggle ${launchAtLogin ? 'on' : ''}`} role="switch" aria-checked={launchAtLogin} aria-label="Launch at login" onClick={() => updateLaunchAtLogin(!launchAtLogin)}><span /></button></div></div><div className="settings-group"><div className="settings-group-heading"><span className="settings-group-icon folder"><FolderOpen size={16} /></span><div><h2>Local sync folder</h2><p>Choose a folder to keep synchronized with Drive.</p></div></div><div className="folder-picker-row"><span className="folder-path"><FolderOpen size={16} /> {syncFolder ?? 'No folder selected'}</span><button className="button button-secondary" onClick={chooseSyncFolder}>Choose folder</button></div><p className="settings-note">Changes are watched locally when sync is enabled. Initial sync never propagates deletions; later deletions follow the policy above.</p></div><div className="settings-group settings-security"><div className="settings-group-heading"><span className="settings-group-icon security"><ShieldCheck size={16} /></span><div><h2>Account access</h2><p>Manage Google sign-in and connected accounts.</p></div></div><div className="folder-picker-row"><span className="folder-path"><span className="status-hollow" /> {accounts.length ? `${accounts.length} account${accounts.length === 1 ? '' : 's'} available` : 'No Google accounts connected'}</span><button className="button button-secondary" onClick={connectGoogleAccount}>Connect an account</button></div></div></section>
          )}

          <footer className="page-footer"><span><span className="footer-brand-dot" /> unite drive <span className="footer-version">v{import.meta.env.VITE_APP_VERSION}</span></span><span>Designed for your files, wherever they live.</span></footer>
        </div>
      </main>

      {showHelp && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowHelp(false) }}><section className="connect-modal" role="dialog" aria-modal="true" aria-labelledby="help-heading"><button className="modal-close" aria-label="Close dialog" onClick={() => setShowHelp(false)}><X size={17} /></button><span className="modal-icon"><CircleHelp size={20} /></span><p className="eyebrow">QUICK START</p><h2 id="help-heading">Set up Unite Drive</h2><p className="modal-copy">Pool several Google accounts into one space, then let Unite Drive route and sync your files.</p><div className="modal-checklist"><span><Check size={14} /> Import your Google Desktop OAuth JSON in Settings</span><span><Check size={14} /> Connect one or more Google Drive accounts</span><span><Check size={14} /> Choose a local sync folder</span><span><Check size={14} /> Turn on sync, or press Sync now</span></div><button className="button button-primary modal-action" onClick={() => { setShowHelp(false); setPage('Settings') }}>Open Settings</button><span className="modal-footnote"><ShieldCheck size={13} /> Credentials are encrypted on this device.</span></section></div>}
      {searchOpen && (
        <div className="modal-backdrop search-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false) }}>
          <section className="search-palette" role="dialog" aria-modal="true" aria-label="Search files">
            <div className="search-palette-field">
              <Search size={17} />
              <input autoFocus aria-label="Search files" placeholder={searchScope === 'folder' ? 'Search inside your synced folder…' : 'Search files across all drives…'} value={paletteQuery} onChange={(event) => { setPaletteQuery(event.target.value); setSearchActive(0) }} onKeyDown={handleSearchKeyDown} />
              <span className="search-hint">ESC</span>
            </div>
            <div className="search-scope" role="tablist" aria-label="Search scope">
              <button type="button" role="tab" aria-selected={searchScope === 'drives'} className={`search-scope-option ${searchScope === 'drives' ? 'active' : ''}`} onClick={() => { setSearchScope('drives'); setSearchActive(0) }}>All drives</button>
              <button type="button" role="tab" aria-selected={searchScope === 'folder'} className={`search-scope-option ${searchScope === 'folder' ? 'active' : ''}`} onClick={() => { setSearchScope('folder'); setSearchActive(0) }} disabled={!syncFolder} title={syncFolder ? undefined : 'Choose a sync folder to search it'}>This folder</button>
            </div>
            <div className="search-results">
              {searchScope === 'folder' ? (
                folderSearchState === 'error' ? (
                  <div className="search-empty"><p>Could not search your sync folder.</p></div>
                ) : !paletteSearchQuery ? (
                  <div className="search-empty">
                    <p>Type to search inside your synced folder.</p>
                    <div className="search-keys"><span className="search-key"><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span className="search-key"><kbd>↵</kbd> Open in Explorer</span><span className="search-key"><kbd>Esc</kbd> Close</span></div>
                  </div>
                ) : folderResults.length === 0 ? (
                  <div className="search-empty"><p>{folderSearchState === 'loading' ? 'Searching this folder…' : `No matches in this folder for “${paletteSearchQuery}”.`}</p></div>
                ) : folderResults.map((entry, index) => (
                  <button className={`search-result ${index === safeSearchActive ? 'active' : ''}`} key={entry.relativePath} onMouseEnter={() => setSearchActive(index)} onClick={() => openExplorerResult(entry)}>
                    <span className="file-icon">{entry.isDirectory ? <FolderOpen size={16} /> : fileKindIcon(entry.name)}</span>
                    <span className="search-result-name">{entry.name}{entry.parentPath && <small>{entry.parentPath}</small>}</span>
                    <span className="search-result-drive">{entry.isDirectory ? 'Folder' : (entry.accountEmail ?? 'Not assigned')}</span>
                    <span className="search-result-size">{entry.isDirectory || entry.size == null ? '—' : formatBytes(entry.size)}</span>
                  </button>
                ))
              ) : driveResults.length === 0 ? (
                <div className="search-empty">
                  <p>{paletteSearchQuery ? `No files match “${paletteSearchQuery}”.` : 'Type to search files across every connected drive.'}</p>
                  {paletteSearchQuery && <button className="button button-secondary" onClick={openFilesUnfiltered}>View all files in Files</button>}
                  <div className="search-keys"><span className="search-key"><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span className="search-key"><kbd>↵</kbd> Open in Files</span><span className="search-key"><kbd>Esc</kbd> Close</span></div>
                </div>
              ) : driveResults.map((item, index) => (
                <button className={`search-result ${index === safeSearchActive ? 'active' : ''}`} key={`${item.path ?? item.name}-${index}`} onMouseEnter={() => setSearchActive(index)} onClick={openFilesResults}>
                  <span className="file-icon">{fileKindIcon(item.name)}</span>
                  <span className="search-result-name">{item.name}{item.path && item.path !== item.name && <small>{item.path}</small>}</span>
                  <span className="search-result-drive"><span className={`mini-drive-dot ${driveColorClass(item.account)}`} />{item.account}</span>
                  <span className="search-result-size">{item.size ? formatBytes(item.size) : '-'}</span>
                </button>
              ))}
            </div>
            <div className="search-palette-foot"><span>{paletteResultCount} result{paletteResultCount === 1 ? '' : 's'}{searchScope === 'drives' && !paletteSearchQuery ? ' (recent)' : ''}</span><button className="button button-secondary" onClick={searchScope === 'folder' ? () => { setSearchOpen(false); setPage('Explorer') } : openFilesResults}>{searchScope === 'folder' ? 'Open in Explorer' : 'Open in Files'}</button></div>
          </section>
        </div>
      )}
      {accountToRemove && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAccountToRemove(null) }}><section className="connect-modal" role="dialog" aria-modal="true" aria-labelledby="remove-heading"><button className="modal-close" aria-label="Close dialog" onClick={() => setAccountToRemove(null)}><X size={17} /></button><span className="modal-icon danger"><Trash2 size={20} /></span><p className="eyebrow">REMOVE ACCOUNT</p><h2 id="remove-heading">Remove {accountToRemove.email}?</h2><p className="modal-copy">Unite Drive will forget this account and its sync history on this device. Files already in Google Drive are left untouched, and your local folder re-syncs to your remaining accounts.</p><div className="modal-confirm-actions"><button className="button button-secondary" onClick={() => setAccountToRemove(null)}>Cancel</button><button className="button button-danger" onClick={removeGoogleAccount} disabled={removingAccount}>{removingAccount ? 'Removing…' : 'Remove account'}</button></div></section></div>}
      {toast && <div className="toast" role="status"><span className="toast-mark"><Check size={14} /></span>{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
    </div>
  )
}

function FileTable({ files, expanded = false, emptyMessage = 'No files to show.' }: { files: RoutedFile[]; expanded?: boolean; emptyMessage?: string }) {
  return (
    <div className={`file-table ${expanded ? 'expanded' : ''}`}>
      <div className="file-table-head"><span>NAME</span><span>SIZE</span><span>DRIVE</span><span>ADDED</span></div>
      {files.length === 0 ? <div className="empty-files">{emptyMessage}</div> : files.map((item, index) => (
        <div className="file-table-row" key={`${item.path ?? item.name}-${index}`}>
          <span className="file-name-cell">
            <span className="file-icon">{fileKindIcon(item.name)}</span>
            <span className="file-name-text" title={item.path ?? item.name}>{item.name}{item.path && item.path !== item.name && <small className="file-path-label">{item.path}</small>}{item.preview && <small>PREVIEW</small>}</span>
          </span>
          <span className="file-size-cell">{item.size ? formatBytes(item.size) : '-'}</span>
          <span className="file-drive-cell"><span className={`mini-drive-dot ${driveColorClass(item.account)}`} />{item.account}</span>
          <span className="file-time-cell">{item.time}</span>
        </div>
      ))}
    </div>
  )
}

function QueueRow({ operation, now, accountLabel, color, onCancel }: { operation: SyncOperation; now: number; accountLabel: string; color: string; onCancel: (operation: SyncOperation) => void }) {
  const baseName = operation.relative_path.split('/').at(-1) || operation.relative_path
  const retrySeconds = operation.state === 'retry' ? Math.max(0, Math.round((Date.parse(operation.next_attempt_at) - now) / 1000)) : null
  const meta = operation.state === 'failed' && operation.last_error
    ? operation.last_error
    : operation.state === 'retry' && retrySeconds !== null
      ? `retrying in ${retrySeconds}s`
      : operation.attempts > 0
        ? `attempt ${operation.attempts}`
        : '—'
  const cancellable = ['queued', 'retry', 'failed'].includes(operation.state)
  return (
    <div className="queue-row">
      <span className={`queue-kind ${operation.state}`}>{operationIcon(operation.kind)}</span>
      <span className="queue-file"><span className="queue-kind-label">{operationLabels[operation.kind] ?? operation.kind}</span><span className="queue-file-body"><span className="queue-file-name" title={operation.relative_path}>{baseName}</span><small>{operation.relative_path}</small></span></span>
      <span className="queue-drive"><span className={`mini-drive-dot ${color}`} />{accountLabel}</span>
      <span className={`queue-state ${operation.state}`}>{operationStateLabels[operation.state] ?? operation.state}</span>
      <span className="queue-meta" title={meta}>{meta}</span>
      {cancellable ? <button className="queue-cancel" aria-label={`Cancel transfer of ${baseName}`} title="Cancel this transfer" onClick={() => onCancel(operation)}><X size={14} /></button> : <span className="queue-cancel-spacer" />}
    </div>
  )
}

export default App
