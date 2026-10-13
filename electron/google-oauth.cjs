const http = require('node:http')
const { randomBytes } = require('node:crypto')
const { google } = require('googleapis')

// The app must read and write files the user adds directly to the managed Drive
// folder (two-way sync), not just files it uploads itself. Google only grants
// that through the broad `drive` scope: `drive.file` covers files opened or
// shared via a picker only, and there is no folder-scoped write scope.
// `drive.file` and `drive.metadata.readonly` are subsumed by `drive`, so they
// are intentionally not requested — keeping the consent screen and the access
// token at the minimum that still supports two-way sync.
const readWriteScope = 'https://www.googleapis.com/auth/drive'

const driveScopes = [
  'openid',
  'email',
  'profile',
  readWriteScope,
]

const callbackIcons = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8v5"/><path d="M12 16.5h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderCallbackPage({ tone = 'error', title, message, busy = false } = {}) {
  const palette = Object.hasOwn(callbackIcons, tone) ? tone : 'error'
  const icon = callbackIcons[palette]
  const safeTitle = escapeHtml(title ?? 'Something went wrong')
  const safeMessage = escapeHtml(message ?? 'Return to Unite Drive and try again.')
  const spinner = busy ? '\n      <div class="spinner" role="status" aria-label="Finishing sign-in"></div>' : ''
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="robots" content="noindex" />
    <title>${safeTitle} · Unite Drive</title>
    <style>
      :root { --ink: #17251f; --muted: #5c675e; --line: #e5e9e2; --brand: #2e634f; }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0; display: grid; place-items: center; padding: 24px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        color: var(--ink); -webkit-font-smoothing: antialiased;
        background: radial-gradient(1100px 520px at 50% -12%, #edf5ee 0%, #f7f9f6 46%, #eef2ec 100%);
      }
      .card {
        width: 100%; max-width: 420px; text-align: center;
        background: #fff; border: 1px solid var(--line); border-radius: 20px;
        padding: 36px 32px 32px;
        box-shadow: 0 30px 70px -40px rgba(23, 37, 31, .5), 0 2px 8px rgba(23, 37, 31, .05);
        animation: rise .4s cubic-bezier(.22, 1, .36, 1) both;
      }
      .card.success { --tone-bg: #e7f2ea; --tone-fg: #2e634f; }
      .card.warning { --tone-bg: #fbf1dd; --tone-fg: #a3701c; }
      .card.error { --tone-bg: #fbe9e7; --tone-fg: #b3261e; }
      .badge {
        width: 64px; height: 64px; margin: 0 auto 20px; border-radius: 20px;
        display: grid; place-items: center; background: var(--tone-bg); color: var(--tone-fg);
      }
      .badge svg { width: 30px; height: 30px; }
      .eyebrow {
        margin: 0 0 12px; font-size: 10px; font-weight: 700;
        letter-spacing: .22em; text-transform: uppercase; color: var(--brand);
      }
      h1 { margin: 0 0 10px; font-size: 21px; line-height: 1.28; letter-spacing: -.01em; }
      p { margin: 0; color: var(--muted); font-size: 13.5px; line-height: 1.6; }
      .spinner {
        width: 22px; height: 22px; margin: 22px auto 0; border-radius: 50%;
        border: 2.5px solid var(--line); border-top-color: var(--brand);
        animation: spin .8s linear infinite;
      }
      @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .card, .spinner { animation: none; } }
    </style>
  </head>
  <body>
    <main class="card ${palette}">
      <div class="badge">${icon}</div>
      <p class="eyebrow">Unite Drive</p>
      <h1>${safeTitle}</h1>
      <p>${safeMessage}</p>${spinner}
    </main>
  </body>
</html>
`
}

function tokensHaveFullAccess(tokens) {
  if (!tokens || typeof tokens.scope !== 'string') return false
  return tokens.scope.split(' ').includes(readWriteScope)
}

async function authorizeGoogleAccount({
  clientId,
  clientSecret,
  openExternal,
  timeoutMs = 5 * 60 * 1000,
  tokenExchangeTimeoutMs = 30 * 1000,
  createOAuthClient,
  onStatus = () => {},
} = {}) {
  if (typeof clientId !== 'string' || !clientId.trim()) throw new TypeError('A Google OAuth client ID is required')
  if (typeof openExternal !== 'function') throw new TypeError('A system-browser opener is required')

  let callbackResolve
  let callbackReject
  let expectedState
  let callbackSettled = false
  const callbackResult = new Promise((resolve, reject) => {
    callbackResolve = resolve
    callbackReject = reject
  })
  callbackResult.catch(() => {})
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1')
    if (requestUrl.pathname !== '/') {
      response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end(renderCallbackPage({ tone: 'error', title: 'Page not found', message: 'This page is only used by Unite Drive to complete Google sign-in.' }))
      return
    }
    if (requestUrl.searchParams.get('state') !== expectedState) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end(renderCallbackPage({ tone: 'error', title: 'Sign-in link expired', message: 'This sign-in link is no longer valid. Return to Unite Drive and start the connection again.' }))
      return
    }
    const authorizationError = requestUrl.searchParams.get('error')
    if (authorizationError) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end(renderCallbackPage({ tone: 'warning', title: 'Sign-in not completed', message: 'Google sign-in was cancelled or denied. You can close this tab and try again from Unite Drive.' }))
      callbackSettled = true
      callbackReject(new Error('Google authorization was cancelled or denied'))
      return
    }
    const code = requestUrl.searchParams.get('code')
    if (!code) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end(renderCallbackPage({ tone: 'error', title: 'Sign-in link incomplete', message: 'Google did not return an authorization code. Return to Unite Drive and try again.' }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end(renderCallbackPage({ tone: 'success', title: 'Authorization received', message: 'Unite Drive is finishing sign-in. You can close this tab and return to the app.', busy: true }))
    callbackSettled = true
    onStatus({ phase: 'authorization-received', message: 'Google authorization received.' })
    callbackResolve(code)
  })

  let timeout
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, 'localhost', resolve)
    })
    const address = server.address()
    const redirectUri = `http://localhost:${address.port}/`
    const OAuth2 = createOAuthClient ?? ((id, secret, redirect) => new google.auth.OAuth2({ clientId: id, clientSecret: secret, redirectUri: redirect }))
    const oauthClient = OAuth2(clientId.trim(), clientSecret, redirectUri)
    const verifier = await oauthClient.generateCodeVerifierAsync()
    expectedState = randomBytes(32).toString('base64url')
    const authorizationUrl = oauthClient.generateAuthUrl({
      access_type: 'offline',
      include_granted_scopes: true,
      prompt: 'select_account consent',
      scope: driveScopes,
      state: expectedState,
      code_challenge: verifier.codeChallenge,
      code_challenge_method: 'S256',
    })

    timeout = setTimeout(() => {
      if (callbackSettled) return
      callbackSettled = true
      callbackReject(new Error('Google sign-in timed out'))
    }, timeoutMs)
    timeout.unref?.()
    await openExternal(authorizationUrl)
    const code = await callbackResult
    onStatus({ phase: 'exchanging-code', message: 'Exchanging Google authorization code...' })
    let tokenResponse
    try {
      tokenResponse = await withTimeout(
        oauthClient.getToken({ code, codeVerifier: verifier.codeVerifier }),
        tokenExchangeTimeoutMs,
      )
    } catch (error) {
      if (error.code === 'GOOGLE_TOKEN_EXCHANGE_TIMEOUT') throw error
      const responseData = error.response?.data
      const oauthError = typeof responseData?.error === 'string' ? responseData.error : error.code
      const description = typeof responseData?.error_description === 'string'
        ? responseData.error_description
        : error.message ?? 'Google did not provide additional details'
      const exchangeError = new Error(`Google token exchange failed${oauthError ? ` (${oauthError})` : ''}: ${description}`)
      if (oauthError) exchangeError.code = oauthError
      throw exchangeError
    }
    oauthClient.setCredentials(tokenResponse.tokens)
    onStatus({ phase: 'complete', message: 'Google authorization code exchanged.' })
    return { client: oauthClient, tokens: tokenResponse.tokens }
  } finally {
    clearTimeout(timeout)
    // Stop the loopback server without delaying the result. The browser may keep
    // its connection alive, but the authorization code is already exchanged, so we
    // tear the sockets down and return instead of awaiting a graceful shutdown.
    server.close()
    server.closeAllConnections?.()
  }
}

function withTimeout(promise, timeoutMs) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Google token exchange timed out. Check your network and try again.')
      error.code = 'GOOGLE_TOKEN_EXCHANGE_TIMEOUT'
      reject(error)
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

module.exports = { authorizeGoogleAccount, driveScopes, readWriteScope, tokensHaveFullAccess, renderCallbackPage }
