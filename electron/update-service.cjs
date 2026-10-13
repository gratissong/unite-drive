// In-app update checking and delivery, backed by electron-updater. The updater
// instance, app version, and timers are injected so the status machine can be
// unit tested without Electron, a packaged build, or network access.
//
// Auto-update only runs from an installed build: the packaged app ships an
// app-update.yml (electron-builder writes it from the GitHub remote), which is
// what electron-updater reads to find releases. In dev there is nothing to read,
// so the service reports an "unsupported" status instead of throwing.

const DEFAULT_CHECK_DELAY_MS = 15_000
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

class UpdateService {
  constructor({
    updater = null,
    currentVersion = '0.0.0',
    isPackaged = false,
    autoDownload = true,
    checkDelayMs = DEFAULT_CHECK_DELAY_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    onStatus = () => {},
    timers = {},
  } = {}) {
    this.updater = updater
    this.currentVersion = currentVersion
    this.isPackaged = isPackaged
    this.autoDownload = autoDownload
    this.checkDelayMs = checkDelayMs
    this.intervalMs = intervalMs
    this.onStatus = onStatus
    this.setTimeoutFn = timers.setTimeout ?? setTimeout
    this.clearTimeoutFn = timers.clearTimeout ?? clearTimeout
    this.setIntervalFn = timers.setInterval ?? setInterval
    this.clearIntervalFn = timers.clearInterval ?? clearInterval
    this.status = { state: 'idle', currentVersion }
    this.autoCheckEnabled = true
    this.started = false
    this.initialTimer = null
    this.intervalTimer = null
    this.inFlight = null
    this.wired = false
  }

  getStatus() {
    return { ...this.status, currentVersion: this.currentVersion }
  }

  start({ autoCheck = true } = {}) {
    this.autoCheckEnabled = autoCheck === true
    this.started = true
    if (!this.#supported()) {
      this.#emit(this.#unsupportedStatus())
      return this.getStatus()
    }
    this.#wire()
    this.#schedule()
    return this.getStatus()
  }

  setAutoCheck(enabled) {
    this.autoCheckEnabled = enabled === true
    if (!this.started || !this.#supported()) return
    if (this.autoCheckEnabled) this.#schedule()
    else this.#clearTimers()
  }

  stop() {
    this.#clearTimers()
    this.started = false
  }

  async checkForUpdates({ manual = false } = {}) {
    if (!this.#supported()) {
      this.#emit({ ...this.#unsupportedStatus(), manual })
      return this.getStatus()
    }
    this.#wire()
    if (this.inFlight) return this.inFlight
    this.inFlight = Promise.resolve()
      .then(() => this.updater.checkForUpdates())
      .catch((error) => {
        // The updater also emits an 'error' event; swallow the rejection here so
        // a manual check surfaces the failure through status instead of throwing.
        this.#emit({ state: 'error', message: error?.message ?? String(error), manual })
      })
      .then(() => this.getStatus())
      .finally(() => { this.inFlight = null })
    return this.inFlight
  }

  async downloadUpdate() {
    if (!this.#supported()) return this.getStatus()
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      this.#emit({ state: 'error', message: error?.message ?? String(error) })
    }
    return this.getStatus()
  }

  installUpdate() {
    if (!this.#supported() || this.status.state !== 'downloaded') return false
    this.updater.quitAndInstall()
    return true
  }

  #supported() {
    return this.isPackaged === true && Boolean(this.updater)
  }

  #unsupportedStatus() {
    return {
      state: 'unsupported',
      message: this.isPackaged
        ? 'Automatic updates are not available in this build.'
        : 'Update checks run in the installed app.',
    }
  }

  #wire() {
    if (this.wired || !this.updater) return
    this.wired = true
    // Download in the background and finish installing on the next quit, so the
    // user is never interrupted mid-sync.
    this.updater.autoDownload = this.autoDownload
    try {
      this.updater.autoInstallOnAppQuit = true
    } catch {
      // Older updater versions may not expose this property; it is optional.
    }
    this.updater.on('checking-for-update', () => this.#emit({ state: 'checking', message: 'Checking GitHub for a newer release…' }))
    this.updater.on('update-available', (info) => this.#emit({ state: 'available', version: info?.version ?? null, message: `Unite Drive ${info?.version ?? ''} is available and downloading.` }))
    this.updater.on('update-not-available', () => this.#emit({ state: 'up-to-date', message: 'You are running the latest version.' }))
    this.updater.on('download-progress', (progress) => this.#emit({ state: 'downloading', percent: clampPercent(progress?.percent), message: 'Downloading update…' }))
    this.updater.on('update-downloaded', (info) => this.#emit({ state: 'downloaded', version: info?.version ?? null, percent: 100, message: `Unite Drive ${info?.version ?? ''} is ready to install.` }))
    this.updater.on('error', (error) => this.#emit({ state: 'error', message: error?.message ?? String(error) }))
  }

  #schedule() {
    this.#clearTimers()
    if (!this.autoCheckEnabled) return
    this.initialTimer = this.setTimeoutFn(() => {
      this.initialTimer = null
      void this.checkForUpdates()
    }, this.checkDelayMs)
    this.intervalTimer = this.setIntervalFn(() => { void this.checkForUpdates() }, this.intervalMs)
    // Never let update timers keep the process alive on their own.
    this.initialTimer?.unref?.()
    this.intervalTimer?.unref?.()
  }

  #clearTimers() {
    if (this.initialTimer) {
      this.clearTimeoutFn(this.initialTimer)
      this.initialTimer = null
    }
    if (this.intervalTimer) {
      this.clearIntervalFn(this.intervalTimer)
      this.intervalTimer = null
    }
  }

  // Merge into the previous status so fields like `version` survive the
  // available → downloading → downloaded progression.
  #emit(partial) {
    this.status = { ...this.status, ...partial, currentVersion: this.currentVersion, checkedAt: new Date().toISOString() }
    this.onStatus(this.getStatus())
  }
}

module.exports = { UpdateService }
