class SyncRunner {
  constructor(store, handlers, { maxAttempts = 8, baseDelayMs = 1000, maxDelayMs = 5 * 60 * 1000, clock = Date.now, random = Math.random } = {}) {
    this.store = store
    this.handlers = handlers
    this.maxAttempts = maxAttempts
    this.baseDelayMs = baseDelayMs
    this.maxDelayMs = maxDelayMs
    this.clock = clock
    this.random = random
  }

  async runNext() {
    const now = this.clock()
    const operation = this.store.claimNextOperation(new Date(now).toISOString())
    if (!operation) return null
    const handler = this.handlers[operation.kind]

    try {
      if (!handler) throw new Error(`No handler registered for ${operation.kind}`)
      const result = await handler(operation)
      this.store.updateOperation(operation.id, 'completed')
      return { operationId: operation.id, state: 'completed', result }
    } catch (error) {
      if (operation.attempts >= this.maxAttempts) {
        this.store.updateOperation(operation.id, 'failed', { error })
        return { operationId: operation.id, state: 'failed', error: String(error) }
      }
      const exponentialDelay = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** (operation.attempts - 1)))
      const jitteredDelay = Math.round(exponentialDelay * (0.5 + this.random()))
      const nextAttemptAt = new Date(this.clock() + jitteredDelay).toISOString()
      this.store.updateOperation(operation.id, 'retry', { error, nextAttemptAt })
      return { operationId: operation.id, state: 'retry', nextAttemptAt, error: String(error) }
    }
  }
}

module.exports = { SyncRunner }
