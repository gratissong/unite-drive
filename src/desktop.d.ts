export {}

type ConflictPolicy = 'keep-both' | 'prefer-local' | 'prefer-remote'
type DeletionPolicy = 'propagate-to-trash' | 'keep-other-copy'

type SyncSettings = {
  folderPath: string | null
  conflictPolicy: ConflictPolicy
  deletionPolicy: DeletionPolicy
  googleClientId: string
  syncEnabled: boolean
  storageReservePercent: number
  autoRoute: boolean
  preferredAccountId: string | null
  launchAtLogin: boolean
  autoUpdateCheck: boolean
}

type DriveAccountInfo = {
  id: string
  email: string
  usedBytes: number
  limitBytes: number | null
  connected: boolean
  readWriteAccess?: boolean
}

type SyncStatus = {
  status: 'paused' | 'connecting' | 'connected' | 'syncing' | 'idle' | 'retrying' | 'error'
  message?: string
  code?: string
}

type AddFilesResult = {
  imported: number
  skipped: string[]
  errors: Array<{ name: string; message: string }>
}

type FsEntry = {
  name: string
  isDirectory: boolean
  size: number | null
  mtime: string | null
  accountEmail?: string | null
  syncState?: string | null
}

type FsSearchEntry = FsEntry & {
  relativePath: string
  parentPath: string
}

type OAuthConfigStatus = {
  clientId: string
  hasClientSecret: boolean
}

type SyncManifestFile = {
  relative_path: string
  account_id: string | null
  drive_file_id: string | null
  baseline_hash: string | null
  size_bytes: number | null
  local_modified_at: string | null
  remote_modified_at: string | null
  sync_state: string
  deleted_at: string | null
}

type SyncStateSnapshot = {
  accounts: Array<{ id: string; email: string }>
  files: SyncManifestFile[]
  operations: Array<{
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
  }>
}

declare global {
  // App version injected by vite.config.ts from package.json.
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION: string
  }

  // Update state machine exposed by the main process (electron/update-service.cjs).
  type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'unsupported' | 'error'

  type UpdateStatus = {
    state: UpdateState
    currentVersion?: string
    version?: string | null
    percent?: number
    message?: string
    checkedAt?: string
  }

  interface Window {
    uniteDrive?: {
      isDesktop: boolean
      selectSyncFolder: () => Promise<string | null>
      openSyncFolder: () => Promise<boolean>
      getUserInfo: () => Promise<{ name: string; avatar: string | null }>
      addFiles: () => Promise<AddFilesResult>
      listDirectory: (relativePath?: string) => Promise<FsEntry[]>
      searchFolder: (query: string) => Promise<FsSearchEntry[]>
      createFolder: (relativePath: string) => Promise<{ path: string }>
      movePath: (from: string, to: string) => Promise<{ from: string; to: string }>
      movePaths: (moves: Array<{ from: string; to: string }>) => Promise<{ moved: Array<{ from: string; to: string }>; errors: Array<{ from: string; to: string; message: string; code?: string }> }>
      trashPath: (relativePath: string) => Promise<{ trashed: string }>
      trashPaths: (paths: string[]) => Promise<{ trashed: string[]; errors: Array<{ path: string; message: string; code?: string }> }>
      revealInExplorer: (relativePath?: string) => Promise<boolean>
      importIntoFolder: (relativePath?: string) => Promise<AddFilesResult>
      getSyncSettings: () => Promise<SyncSettings>
      getSyncState: () => Promise<SyncStateSnapshot>
      getOAuthConfigStatus: () => Promise<OAuthConfigStatus>
      importOAuthConfig: () => Promise<OAuthConfigStatus | null>
      updateSyncSettings: (patch: Partial<SyncSettings>) => Promise<SyncSettings>
      getDriveAccounts: () => Promise<DriveAccountInfo[]>
      connectGoogleAccount: () => Promise<DriveAccountInfo>
      removeGoogleAccount: (accountId: string) => Promise<{ removed: string; email: string }>
      cancelOperation: (operationId: string) => Promise<{ cancelled: string | null }>
      clearCompletedOperations: () => Promise<{ removed: number }>
      syncNow: () => Promise<unknown>
      getSimilarGroups: () => Promise<Array<{
        path: string
        sizeBytes: number
        accountId: string | null
        thumbnail: string | null
      }[]>>
      applyDedupe: (removals: Array<{ relativePath: string }>) => Promise<{ removed: string[]; errors: Array<{ relativePath: string; message: string }> }>
      resetSyncState: () => Promise<boolean>
      getUpdateStatus: () => Promise<UpdateStatus>
      checkForUpdates: () => Promise<UpdateStatus>
      downloadUpdate: () => Promise<UpdateStatus | null>
      installUpdate: () => Promise<boolean>
      onSyncStatus: (callback: (status: SyncStatus) => void) => () => void
      onSettingsChanged: (callback: (settings: SyncSettings) => void) => () => void
      onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
    }
  }
}
