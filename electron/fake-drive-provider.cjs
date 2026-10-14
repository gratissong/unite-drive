const crypto = require('node:crypto')
const { Readable } = require('node:stream')

class FakeDriveProvider {
  constructor({ accountId, email, quotaBytes = 1024 ** 3, rootFolderId = `root-${accountId}`, files = [], trackChanges = false }) {
    this.accountId = accountId
    this.email = email
    this.quotaBytes = quotaBytes
    this.rootFolderId = rootFolderId
    this.files = new Map()
    this.operationFiles = new Map()
    this.failures = new Map()
    this.nextFileNumber = 1
    this.changesCapable = trackChanges
    this.listCalls = 0
    this._changeSeq = 0
    this._changeLog = []
    for (const file of files) this.seedFile(file)
  }

  async ensureManagedRoot() {
    return { rootFolderId: this.rootFolderId, quotaBytes: this.quotaBytes }
  }

  async getQuota() {
    const usageBytes = [...this.files.values()].reduce((total, file) => total + file.size, 0)
    return { limitBytes: this.quotaBytes, usageBytes }
  }

  async listManagedFiles() {
    this.#maybeFail('listManagedFiles')
    this.listCalls += 1
    return [...this.files.values()]
      .filter((file) => !file.trashed)
      .map((file) => ({ ...file, rootFolderId: this.rootFolderId }))
  }

  async uploadFile({ rootFolderId, relativePath, readable, size, hash, driveFileId, idempotencyKey }) {
    try {
      this.#maybeFail('uploadFile')
    } catch (error) {
      readable.destroy()
      throw error
    }
    const chunks = []
    for await (const chunk of readable) chunks.push(Buffer.from(chunk))
    const content = Buffer.concat(chunks)
    if (content.length !== size) throw new Error('Upload size changed during transfer')
    const actualHash = crypto.createHash('sha256').update(content).digest('hex')
    if (hash && actualHash !== hash) throw new Error('Upload content hash changed during transfer')
    if (rootFolderId !== this.rootFolderId) throw new Error('Upload target is outside the managed root')

    const idempotentFileId = idempotencyKey && this.operationFiles.get(idempotencyKey)
    const existingId = driveFileId ?? idempotentFileId
    const existing = existingId ? this.files.get(existingId) : null
    const usage = (await this.getQuota()).usageBytes - (existing?.size ?? 0)
    if (usage + content.length > this.quotaBytes) {
      const error = new Error('Insufficient storage')
      error.code = 'INSUFFICIENT_STORAGE'
      throw error
    }

    const id = existingId ?? `fake-${this.nextFileNumber++}`
    const file = {
      accountId: this.accountId,
      driveFileId: id,
      rootFolderId: this.rootFolderId,
      relativePath,
      hash: actualHash,
      md5Checksum: crypto.createHash('md5').update(content).digest('hex'),
      size: content.length,
      modifiedAt: new Date().toISOString(),
      trashed: false,
      content,
    }
    this.files.set(id, file)
    this.#recordChange(id, false)
    if (idempotencyKey) this.operationFiles.set(idempotencyKey, id)
    return this.#metadata(file)
  }

  async downloadFile(driveFileId) {
    this.#maybeFail('downloadFile')
    const file = this.#requireFile(driveFileId)
    if (file.trashed) throw new Error('File is in trash')
    return { readable: Readable.from([Buffer.from(file.content)]), hash: file.hash, modifiedAt: file.modifiedAt, size: file.size }
  }

  async renameFile(driveFileId, relativePath) {
    this.#maybeFail('renameFile')
    const file = this.#requireFile(driveFileId)
    file.relativePath = relativePath
    file.modifiedAt = new Date().toISOString()
    this.#recordChange(driveFileId, false)
    return this.#metadata(file)
  }

  async trashFile(driveFileId) {
    this.#maybeFail('trashFile')
    const file = this.#requireFile(driveFileId)
    file.trashed = true
    this.#recordChange(driveFileId, false)
    return this.#metadata(file)
  }

