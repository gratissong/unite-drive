const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, safeStorage, shell } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFileSync } = require('node:child_process')
const { google } = require('googleapis')
const { conflictPolicies, deletionPolicies } = require('./sync-policy.cjs')
const { createSettingsStore } = require('./sync-settings.cjs')
const { createSyncStore } = require('./sync-store.cjs')
const { createTokenStore } = require('./token-store.cjs')
const { authorizeGoogleAccount, tokensHaveFullAccess } = require('./google-oauth.cjs')
const { parseDesktopOAuthCredentials } = require('./google-oauth-config.cjs')
const { GoogleDriveProvider } = require('./google-drive-provider.cjs')
const { SyncEngine } = require('./sync-engine.cjs')
const { SyncService } = require('./sync-service.cjs')
const { UpdateService } = require('./update-service.cjs')
const { resolveSafePath, writeStreamIfAbsent } = require('./file-ops.cjs')
const { createFolder, listDirectory, movePath, movePaths, searchLocalFolder, trashPath, trashPaths } = require('./explorer-ops.cjs')
const { scanSimilarGroups } = require('./similar-scanner.cjs')

const oauthCredentialKey = '__google_oauth_desktop_client__'

let mainWindow
let tray
let isQuitting = false
let trayNoticeShown = false
let settingsStore
let syncStore
let tokenStore
let syncService
let updateService
let lastUpdateNoticeVersion = null
const driveProviders = new Map()

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function toggleWindow() {
  if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide()
  } else {
    showWindow()
  }
  refreshTrayMenu()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 940,
    minWidth: 920,
    minHeight: 680,
    backgroundColor: '#f5f6f2',
    title: 'Unite Drive',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  } else {
    mainWindow.loadURL('http://127.0.0.1:5173')
  }

  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    mainWindow.hide()
    refreshTrayMenu()
    if (trayNoticeShown) return
    trayNoticeShown = true
    try {
      new Notification({
        title: 'Unite Drive is still syncing',
        body: 'Files keep syncing in the system tray. Right-click the tray icon and choose Quit to exit.',
      }).show()
    } catch {
      // Notifications can be unavailable (for example without a display server); ignore.
    }
  })
}

function appEntryUrl() {
  if (app.isPackaged) return pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html')).href
  return 'http://127.0.0.1:5173/'
}

function isAppUrl(targetUrl) {
  try {
    const target = new URL(targetUrl)
    const allowed = new URL(appEntryUrl())
    return target.protocol === allowed.protocol && target.host === allowed.host && target.pathname === allowed.pathname
  } catch {
    return false
  }
}

// Pin every renderer to the app's own document. The preload bridge is attached
// to whatever a window loads, so any page- or user-initiated navigation to a
// different origin is denied. External links still open in the user's browser.
function hardenWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
}

ipcMain.handle('unite-drive:select-sync-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a local sync folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('unite-drive:open-sync-folder', async () => {
  const settings = settingsStore.load()
  if (!settings.folderPath) {
    const error = new Error('Choose a local sync folder before opening it.')
    error.code = 'SYNC_NOT_CONFIGURED'
    throw error
  }
  const failure = await shell.openPath(settings.folderPath)
  if (failure) {
    const error = new Error(failure)
    error.code = 'OPEN_FOLDER_FAILED'
    throw error
  }
  return true
})

function imageMimeType(fileName) {
  switch (path.extname(fileName).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.bmp': return 'image/bmp'
    case '.gif': return 'image/gif'
    default: return null
  }
}

function collectAccountPictureFiles(directory, collected) {
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) collectAccountPictureFiles(fullPath, collected)
    else if (entry.isFile() && imageMimeType(entry.name)) collected.push(fullPath)
  }
}

function accountPictureCandidates() {
  const candidates = []
  const collected = []
  collectAccountPictureFiles(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'AccountPictures'), collected)
  collected.sort((first, second) => {
    try { return fs.statSync(second).mtimeMs - fs.statSync(first).mtimeMs } catch { return 0 }
  })
  candidates.push(...collected)
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\AccountPicture\\Users', '/s'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      const fromRegistry = []
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/Image(\d+)\s+REG_SZ\s+(.+?)\s*$/)
        if (match) fromRegistry.push({ filePath: match[2].trim(), rank: Number(match[1]) })
      }
      fromRegistry.sort((first, second) => second.rank - first.rank)
      candidates.push(...fromRegistry.map((entry) => entry.filePath))
    } catch {
      // No custom account picture key on this system; fall back to initials.
    }
  }
  return candidates
}

