const test = require('node:test')
const assert = require('node:assert/strict')

const { UpdateService } = require('./update-service.cjs')

function fakeUpdater() {
  const handlers = new Map()
  return {
    autoDownload: null,
    autoInstallOnAppQuit: false,
    calls: { check: 0, download: 0, install: 0 },
    on(event, handler) { handlers.set(event, handler); return this },
    emit(event, payload) { handlers.get(event)?.(payload) },
    async checkForUpdates() { this.calls.check += 1; return { updateInfo: { version: '2.0.0' } } },
    async downloadUpdate() { this.calls.download += 1; return ['update.exe'] },
    quitAndInstall() { this.calls.install += 1 },
  }
}

function fakeTimers() {
  const timeouts = new Map()
  const intervals = new Map()
  let nextId = 0
  return {
    timers: {
      setTimeout: (fn, ms) => { const id = ++nextId; timeouts.set(id, { fn, ms }); return id },
      clearTimeout: (id) => timeouts.delete(id),
      setInterval: (fn, ms) => { const id = ++nextId; intervals.set(id, { fn, ms }); return id },
      clearInterval: (id) => intervals.delete(id),
    },
    fireTimeouts() {
      const entries = [...timeouts.values()]
      timeouts.clear()
      for (const { fn } of entries) fn()
    },
    counts() { return { timeouts: timeouts.size, intervals: intervals.size } },
  }
}

test('reports unsupported when not packaged and never touches the updater', async () => {
  const updater = fakeUpdater()
  const statuses = []
  const service = new UpdateService({ updater, isPackaged: false, onStatus: (status) => statuses.push(status) })

  assert.equal(service.start().state, 'unsupported')
  const status = await service.checkForUpdates({ manual: true })
  assert.equal(status.state, 'unsupported')
  assert.equal(updater.calls.check, 0)
  assert.equal(statuses.at(-1).state, 'unsupported')
})

test('schedules an automatic check and applies updater preferences', async () => {
  const updater = fakeUpdater()
  const timers = fakeTimers()
  const service = new UpdateService({ updater, isPackaged: true, currentVersion: '1.0.0', checkDelayMs: 10, intervalMs: 10, timers: timers.timers })

  service.start()
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.autoInstallOnAppQuit, true)
  assert.deepEqual(timers.counts(), { timeouts: 1, intervals: 1 })
  assert.equal(updater.calls.check, 0)

  timers.fireTimeouts()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(updater.calls.check, 1)
})

test('honours the automatic-check preference', () => {
  const updater = fakeUpdater()
  const timers = fakeTimers()
  const service = new UpdateService({ updater, isPackaged: true, timers: timers.timers })

  service.start({ autoCheck: false })
  assert.deepEqual(timers.counts(), { timeouts: 0, intervals: 0 })

  service.setAutoCheck(true)
  assert.deepEqual(timers.counts(), { timeouts: 1, intervals: 1 })

  service.setAutoCheck(false)
  assert.deepEqual(timers.counts(), { timeouts: 0, intervals: 0 })

  service.stop()
})

test('maps updater events into a readable status machine', () => {
  const updater = fakeUpdater()
  const service = new UpdateService({ updater, isPackaged: true, currentVersion: '1.0.0' })
  service.start()

  updater.emit('checking-for-update')
  assert.equal(service.getStatus().state, 'checking')

  updater.emit('update-available', { version: '1.2.0' })
  assert.equal(service.getStatus().state, 'available')
  assert.equal(service.getStatus().version, '1.2.0')

  updater.emit('download-progress', { percent: 42.6 })
  assert.equal(service.getStatus().state, 'downloading')
  assert.equal(service.getStatus().percent, 43)

  updater.emit('update-downloaded', { version: '1.2.0' })
  assert.equal(service.getStatus().state, 'downloaded')
  assert.equal(service.getStatus().percent, 100)

  updater.emit('update-not-available')
  assert.equal(service.getStatus().state, 'up-to-date')

  updater.emit('error', new Error('offline'))
  assert.equal(service.getStatus().state, 'error')
  assert.equal(service.getStatus().message, 'offline')
})

test('a failing manual check resolves to an error status instead of throwing', async () => {
  const updater = fakeUpdater()
  updater.checkForUpdates = async () => { throw new Error('no network') }
  const service = new UpdateService({ updater, isPackaged: true, currentVersion: '1.0.0' })

  const status = await service.checkForUpdates({ manual: true })
  assert.equal(status.state, 'error')
  assert.equal(status.message, 'no network')
})

test('installs only once an update has been downloaded', () => {
  const updater = fakeUpdater()
  const service = new UpdateService({ updater, isPackaged: true, currentVersion: '1.0.0' })
  service.start()

  assert.equal(service.installUpdate(), false)
  assert.equal(updater.calls.install, 0)

  updater.emit('update-downloaded', { version: '1.2.0' })
  assert.equal(service.installUpdate(), true)
  assert.equal(updater.calls.install, 1)
})

test('downloadUpdate delegates to the updater', async () => {
  const updater = fakeUpdater()
  const service = new UpdateService({ updater, isPackaged: true, currentVersion: '1.0.0' })
  await service.downloadUpdate()
  assert.equal(updater.calls.download, 1)
})