  async restoreFile(driveFileId) {
    this.#maybeFail('restoreFile')
    const file = this.#requireFile(driveFileId)
    file.trashed = false
    this.#recordChange(driveFileId, false)
    return this.#metadata(file)
  }

  async deleteFile(driveFileId) {
    this.#maybeFail('deleteFile')
    this.#requireFile(driveFileId)
    this.files.delete(driveFileId)
    this.#recordChange(driveFileId, true)
  }

  failNext(method, error = new Error(`Injected ${method} failure`), times = 1) {
    this.failures.set(method, { error, times })
  }

  seedFile({ relativePath, content, driveFileId = `fake-${this.nextFileNumber++}`, modifiedAt = new Date().toISOString(), trashed = false }) {
    const buffer = Buffer.from(content)
    const file = {
      accountId: this.accountId,
      driveFileId,
      rootFolderId: this.rootFolderId,
      relativePath,
      hash: crypto.createHash('sha256').update(buffer).digest('hex'),
      md5Checksum: crypto.createHash('md5').update(buffer).digest('hex'),
      size: buffer.length,
      modifiedAt,
      trashed,
      content: buffer,
    }
    this.files.set(driveFileId, file)
    this.#recordChange(driveFileId, false)
    return this.#metadata(file)
  }

  async getStartPageToken() {
    if (!this.changesCapable) throw new Error('changes feed not enabled')
    return String(this._changeSeq + 1)
  }

  async listChanges({ pageToken }) {
    if (!this.changesCapable) throw new Error('changes feed not enabled')
    const from = Number(pageToken) || 1
    return {
      changes: this._changeLog
        .filter((entry) => entry.seq >= from)
        .map((entry) => ({ fileId: entry.fileId, time: entry.time, removed: entry.removed, file: entry.file })),
      nextPageToken: null,
      newStartPageToken: String(this._changeSeq + 1),
    }
  }

  // Simulate an out-of-band Drive edit so the engine's change feed notices it.
  mutateRemote(driveFileId, { content, relativePath, trashed } = {}) {
    const file = this.#requireFile(driveFileId)
    if (content !== undefined) {
      const buffer = Buffer.from(content)
      file.content = buffer
      file.hash = crypto.createHash('sha256').update(buffer).digest('hex')
      file.md5Checksum = crypto.createHash('md5').update(buffer).digest('hex')
      file.size = buffer.length
    }
    if (relativePath !== undefined) file.relativePath = relativePath
    if (trashed !== undefined) file.trashed = trashed
    file.modifiedAt = new Date().toISOString()
    this.#recordChange(driveFileId, false)
    return this.#metadata(file)
  }

  deleteRemote(driveFileId) {
    this.#requireFile(driveFileId)
    this.files.delete(driveFileId)
    this._changeSeq += 1
    this._changeLog.push({ seq: this._changeSeq, fileId: driveFileId, time: new Date().toISOString(), removed: true, file: null })
  }

  #recordChange(fileId, removed = false) {
    if (!this.changesCapable) return
    this._changeSeq += 1
    this._changeLog.push({ seq: this._changeSeq, fileId, time: new Date().toISOString(), removed, file: removed ? null : { id: fileId } })
  }

  #requireFile(driveFileId) {
    const file = this.files.get(driveFileId)
    if (!file) {
      const error = new Error(`Remote file not found: ${driveFileId}`)
      error.code = 'FILE_NOT_FOUND'
      throw error
    }
    return file
  }

  #metadata(file) {
    const { content: _content, ...metadata } = file
    return { ...metadata }
  }

  #maybeFail(method) {
    const failure = this.failures.get(method)
    if (!failure) return
    failure.times -= 1
    if (failure.times <= 0) this.failures.delete(method)
    throw failure.error
  }
}

module.exports = { FakeDriveProvider }