function readAccountPicture() {
  for (const filePath of accountPictureCandidates()) {
    try {
      const stats = fs.statSync(filePath)
      const mimeType = imageMimeType(filePath)
      if (!mimeType || !stats.isFile() || stats.size === 0 || stats.size > 8 * 1024 * 1024) continue
      return `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`
    } catch {
      // Skip unreadable candidates.
    }
  }
  return null
}

let userInfoCache = null

ipcMain.handle('unite-drive:get-user-info', () => {
  if (userInfoCache) return userInfoCache
  let name = 'Local user'
  try {
    const info = os.userInfo()
    const profileName = info.homedir ? path.basename(info.homedir) : ''
    name = (profileName || info.username || 'Local user').trim()
  } catch {
    const fallback = (process.env.USERNAME || process.env.USER || '').trim()
    if (fallback) name = fallback
  }
  userInfoCache = { name, avatar: readAccountPicture() }
  return userInfoCache
})

ipcMain.handle('unite-drive:add-files', async () => {
  const settings = settingsStore.load()
  if (!settings.folderPath || !settings.syncEnabled || driveProviders.size === 0) {
    const error = new Error('Choose a local folder, connect a Drive, and enable sync before adding files')
    error.code = 'SYNC_NOT_CONFIGURED'
    throw error
  }
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Add files to the synced folder',
    properties: ['openFile', 'multiSelections'],
  })
  if (selection.canceled) return { imported: 0, skipped: 0, errors: [] }

  const imported = []
  const skipped = []
  const errors = []
  const rootPath = await fs.promises.realpath(settings.folderPath)
  for (const sourcePath of selection.filePaths) {
    try {
      const stats = await fs.promises.lstat(sourcePath)
      if (!stats.isFile() || stats.isSymbolicLink()) throw new TypeError('Only regular files can be added')
      const name = path.basename(sourcePath)
      const relativePath = name.replaceAll('\\', '/')
      await writeStreamIfAbsent(rootPath, relativePath, fs.createReadStream(sourcePath))
      imported.push(name)
    } catch (error) {
      if (error.code === 'DESTINATION_EXISTS') skipped.push(path.basename(sourcePath))
      else errors.push({ name: path.basename(sourcePath), message: error.message })
    }
  }

  if (imported.length) triggerSync()
  return { imported: imported.length, skipped, errors }
})

function requireSyncFolder() {
  const settings = settingsStore.load()
  if (!settings.folderPath) {
    const error = new Error('Choose a local sync folder before browsing or editing it.')
    error.code = 'SYNC_NOT_CONFIGURED'
    throw error
  }
  return settings.folderPath
}

// Kick a sync after a local mutation without letting a sync failure fail the
// mutation itself. The file change already happened on disk, and a sync pass
// (possibly one already in flight for that same change) reports its own error
// through the sync-status channel, so it must not reject the caller.
function triggerSync() {
  if (!syncService) return
  void syncService.syncNow({ retryFailed: true }).catch(() => {})
}

ipcMain.handle('unite-drive:list-directory', async (_event, relativePath = '') => {
  const rootPath = requireSyncFolder()
  const items = await listDirectory(rootPath, relativePath)
  return items.map((entry) => {
    if (entry.isDirectory) return { name: entry.name, isDirectory: true, size: null, mtime: entry.mtime, accountEmail: null, syncState: null }
    const manifest = syncStore.getFile(entry.relativePath)
    const account = manifest?.account_id ? syncStore.getAccount(manifest.account_id) : null
    return {
      name: entry.name,
      isDirectory: false,
      size: entry.size,
      mtime: entry.mtime,
      accountEmail: account?.email ?? null,
      syncState: manifest?.sync_state ?? null,
    }
  })
})

