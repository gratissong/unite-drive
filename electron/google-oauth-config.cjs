function parseDesktopOAuthCredentials(jsonText) {
  let credentials
  try {
    credentials = JSON.parse(jsonText)
  } catch {
    const error = new Error('The selected file is not valid JSON')
    error.code = 'INVALID_OAUTH_JSON'
    throw error
  }

  const installed = credentials?.installed
  if (!installed) {
    const error = new Error('Choose the OAuth JSON downloaded for a Desktop app, not a Web application client')
    error.code = 'DESKTOP_OAUTH_CLIENT_REQUIRED'
    throw error
  }

  const clientId = installed.client_id
  const clientSecret = installed.client_secret
  if (typeof clientId !== 'string' || !clientId.endsWith('.apps.googleusercontent.com')) {
    const error = new Error('The Desktop app OAuth JSON is missing a valid client ID')
    error.code = 'INVALID_OAUTH_CLIENT_ID'
    throw error
  }
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) {
    const error = new Error('The Desktop app OAuth JSON is missing its client secret')
    error.code = 'OAUTH_CLIENT_SECRET_REQUIRED'
    throw error
  }

  return { clientId, clientSecret }
}

module.exports = { parseDesktopOAuthCredentials }
