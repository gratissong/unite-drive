const chokidar = require('chokidar')

class SyncService {
  constructor(engine, { rootPath, onStatus = () => {}, debounceMs = 800, remotePollMs = 60_000 } = {}) {
    this.engine = engine
    this.rootPath = rootPath
    this.onStatus = onStatus
    this.debounceMs = debounceMs
    this.remotePollMs = remotePollMs
    this.watcher = null
    this.pollTimer = null
    this.debounceTimer = null
    this.currentSync = null
  }

  async start() {
    if (this.watcher) return
    this.watcher = chokidar.watch(this.rootPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 200 },
      ignored: /(^|[\\/])(?:\.unite-[^\\/]+\.(?:part|tmp)|desktop\.ini|thumbs\.db)$/i,
    })
    this.watcher.on('all', () => this.#scheduleLocalSync())
    this.watcher.on('error', (error) => this.onStatus({ status: 'error', message: error.message }))
    await new Promise((resolve, reject) => {
      this.watcher.once('ready', resolve)
      this.watcher.once('error', reject)
    })
    this.pollTimer = setInterval(() => { void this.syncNow() }, this.remotePollMs)
    this.pollTimer.unref?.()
    await this.syncNow()
  }

  async stop() {
    clearInterval(this.pollTimer)
    clearTimeout(this.debounceTimer)
    this.pollTimer = null
    this.debounceTimer = null
    const watcher = this.watcher
    this.watcher = null
    if (watcher) await watcher.close()
    if (this.currentSync) await this.currentSync.catch(() => {})
    this.onStatus({ status: 'paused' })
  }

  async syncNow(options = {}) {
    if (this.currentSync) return this.currentSync
    this.onStatus({ status: 'syncing' })
    this.currentSync = this.engine.syncOnce(options)
      .then((result) => {
        this.onStatus({ status: result.failed ? 'error' : result.retrying ? 'retrying' : 'idle', result })
        return result
      })
      .catch((error) => {
        this.onStatus({ status: 'error', message: error.message, code: error.code })
        throw error
      })
      .finally(() => { this.currentSync = null })
    return this.currentSync
  }

  #scheduleLocalSync() {
    clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.syncNow().catch(() => {})
    }, this.debounceMs)
  }
}

module.exports = { SyncService }