ipcMain.handle('unite-drive:search-folder', async (_event, query = '') => {
  const rootPath = requireSyncFolder()
  const items = await searchLocalFolder(rootPath, query)
  return items.map((entry) => {
    if (entry.isDirectory) return { ...entry, accountEmail: null, syncState: null }
    const manifest = syncStore.getFile(entry.relativePath)
    const account = manifest?.account_id ? syncStore.getAccount(manifest.account_id) : null
    return { ...entry, accountEmail: account?.email ?? null, syncState: manifest?.sync_state ?? null }
  })
})

ipcMain.handle('unite-drive:create-folder', async (_event, relativePath) => createFolder(requireSyncFolder(), relativePath))

ipcMain.handle('unite-drive:move-path', async (_event, from, to) => {
  const result = await movePath(requireSyncFolder(), from, to)
  if (!result.alreadyMoved) triggerSync()
  return result
})

ipcMain.handle('unite-drive:trash-path', async (_event, relativePath) => {
  const result = await trashPath(requireSyncFolder(), relativePath, (filePath) => shell.trashItem(filePath))
  triggerSync()
  return result
})

ipcMain.handle('unite-drive:move-paths', async (_event, moves) => {
  const result = await movePaths(requireSyncFolder(), moves)
  if (result.moved.length) triggerSync()
  return result
})

ipcMain.handle('unite-drive:trash-paths', async (_event, paths) => {
  const result = await trashPaths(requireSyncFolder(), paths, (filePath) => shell.trashItem(filePath))
  if (result.trashed.length) triggerSync()
  return result
})

ipcMain.handle('unite-drive:reveal-in-explorer', async (_event, relativePath = '') => {
  const rootPath = requireSyncFolder()
  const target = relativePath ? resolveSafePath(rootPath, relativePath).target : rootPath
  const failure = await shell.showItemInFolder(target)
  if (failure) {
    const error = new Error(failure)
    error.code = 'OPEN_FOLDER_FAILED'
    throw error
  }
  return true
})

ipcMain.handle('unite-drive:import-into-folder', async (_event, relativePath = '') => {
  const rootPath = requireSyncFolder()
  const targetDir = typeof relativePath === 'string' && relativePath
    ? resolveSafePath(rootPath, relativePath).relativePath
    : ''
  const folderLabel = targetDir ? path.basename(targetDir) : 'this folder'
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: `Add files to ${folderLabel}`,
    properties: ['openFile', 'multiSelections'],
  })
  if (selection.canceled) return { imported: 0, skipped: 0, errors: [] }
  const imported = []
  const skipped = []
  const errors = []
  for (const sourcePath of selection.filePaths) {
    try {
      const stats = await fs.promises.lstat(sourcePath)
      if (!stats.isFile() || stats.isSymbolicLink()) throw new TypeError('Only regular files can be added')
      const name = path.basename(sourcePath)
      const relativeFile = targetDir ? `${targetDir}/${name}` : name
      await writeStreamIfAbsent(rootPath, relativeFile, fs.createReadStream(sourcePath))
      imported.push(name)
    } catch (error) {
      if (error.code === 'DESTINATION_EXISTS') skipped.push(path.basename(sourcePath))
      else errors.push({ name: path.basename(sourcePath), message: error.message })
    }
  }
  if (imported.length) triggerSync()
  return { imported: imported.length, skipped, errors }
})

