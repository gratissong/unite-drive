import { readFileSync } from 'node:fs'

import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The single source of truth for the app version is package.json, which is also
// what electron-builder stamps into the installer. Exposing it as a VITE_ env
// entry keeps the renderer's version in lockstep with the build: Vite picks up
// VITE_-prefixed process.env entries when it resolves the environment, in both
// dev and build. (A plain `define` is only substituted during `vite build`.)
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
process.env.VITE_APP_VERSION = version

// Locked-down policy for the packaged app. The renderer only loads its own
// bundled assets and talks to the main process over IPC, so no remote origins
// are allowed. Inline styles are required for React style attributes; images
// cover data URLs used for avatars and photo thumbnails.
const productionCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

// Vite's dev server and HMR need inline bootstrap scripts, injected styles, and
// a websocket back to the dev server. This policy is only used while developing.
const developmentCsp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'unite-drive-csp',
    transformIndexHtml(html, ctx) {
      const content = ctx.server ? developmentCsp : productionCsp
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content },
            injectTo: 'head-prepend',
          },
        ],
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), contentSecurityPolicy()],
  server: {
    watch: {
      ignored: ['**/release/**'],
    },
  },
})
