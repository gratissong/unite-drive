const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createSettingsStore, defaults } = require('./sync-settings.cjs')

test('persists sync folder and policy settings', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unite-drive-settings-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = createSettingsStore(path.join(directory, 'sync-settings.json'))
  const updated = store.update({ folderPath: path.join(directory, 'files'), conflictPolicy: 'prefer-remote' })

  assert.equal(updated.deletionPolicy, defaults.deletionPolicy)
  assert.deepEqual(store.load(), updated)
})

test('falls back to safe defaults for invalid policies', () => {
  const normalized = require('./sync-settings.cjs').normalizeSettings({ folderPath: 12, conflictPolicy: 'overwrite', deletionPolicy: 'erase' })
  assert.deepEqual(normalized, defaults)
})

test('persists the automatic routing preference and default drive', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unite-drive-settings-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = createSettingsStore(path.join(directory, 'sync-settings.json'))
  const updated = store.update({ autoRoute: false, preferredAccountId: 'drive-a' })

  assert.equal(updated.autoRoute, false)
  assert.equal(updated.preferredAccountId, 'drive-a')
  assert.deepEqual(store.load(), updated)

  assert.equal(store.update({ preferredAccountId: null }).preferredAccountId, null)
})

test('treats only an explicit false as disabling automatic routing', () => {
  const { normalizeSettings } = require('./sync-settings.cjs')
  assert.equal(normalizeSettings({}).autoRoute, true)
  assert.equal(normalizeSettings({ autoRoute: 'no' }).autoRoute, true)
  assert.equal(normalizeSettings({ autoRoute: false }).autoRoute, false)
  assert.equal(normalizeSettings({ preferredAccountId: 12 }).preferredAccountId, null)
  assert.equal(normalizeSettings({ preferredAccountId: 'drive-a' }).preferredAccountId, 'drive-a')
})

test('persists the launch at login preference', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unite-drive-settings-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = createSettingsStore(path.join(directory, 'sync-settings.json'))

  assert.equal(store.load().launchAtLogin, false)
  assert.equal(store.update({ launchAtLogin: true }).launchAtLogin, true)
  assert.equal(store.load().launchAtLogin, true)
  assert.equal(store.update({ launchAtLogin: 'yes' }).launchAtLogin, false)
})

test('persists the automatic update check preference', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unite-drive-settings-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = createSettingsStore(path.join(directory, 'sync-settings.json'))

  assert.equal(store.load().autoUpdateCheck, true)
  assert.equal(store.update({ autoUpdateCheck: false }).autoUpdateCheck, false)
  assert.equal(store.load().autoUpdateCheck, false)
  assert.equal(store.update({ autoUpdateCheck: 'no' }).autoUpdateCheck, true)
})

test('persists the sync interval preference', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unite-drive-settings-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = createSettingsStore(path.join(directory, 'sync-settings.json'))

  assert.equal(store.load().syncIntervalMinutes, 1)
  assert.equal(store.update({ syncIntervalMinutes: 5 }).syncIntervalMinutes, 5)
  assert.equal(store.update({ syncIntervalMinutes: 'invalid' }).syncIntervalMinutes, 1)
  assert.equal(store.update({ syncIntervalMinutes: 0 }).syncIntervalMinutes, 1)
  assert.equal(store.update({ syncIntervalMinutes: 121 }).syncIntervalMinutes, 120)
})