ipcMain.handle('unite-drive:get-sync-settings', () => settingsStore.load())
ipcMain.handle('unite-drive:get-oauth-config-status', () => {
  let hasClientSecret = false
  try {
    hasClientSecret = Boolean(tokenStore.load(oauthCredentialKey).clientSecret)
  } catch {
    hasClientSecret = false
  }
  return { clientId: settingsStore.load().googleClientId, hasClientSecret }
})
ipcMain.handle('unite-drive:import-oauth-config', async () => {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose Google Desktop OAuth credentials JSON',
    properties: ['openFile'],
    filters: [{ name: 'Google OAuth JSON', extensions: ['json'] }],
  })
  if (selection.canceled || !selection.filePaths[0]) return null
  const contents = await fs.promises.readFile(selection.filePaths[0], 'utf8')
  const { clientId, clientSecret } = parseDesktopOAuthCredentials(contents)
  tokenStore.save(oauthCredentialKey, { clientSecret })
  settingsStore.update({ googleClientId: clientId })
  return { clientId, hasClientSecret: true }
})
ipcMain.handle('unite-drive:get-sync-state', () => ({
  accounts: syncStore.listAccounts(),
  files: syncStore.listFiles(),
  operations: syncStore.listOperations(),
}))
ipcMain.handle('unite-drive:get-drive-accounts', async () => {
  const managed = new Map()
  for (const file of syncStore.listFiles()) {
    if (!file.account_id) continue
    const entry = managed.get(file.account_id) ?? { files: 0, bytes: 0 }
    entry.files += 1
    entry.bytes += file.size_bytes ?? 0
    managed.set(file.account_id, entry)
  }
  const accounts = []
  for (const account of syncStore.listAccounts()) {
    const provider = driveProviders.get(account.id)
    let quota = { limitBytes: account.quota_bytes, usageBytes: 0 }
    let readWriteAccess = false
    if (provider) {
      try {
        quota = await provider.getQuota()
      } catch {
        quota = { limitBytes: account.quota_bytes, usageBytes: 0 }
      }
      try {
        readWriteAccess = tokensHaveFullAccess(tokenStore.load(account.id))
      } catch {
        readWriteAccess = false
      }
    }
    const stats = managed.get(account.id) ?? { files: 0, bytes: 0 }
    accounts.push({
      id: account.id,
      email: account.email,
      usedBytes: quota.usageBytes,
      limitBytes: quota.limitBytes,
      connected: Boolean(provider),
      readWriteAccess,
      managedFiles: stats.files,
      managedBytes: stats.bytes,
    })
  }
  return accounts
})
ipcMain.handle('unite-drive:connect-google-account', async () => {
  const { googleClientId } = settingsStore.load()
  let clientSecret
  try {
    clientSecret = tokenStore.load(oauthCredentialKey).clientSecret
  } catch {
    clientSecret = null
  }
  if (!googleClientId || !clientSecret) {
    const error = new Error('Import the Google Desktop OAuth credentials JSON in Settings before connecting an account')
    error.code = 'GOOGLE_OAUTH_CONFIG_REQUIRED'
    throw error
  }
  let stage = 'Opening Google sign-in'
  publishSyncStatus({ status: 'connecting', message: 'Waiting for Google sign-in in your browser...' })
  try {
    const authorization = await authorizeGoogleAccount({
      clientId: googleClientId,
      clientSecret,
      openExternal: (url) => shell.openExternal(url),
      onStatus: ({ phase, message }) => {
        if (phase === 'authorization-received') stage = 'Exchanging Google authorization code'
        if (phase === 'exchanging-code') stage = 'Exchanging Google authorization code'
        publishSyncStatus({ status: 'connecting', message })
      },
    })

    stage = 'Loading your Google profile'
    publishSyncStatus({ status: 'connecting', message: `${stage}...` })
    const profile = await google.oauth2({ version: 'v2', auth: authorization.client }).userinfo.get()
    const accountId = profile.data.id
    const email = profile.data.email
    if (!accountId || !email) throw new Error('Google did not return an account ID and email')

    stage = 'Saving encrypted credentials'
    publishSyncStatus({ status: 'connecting', message: `${stage}...` })
    syncStore.upsertAccount({ id: accountId, email })
    tokenStore.save(accountId, authorization.tokens)

    const provider = createGoogleProvider(accountId, email, authorization.client, authorization.tokens)
    driveProviders.set(accountId, provider)

    stage = 'Preparing the Unite Drive folder'
    publishSyncStatus({ status: 'connecting', message: `${stage}...` })
    const root = await provider.ensureManagedRoot()

    stage = 'Reading Google Drive storage quota'
    publishSyncStatus({ status: 'connecting', message: `${stage}...` })
    const quota = await provider.getQuota()
    syncStore.upsertAccount({ id: accountId, email, rootFolderId: root.rootFolderId, quotaBytes: quota.limitBytes })

    stage = 'Starting sync'
    publishSyncStatus({ status: 'connecting', message: `${stage}...` })
    await configureSyncService()
    publishSyncStatus({ status: 'connected', message: `Connected ${email}.` })
    return { id: accountId, email, usedBytes: quota.usageBytes, limitBytes: quota.limitBytes, connected: true, readWriteAccess: true }
  } catch (error) {
    const message = `${stage} failed: ${error.message ?? String(error)}`
    console.error(`[Unite Drive] ${message} (${error.code ?? 'no error code'})`)
    publishSyncStatus({ status: 'error', message, code: error.code })
    const visibleError = new Error(message)
    if (error.code) visibleError.code = error.code
    throw visibleError
  }
})
async function runSyncNow() {
  const settings = settingsStore.load()
  if (!settings.folderPath || driveProviders.size === 0) {
    const error = new Error('Choose a local folder and connect at least one Google Drive account before syncing')
    error.code = 'SYNC_NOT_CONFIGURED'
    throw error
  }
  if (syncService) return syncService.syncNow({ retryFailed: true })

  publishSyncStatus({ status: 'syncing', message: 'Running a one-time sync...' })
  try {
    const result = await createSyncEngine(settings).syncOnce({ retryFailed: true })
    publishSyncStatus({
      status: result.failed ? 'error' : result.retrying ? 'retrying' : 'idle',
      message: result.failed
        ? `${result.failed} sync operation${result.failed === 1 ? '' : 's'} failed.`
        : result.retrying
          ? `${result.retrying} operation${result.retrying === 1 ? '' : 's'} will retry automatically.`
          : 'One-time sync complete.',
      result,
    })
    return result
  } catch (error) {
    publishSyncStatus({ status: 'error', message: error.message, code: error.code })
    throw error
  }
}
ipcMain.handle('unite-drive:sync-now', () => runSyncNow())
ipcMain.handle('unite-drive:apply-dedupe', async (_event, removals) => {
  if (!Array.isArray(removals) || removals.length === 0) return { removed: [], errors: [] }
  const settings = settingsStore.load()
  if (!settings.folderPath) {
    const error = new Error('Choose a local sync folder before removing duplicate copies.')
    error.code = 'SYNC_NOT_CONFIGURED'
    throw error
  }
  const engine = syncService?.engine ?? createSyncEngine(settings)
  const result = await engine.applyDedupe(removals)
  publishSyncStatus({
    status: syncService ? 'idle' : 'paused',
    message: result.errors.length
      ? `Dedupe cleanup finished with ${result.errors.length} issue${result.errors.length === 1 ? '' : 's'}.`
      : `Removed ${result.removed.length} duplicate copy${result.removed.length === 1 ? '' : 's'}.`,
  })
  return result
})
ipcMain.handle('unite-drive:remove-files', async (_event, removals) => {
  if (!Array.isArray(removals) || removals.length === 0) return { removed: [], errors: [] }
  const settings = settingsStore.load()
  if (!settings.folderPath) {
    const error = new Error('Choose a local sync folder before removing copies.')
    error.code = 'SYNC_NOT_CONFIGURED'
    throw error
  }
  const engine = syncService?.engine ?? createSyncEngine(settings)
  const result = await engine.removeFiles(removals)
  publishSyncStatus({
    status: syncService ? 'idle' : 'paused',
    message: result.errors.length
      ? `Cleanup finished with ${result.errors.length} issue${result.errors.length === 1 ? '' : 's'}.`
      : `Removed ${result.removed.length} cop${result.removed.length === 1 ? 'y' : 'ies'}.`,
  })
  return result
})
function normalizeRebalanceOptions(value) {
  const options = { maxBytes: null, maxMoves: null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return options
  if (value.maxBytes != null) {
    const bytes = Number(value.maxBytes)
    if (!Number.isFinite(bytes) || bytes <= 0) throw new TypeError('Rebalance size cap must be a positive number of bytes')
    options.maxBytes = Math.floor(bytes)
  }
  if (value.maxMoves != null) {
    const moves = Number(value.maxMoves)
    if (!Number.isFinite(moves) || moves <= 0) throw new TypeError('Rebalance move cap must be a positive number')
    options.maxMoves = Math.floor(moves)
  }
  return options
}
async function runRebalance(apply, rawOptions) {
  const settings = settingsStore.load()
  if (!settings.folderPath) {
    const error = new Error('Choose a local sync folder before rebalancing drives.')
    error.code = 'SYNC_NOT_CONFIGURED'
    throw error
  }
  const options = normalizeRebalanceOptions(rawOptions)
  const engine = syncService?.engine ?? createSyncEngine(settings)
  const result = await engine.rebalance({ apply, ...options })
  if (apply && result.queued > 0) {
    // Moves are ordinary queued operations; drain them through the same watcher
    // (or a one-time pass when sync is paused) so they show up in Transfers.
    if (syncService) void syncService.syncNow({ retryFailed: true }).catch(() => {})
    else void createSyncEngine(settings).syncOnce({ retryFailed: true }).catch(() => {})
    publishSyncStatus({
      status: syncService ? 'idle' : 'paused',
      message: `Rebalancing ${result.queued} file${result.queued === 1 ? '' : 's'} between drives.`,
    })
  }
  return result
}
ipcMain.handle('unite-drive:get-rebalance-plan', (_event, options) => runRebalance(false, options))
ipcMain.handle('unite-drive:rebalance-drives', (_event, options) => runRebalance(true, options))
ipcMain.handle('unite-drive:get-similar-groups', () => {
  const settings = settingsStore.load()
  if (!settings.folderPath) return []
  return scanSimilarGroups({ rootPath: settings.folderPath, store: syncStore })
})
ipcMain.handle('unite-drive:reset-sync-state', async () => {
  if (syncService) {
    await syncService.stop()
    syncService = null
  }
  syncStore.resetSyncState()
  await configureSyncService()
  return true
})
ipcMain.handle('unite-drive:remove-google-account', async (_event, accountId) => {
  if (typeof accountId !== 'string' || !accountId) throw new TypeError('An account id is required')
  const account = syncStore.getAccount(accountId)
  if (!account) {
    const error = new Error('That account is not connected')
    error.code = 'ACCOUNT_NOT_FOUND'
    throw error
  }
  driveProviders.delete(accountId)
  try {
    tokenStore.remove(accountId)
  } catch (error) {
    console.error(`[Unite Drive] Could not remove stored credentials for ${account.email}: ${error.message}`)
  }
  syncStore.removeAccount(accountId)
  // Reconfigure without waiting for the follow-up sync: it re-routes this
  // account's files to the remaining drives, and blocking the removal on that
  // transfer made the "Removing..." dialog look hung. The sync still runs, just
  // in the background.
  await configureSyncService({ awaitInitialSync: false })
  // The background sync owns the status pill from here; only report a status
  // when sync is actually stopped (e.g. the last account was removed).
  if (!syncService) {
    publishSyncStatus({ status: 'paused', message: `Removed ${account.email}. Its files remain in Google Drive.` })
  }
  return { removed: accountId, email: account.email }
})
ipcMain.handle('unite-drive:cancel-operation', (_event, operationId) => {
  if (typeof operationId !== 'string' || !operationId) throw new TypeError('An operation id is required')
  const operation = syncStore.getOperation(operationId)
  if (!operation) return { cancelled: null }
  if (operation.state === 'running') {
    const error = new Error('That transfer is already in progress and cannot be cancelled.')
    error.code = 'OPERATION_RUNNING'
    throw error
  }
  syncStore.deleteOperation(operationId)
  return { cancelled: operationId }
})
ipcMain.handle('unite-drive:clear-completed-operations', () => ({ removed: syncStore.clearCompletedOperations() }))
ipcMain.handle('unite-drive:get-update-status', () => (updateService ? updateService.getStatus() : { state: 'idle' }))
ipcMain.handle('unite-drive:check-for-updates', () => (updateService ? updateService.checkForUpdates({ manual: true }) : { state: 'idle' }))
ipcMain.handle('unite-drive:download-update', () => (updateService ? updateService.downloadUpdate() : null))
ipcMain.handle('unite-drive:install-update', () => (updateService ? updateService.installUpdate() : false))
ipcMain.handle('unite-drive:update-sync-settings', async (_event, patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Invalid sync settings')
  if (Object.hasOwn(patch, 'folderPath') && patch.folderPath !== settingsStore.load().folderPath && syncStore.getMetadata('activeSyncRoot')) {
    const error = new Error('Pause sync and reset sync state before changing the local folder. Existing Drive files will not be deleted.')
    error.code = 'SYNC_ROOT_CHANGE_REQUIRES_RESET'
    throw error
  }
  if (Object.hasOwn(patch, 'folderPath') && patch.folderPath !== null) {
    if (typeof patch.folderPath !== 'string' || !fs.existsSync(patch.folderPath) || !fs.statSync(patch.folderPath).isDirectory()) {
      throw new TypeError('Sync folder must be an existing directory')
    }
  }
  if (Object.hasOwn(patch, 'conflictPolicy') && !conflictPolicies.includes(patch.conflictPolicy)) {
    throw new TypeError('Unknown conflict policy')
  }
  if (Object.hasOwn(patch, 'deletionPolicy') && !deletionPolicies.includes(patch.deletionPolicy)) {
    throw new TypeError('Unknown deletion policy')
  }
  if (Object.hasOwn(patch, 'googleClientId') && (typeof patch.googleClientId !== 'string' || patch.googleClientId.length > 512)) {
    throw new TypeError('Invalid Google OAuth client ID')
  }
  if (Object.hasOwn(patch, 'syncEnabled') && typeof patch.syncEnabled !== 'boolean') throw new TypeError('Invalid sync enabled setting')
  if (Object.hasOwn(patch, 'autoRoute') && typeof patch.autoRoute !== 'boolean') throw new TypeError('Invalid automatic routing setting')
  if (Object.hasOwn(patch, 'preferredAccountId') && patch.preferredAccountId !== null && (typeof patch.preferredAccountId !== 'string' || patch.preferredAccountId.length > 128)) {
    throw new TypeError('Invalid preferred account id')
  }
  if (Object.hasOwn(patch, 'storageReservePercent') && (!Number.isInteger(patch.storageReservePercent) || patch.storageReservePercent < 0 || patch.storageReservePercent > 50)) {
    throw new TypeError('Storage reserve must be between 0 and 50 percent')
  }
  if (Object.hasOwn(patch, 'launchAtLogin') && typeof patch.launchAtLogin !== 'boolean') throw new TypeError('Invalid launch at login setting')
  if (Object.hasOwn(patch, 'autoUpdateCheck') && typeof patch.autoUpdateCheck !== 'boolean') throw new TypeError('Invalid automatic update setting')
  const settings = settingsStore.update(patch)
  if (Object.hasOwn(patch, 'launchAtLogin')) applyLaunchAtLogin()
  if (Object.hasOwn(patch, 'autoUpdateCheck')) updateService?.setAutoCheck(settings.autoUpdateCheck)
  try {
    await configureSyncService()
  } catch (error) {
    publishSyncStatus({ status: 'error', message: error.message, code: error.code })
    throw error
  }
  return settings
})

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  // Keep the Windows taskbar identity consistent between dev and packaged builds,
  // so Windows uses the app's icon instead of falling back to electron.exe's.
  app.setAppUserModelId('com.unitedrive.desktop')
  const userData = app.getPath('userData')
  settingsStore = createSettingsStore(path.join(userData, 'sync-settings.json'))
  syncStore = createSyncStore(path.join(userData, 'sync.sqlite'))
  tokenStore = createTokenStore(path.join(userData, 'tokens'), safeStorage)
  syncStore.recoverInterruptedOperations()
  syncStore.pruneOperations()
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents))
  loadGoogleProviders()
  createWindow()
  createTray()
  applyLaunchAtLogin()
  createUpdateService()
  void configureSyncService().catch((error) => publishSyncStatus({ status: 'error', message: error.message, code: error.code }))
  app.on('activate', () => showWindow())
})

