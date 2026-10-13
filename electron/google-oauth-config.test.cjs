const test = require('node:test')
const assert = require('node:assert/strict')
const { parseDesktopOAuthCredentials } = require('./google-oauth-config.cjs')

const desktopCredentials = JSON.stringify({ installed: {
  client_id: 'desktop.apps.googleusercontent.com',
  client_secret: 'do-not-display-this-secret',
  redirect_uris: ['http://localhost'],
} })

test('extracts client ID and secret from Desktop OAuth JSON', () => {
  assert.deepEqual(parseDesktopOAuthCredentials(desktopCredentials), {
    clientId: 'desktop.apps.googleusercontent.com',
    clientSecret: 'do-not-display-this-secret',
  })
})

test('rejects Web OAuth clients with a clear configuration error', () => {
  assert.throws(() => parseDesktopOAuthCredentials(JSON.stringify({ web: { client_id: 'web.apps.googleusercontent.com' } })), {
    code: 'DESKTOP_OAUTH_CLIENT_REQUIRED',
  })
})

test('rejects malformed JSON and missing client secrets', () => {
  assert.throws(() => parseDesktopOAuthCredentials('{'), { code: 'INVALID_OAUTH_JSON' })
  assert.throws(() => parseDesktopOAuthCredentials(JSON.stringify({ installed: { client_id: 'desktop.apps.googleusercontent.com' } })), {
    code: 'OAUTH_CLIENT_SECRET_REQUIRED',
  })
})
