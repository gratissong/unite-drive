const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function createTokenStore(directory, safeStorage) {
  function encryptedPath(accountId) {
    const id = crypto.createHash('sha256').update(accountId).digest('hex')
    return path.join(directory, `${id}.token`)
  }

  function assertEncryptionAvailable() {
    if (!safeStorage?.isEncryptionAvailable()) {
      const error = new Error('OS-backed credential encryption is unavailable')
      error.code = 'TOKEN_ENCRYPTION_UNAVAILABLE'
      throw error
    }
  }

  function save(accountId, tokens) {
    assertEncryptionAvailable()
    fs.mkdirSync(directory, { recursive: true })
    const destination = encryptedPath(accountId)
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`
    const encrypted = safeStorage.encryptString(JSON.stringify(tokens))
    try {
      fs.writeFileSync(temporary, encrypted, { mode: 0o600 })
      fs.renameSync(temporary, destination)
    } catch (error) {
      fs.rmSync(temporary, { force: true })
      throw error
    }
  }

  function load(accountId) {
    assertEncryptionAvailable()
    const encrypted = fs.readFileSync(encryptedPath(accountId))
    return JSON.parse(safeStorage.decryptString(encrypted))
  }

  function remove(accountId) {
    fs.rmSync(encryptedPath(accountId), { force: true })
  }

  return { load, remove, save }
}

module.exports = { createTokenStore }