function createGoogleProvider(accountId, email, auth, initialTokens) {
  let currentTokens = initialTokens
  auth.on('tokens', (tokens) => {
    currentTokens = { ...currentTokens, ...tokens, refresh_token: tokens.refresh_token ?? currentTokens.refresh_token }
    try {
      tokenStore.save(accountId, currentTokens)
    } catch (error) {
      publishSyncStatus({ status: 'error', message: `Could not securely save refreshed credentials: ${error.message}` })
    }
  })
  return new GoogleDriveProvider({ auth, accountId, email })
}

function loadGoogleProviders() {
  const clientId = settingsStore.load().googleClientId
  if (!clientId || !safeStorage.isEncryptionAvailable()) return
  let clientSecret
  try {
    clientSecret = tokenStore.load(oauthCredentialKey).clientSecret
  } catch {
    clientSecret = null
  }
  if (!clientSecret) return
  for (const account of syncStore.listAccounts()) {
    try {
      const tokens = tokenStore.load(account.id)
      const auth = new google.auth.OAuth2({ clientId, clientSecret })
      auth.setCredentials(tokens)
      driveProviders.set(account.id, createGoogleProvider(account.id, account.email, auth, tokens))
    } catch {
      driveProviders.delete(account.id)
    }
  }
}

async function setSyncEnabledFromTray(enabled) {
  settingsStore.update({ syncEnabled: enabled })
  broadcastSettings()
  try {
    await configureSyncService()
  } catch (error) {
    publishSyncStatus({ status: 'error', message: error.message, code: error.code })
  }
  refreshTrayMenu()
}

