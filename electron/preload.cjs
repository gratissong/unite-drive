const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('uniteDrive', {
  isDesktop: true,
  selectSyncFolder: () => ipcRenderer.invoke('unite-drive:select-sync-folder'),
  openSyncFolder: () => ipcRenderer.invoke('unite-drive:open-sync-folder'),
  getUserInfo: () => ipcRenderer.invoke('unite-drive:get-user-info'),
  addFiles: () => ipcRenderer.invoke('unite-drive:add-files'),
  listDirectory: (relativePath) => ipcRenderer.invoke('unite-drive:list-directory', relativePath),
  searchFolder: (query) => ipcRenderer.invoke('unite-drive:search-folder', query),
  createFolder: (relativePath) => ipcRenderer.invoke('unite-drive:create-folder', relativePath),
  movePath: (from, to) => ipcRenderer.invoke('unite-drive:move-path', from, to),
  movePaths: (moves) => ipcRenderer.invoke('unite-drive:move-paths', moves),
  trashPath: (relativePath) => ipcRenderer.invoke('unite-drive:trash-path', relativePath),
  trashPaths: (paths) => ipcRenderer.invoke('unite-drive:trash-paths', paths),
  revealInExplorer: (relativePath) => ipcRenderer.invoke('unite-drive:reveal-in-explorer', relativePath),
  importIntoFolder: (relativePath) => ipcRenderer.invoke('unite-drive:import-into-folder', relativePath),
  getSyncSettings: () => ipcRenderer.invoke('unite-drive:get-sync-settings'),
  getOAuthConfigStatus: () => ipcRenderer.invoke('unite-drive:get-oauth-config-status'),
  importOAuthConfig: () => ipcRenderer.invoke('unite-drive:import-oauth-config'),
  updateSyncSettings: (patch) => ipcRenderer.invoke('unite-drive:update-sync-settings', patch),
  getSyncState: () => ipcRenderer.invoke('unite-drive:get-sync-state'),
  getDriveAccounts: () => ipcRenderer.invoke('unite-drive:get-drive-accounts'),
  connectGoogleAccount: () => ipcRenderer.invoke('unite-drive:connect-google-account'),
  removeGoogleAccount: (accountId) => ipcRenderer.invoke('unite-drive:remove-google-account', accountId),
  cancelOperation: (operationId) => ipcRenderer.invoke('unite-drive:cancel-operation', operationId),
  clearCompletedOperations: () => ipcRenderer.invoke('unite-drive:clear-completed-operations'),
  syncNow: () => ipcRenderer.invoke('unite-drive:sync-now'),
  getSimilarGroups: () => ipcRenderer.invoke('unite-drive:get-similar-groups'),
  applyDedupe: (removals) => ipcRenderer.invoke('unite-drive:apply-dedupe', removals),
  resetSyncState: () => ipcRenderer.invoke('unite-drive:reset-sync-state'),
  onSyncStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('unite-drive:sync-status', listener)
    return () => ipcRenderer.removeListener('unite-drive:sync-status', listener)
  },
  onSettingsChanged: (callback) => {
    const listener = (_event, settings) => callback(settings)
    ipcRenderer.on('unite-drive:settings-changed', listener)
    return () => ipcRenderer.removeListener('unite-drive:settings-changed', listener)
  },
})
