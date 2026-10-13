const fs = require('node:fs')
const path = require('node:path')
const { conflictPolicies, deletionPolicies } = require('./sync-policy.cjs')

const defaults = Object.freeze({
  folderPath: null,
  conflictPolicy: 'keep-both',
  deletionPolicy: 'propagate-to-trash',
  googleClientId: '',
  syncEnabled: false,
  storageReservePercent: 5,
  autoRoute: true,
  preferredAccountId: null,
  launchAtLogin: false,
})

function normalizeSettings(value) {
  return {
    folderPath: typeof value.folderPath === 'string' && value.folderPath.length ? value.folderPath : null,
    conflictPolicy: conflictPolicies.includes(value.conflictPolicy) ? value.conflictPolicy : defaults.conflictPolicy,
    deletionPolicy: deletionPolicies.includes(value.deletionPolicy) ? value.deletionPolicy : defaults.deletionPolicy,
    googleClientId: typeof value.googleClientId === 'string' ? value.googleClientId.trim().slice(0, 512) : defaults.googleClientId,
    syncEnabled: value.syncEnabled === true,
    storageReservePercent: Number.isFinite(value.storageReservePercent)
      ? Math.max(0, Math.min(50, Math.round(value.storageReservePercent)))
      : defaults.storageReservePercent,
    autoRoute: value.autoRoute !== false,
    preferredAccountId: typeof value.preferredAccountId === 'string' && value.preferredAccountId.length
      ? value.preferredAccountId.slice(0, 128)
      : null,
    launchAtLogin: value.launchAtLogin === true,
  }
}

function createSettingsStore(filePath) {
  function load() {
    try {
      return normalizeSettings(JSON.parse(fs.readFileSync(filePath, 'utf8')))
    } catch {
      return { ...defaults }
    }
  }

  function update(patch) {
    const next = normalizeSettings({ ...load(), ...patch })
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const temporaryPath = `${filePath}.tmp`
    fs.writeFileSync(temporaryPath, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(temporaryPath, filePath)
    return next
  }

  return { load, update }
}

module.exports = { createSettingsStore, defaults, normalizeSettings }