function broadcastSettings() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('unite-drive:settings-changed', settingsStore.load())
}

function applyLaunchAtLogin() {
  const { launchAtLogin } = settingsStore.load()
  const options = app.isPackaged
    ? { openAtLogin: launchAtLogin }
    : { openAtLogin: launchAtLogin, path: process.execPath, args: [app.getAppPath()] }
  try {
    app.setLoginItemSettings(options)
  } catch (error) {
    console.error(`[Unite Drive] Could not update launch at login: ${error.message}`)
  }
}

function buildTrayMenu() {
  const settings = settingsStore.load()
  const visible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized())
  return Menu.buildFromTemplate([
    { label: visible ? 'Hide Unite Drive' : 'Show Unite Drive', click: () => toggleWindow() },
    { type: 'separator' },
    {
      label: 'Sync now',
      click: () => { void runSyncNow().catch((error) => publishSyncStatus({ status: 'error', message: error.message, code: error.code })) },
    },
    {
      label: settings.syncEnabled ? 'Pause syncing' : 'Resume syncing',
      click: () => { void setSyncEnabledFromTray(!settings.syncEnabled) },
    },
    { type: 'separator' },
    { label: 'Check for updates', click: () => { showWindow(); void updateService?.checkForUpdates({ manual: true }) } },
    { label: 'Quit Unite Drive', click: () => quitApp() },
  ])
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu())
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'))
    tray = new Tray(icon)
  } catch (error) {
    console.error(`[Unite Drive] Could not create the tray icon: ${error.message}`)
    return
  }
  tray.setToolTip('Unite Drive')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', () => toggleWindow())
}

