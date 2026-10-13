const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createTokenStore } = require('./token-store.cjs')

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().slice('encrypted:'.length),
  }
}

test('encrypts tokens at rest and can replace and remove them', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unite-drive-tokens-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = createTokenStore(directory, fakeSafeStorage())
  const tokens = { access_token: 'access', refresh_token: 'refresh' }
  store.save('google-subject-id', tokens)
  const tokenFile = fs.readdirSync(directory)[0]

  assert.deepEqual(store.load('google-subject-id'), tokens)
  assert.equal(fs.readFileSync(path.join(directory, tokenFile), 'utf8').startsWith('encrypted:'), true)
  store.save('google-subject-id', { access_token: 'rotated' })
  assert.deepEqual(store.load('google-subject-id'), { access_token: 'rotated' })
  store.remove('google-subject-id')
  assert.equal(fs.existsSync(path.join(directory, tokenFile)), false)
})

test('refuses to write credentials without OS-backed encryption', () => {
  const store = createTokenStore(os.tmpdir(), { isEncryptionAvailable: () => false })
  assert.throws(() => store.save('account', { refresh_token: 'secret' }), { code: 'TOKEN_ENCRYPTION_UNAVAILABLE' })
})
