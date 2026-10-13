const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { authorizeGoogleAccount, driveScopes, renderCallbackPage } = require('./google-oauth.cjs')

function createFakeOAuthClient() {
  let redirectUri
  let authOptions
  let exchangeOptions
  let credentials
  return {
    client: {
      generateCodeVerifierAsync: async () => ({ codeVerifier: 'verifier-value', codeChallenge: 'challenge-value' }),
      generateAuthUrl: (options) => {
        authOptions = options
        return 'https://accounts.google.com/o/oauth2/auth'
      },
      getToken: async (options) => {
        exchangeOptions = options
        return { tokens: { access_token: 'access', refresh_token: 'refresh' } }
      },
      setCredentials: (tokens) => { credentials = tokens },
    },
    get authOptions() { return authOptions },
    get credentials() { return credentials },
    get exchangeOptions() { return exchangeOptions },
    setRedirectUri(value) { redirectUri = value },
    get redirectUri() { return redirectUri },
  }
}

test('uses loopback PKCE, validates OAuth state, and exchanges the code', async () => {
  const fake = createFakeOAuthClient()
  let openedUrl
  const phases = []
  const result = await authorizeGoogleAccount({
    clientId: 'desktop-client-id',
    clientSecret: 'desktop-client-secret',
    onStatus: ({ phase }) => phases.push(phase),
    createOAuthClient: (clientId, clientSecret, redirectUri) => {
      assert.equal(clientId, 'desktop-client-id')
      assert.equal(clientSecret, 'desktop-client-secret')
      fake.setRedirectUri(redirectUri)
      return fake.client
    },
    openExternal: async (url) => {
      openedUrl = url
      const state = fake.authOptions.state
      const invalid = await fetch(`${fake.redirectUri}?state=wrong&code=ignored`)
      assert.equal(invalid.status, 400)
      assert.match(invalid.headers.get('content-type'), /text\/html/)
      const valid = await fetch(`${fake.redirectUri}?state=${encodeURIComponent(state)}&code=one-time-code`)
      assert.equal(valid.status, 200)
      assert.match(valid.headers.get('content-type'), /text\/html/)
      const page = await valid.text()
      assert.match(page, /finishing sign-in/)
      assert.match(page, /<main class="card success">/)
      assert.match(page, /Unite Drive/)
    },
  })

  assert.match(openedUrl, /^https:\/\/accounts\.google\.com/)
  assert.equal(new URL(fake.redirectUri).hostname, 'localhost')
  assert.equal(new URL(fake.redirectUri).pathname, '/')
  assert.equal(fake.authOptions.code_challenge_method, 'S256')
  assert.equal(fake.authOptions.code_challenge, 'challenge-value')
  assert.ok(driveScopes.includes('https://www.googleapis.com/auth/drive'))
  // Pin the exact, least-privilege scope set so future changes cannot silently
  // over-request (drive.file / drive.metadata.readonly are subsumed by drive).
  assert.deepEqual(driveScopes, ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive'])
  assert.deepEqual(fake.exchangeOptions, { code: 'one-time-code', codeVerifier: 'verifier-value' })
  assert.equal(result.tokens.refresh_token, 'refresh')
  assert.deepEqual(fake.credentials, result.tokens)
  assert.deepEqual(phases, ['authorization-received', 'exchanging-code', 'complete'])
})

test('finishes sign-in without waiting on the browser connection and asks it to close', async () => {
  const fake = createFakeOAuthClient()
  const socket = new net.Socket()
  let responseText = ''
  let timer
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timed-out'), 1500) })
    const outcome = await Promise.race([
      authorizeGoogleAccount({
        clientId: 'desktop-client-id',
        createOAuthClient: (_clientId, _clientSecret, redirectUri) => { fake.setRedirectUri(redirectUri); return fake.client },
        openExternal: async () => {
          const port = Number(new URL(fake.redirectUri).port)
          const state = encodeURIComponent(fake.authOptions.state)
          await new Promise((resolve, reject) => {
            socket.once('error', reject)
            socket.connect(port, 'localhost', () => {
              socket.write(`GET /?state=${state}&code=stubborn-code HTTP/1.1\r\nHost: localhost\r\n\r\n`)
            })
            socket.on('data', (chunk) => {
              responseText += chunk.toString()
              if (responseText.includes('Authorization received')) resolve()
            })
          })
          // Intentionally leave the socket open to mimic a browser holding the connection.
        },
      }).then(() => 'resolved'),
      timeout,
    ])
    assert.equal(outcome, 'resolved')
    assert.match(responseText, /finishing sign-in/)
    assert.match(responseText, /connection: close/i)
  } finally {
    clearTimeout(timer)
    socket.destroy()
  }
})

test('rejects authorization denied by the user', async () => {
  const fake = createFakeOAuthClient()
  await assert.rejects(authorizeGoogleAccount({
    clientId: 'desktop-client-id',
    createOAuthClient: (_clientId, _clientSecret, redirectUri) => { fake.setRedirectUri(redirectUri); return fake.client },
    openExternal: async () => {
      const response = await fetch(`${fake.redirectUri}?state=${encodeURIComponent(fake.authOptions.state)}&error=access_denied`)
      assert.equal(response.status, 400)
    },
  }), /cancelled or denied/)
})

test('requires an OAuth client ID', async () => {
  await assert.rejects(authorizeGoogleAccount({ clientId: '', openExternal: async () => {} }), /client ID is required/)
})

test('reports a token exchange timeout after the browser callback succeeds', async () => {
  const fake = createFakeOAuthClient()
  fake.client.getToken = async () => new Promise(() => {})
  const phases = []

  await assert.rejects(authorizeGoogleAccount({
    clientId: 'desktop-client-id',
    tokenExchangeTimeoutMs: 15,
    onStatus: ({ phase }) => phases.push(phase),
    createOAuthClient: (_clientId, _clientSecret, redirectUri) => { fake.setRedirectUri(redirectUri); return fake.client },
    openExternal: async () => {
      const response = await fetch(`${fake.redirectUri}?state=${encodeURIComponent(fake.authOptions.state)}&code=one-time-code`)
      assert.equal(response.status, 200)
    },
  }), { code: 'GOOGLE_TOKEN_EXCHANGE_TIMEOUT' })

  assert.deepEqual(phases, ['authorization-received', 'exchanging-code'])
})

test('includes Google token error descriptions for actionable setup diagnosis', async () => {
  const fake = createFakeOAuthClient()
  fake.client.getToken = async () => {
    const error = new Error('invalid_request')
    error.response = { data: { error: 'invalid_request', error_description: 'The redirect URI does not match.' } }
    throw error
  }

  await assert.rejects(authorizeGoogleAccount({
    clientId: 'desktop-client-id',
    createOAuthClient: (_clientId, _clientSecret, redirectUri) => { fake.setRedirectUri(redirectUri); return fake.client },
    openExternal: async () => {
      const response = await fetch(`${fake.redirectUri}?state=${encodeURIComponent(fake.authOptions.state)}&code=one-time-code`)
      assert.equal(response.status, 200)
    },
  }), /invalid_request\): The redirect URI does not match/)
})

test('escapeHtml neutralizes markup in the callback page title and message', () => {
  const page = renderCallbackPage({
    tone: 'error',
    title: '<script>alert("x")</script>',
    message: 'Failed <img src=x onerror=alert(1)> is untrusted',
  })
  // The title is escaped so no <script> element can be injected.
  assert.ok(page.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'))
  assert.ok(!page.includes('<script>'))
  // The message is escaped so no active HTML element can be injected.
  assert.ok(page.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(!page.includes('<img src=x'))
})