function quitApp() {
  isQuitting = true
  app.quit()
}

async function configureSyncService({ awaitInitialSync = true } = {}) {
  if (syncService) {
    await syncService.stop()
    syncService = null
  }
  const settings = settingsStore.load()
  if (!settings.syncEnabled || !settings.folderPath || driveProviders.size === 0) {
    publishSyncStatus({ status: 'paused' })
    refreshTrayMenu()
    return
  }
  const engine = createSyncEngine(settings)
  syncService = new SyncService(engine, {
    rootPath: settings.folderPath,
    onStatus: publishSyncStatus,
  })
  await syncService.start({ awaitInitialSync })
  refreshTrayMenu()
}

function createSyncEngine(settings) {
  return new SyncEngine({
    rootPath: settings.folderPath,
    store: syncStore,
    providers: [...driveProviders.values()],
    settings,
    trashLocal: (filePath) => shell.trashItem(filePath),
  })
}

// Reads electron-updater lazily so a missing or unsupported updater only
// downgrades update checks to the "unsupported" status instead of stopping the
// app from starting.
function createUpdateService() {
  let updater = null
  try {
    ({ autoUpdater: updater } = require('electron-updater'))
  } catch (error) {
    console.error(`[Unite Drive] Automatic updates unavailable: ${error.message}`)
  }
  updateService = new UpdateService({
    updater,
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    onStatus: publishUpdateStatus,
  })
  updateService.start({ autoCheck: settingsStore.load().autoUpdateCheck })
}

function publishUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('unite-drive:update-status', status)
  if (status.state === 'downloaded' && status.version && status.version !== lastUpdateNoticeVersion) {
    lastUpdateNoticeVersion = status.version
    try {
      new Notification({
        title: 'Update ready to install',
        body: `Unite Drive ${status.version} has been downloaded. Use Restart to update in Settings, or it installs the next time you quit.`,
      }).show()
    } catch {
      // Notifications can be unavailable (for example without a display server); ignore.
    }
  }
}

function publishSyncStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('unite-drive:sync-status', status)
}

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  // Keep running in the system tray so syncing continues in the background.
  if (isQuitting || !tray) app.quit()
})
