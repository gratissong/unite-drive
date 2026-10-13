# Security Policy

## Supported versions

Unite Drive is under active development. Security fixes are made against the
latest release and the `main` branch only.

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Instead, use
GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
via the **Security → Report a vulnerability** tab on this repository.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The affected version (shown in **Settings → Updates** in the app).

You can expect an acknowledgement within a few days. Please allow a reasonable
window to release a fix before any public disclosure.

## Scope

Unite Drive is a local Electron app. It talks to Google Drive directly from your
machine and uses no backend service. Areas of particular interest:

- The Electron preload/IPC bridge (`electron/preload.cjs`, `electron/main.cjs`).
- Path handling in the sync engine and local explorer (`electron/file-ops.cjs`,
  `electron/explorer-ops.cjs`).
- At-rest encryption of OAuth refresh tokens and the OAuth client secret
  (`electron/token-store.cjs`).

## Handling credentials

Never paste real OAuth client secrets, refresh tokens, or access tokens into an
issue, pull request, or discussion. Redact them from logs and screenshots. If a
credential is exposed, revoke it in the Google Cloud Console and reconnect the
account in the app.
