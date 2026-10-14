# Unite Drive

Desktop storage dashboard that keeps **one local folder** in sync across
**multiple Google Drive accounts**. Electron main process written as plain
CommonJS (no bundler) plus a React 19 / Vite renderer in TypeScript. Windows is
the target platform.

Read this before exploring: it maps the modules and states the sync invariants
that are easy to break.

## Commands

| Task | Command |
| --- | --- |
| Typecheck + build renderer | `npm run build` |
| Tests (`node --test`) | `npm test` |
| Lint (`oxlint`) | `npm run lint` |
| Run the app in dev | `npm run desktop` |
| Windows installer | `npm run dist:win` |

Before calling backend work done, run `npm run lint` **and** `npm test`. Also run
`npm run build` whenever you touch `src/` — `tsc -b` catches renderer type errors
that lint/test do not. `dist/` and `release/` are generated and gitignored; never
hand-edit them.

## Architecture

`electron/` (main process):

- `main.cjs` — Electron entry: window, tray, IPC handlers, lifecycle, wiring.
- `preload.cjs` — context bridge; defines the `window.uniteDrive` API surface.
- `sync-engine.cjs` — `SyncEngine`. The core: reconcile local vs. remote, plan,
  enqueue, and run operations.
- `sync-policy.cjs` — `planSyncAction`: pure per-file decision from
  baseline/local/remote state to an action.
- `first-sync.cjs` — `planFirstSync` and `createConflictPath` for files with no
  baseline yet.
- `sync-store.cjs` — `createSyncStore`: SQLite manifest (`files`, `operations`,
  `accounts`) plus `normalizeRelativePath` / `hasUnsafeSegment`.
- `sync-runner.cjs` — executes queued operations with retry/backoff.
- `sync-service.cjs` — orchestrates filesystem watching and polling.
- `sync-settings.cjs` — settings store for `sync-settings.json`.
- `google-drive-provider.cjs` — `GoogleDriveProvider`: the Drive REST adapter
  (list/download/upload/rename/trash/quota/changes + `appProperties`).
- `google-oauth.cjs`, `google-oauth-config.cjs`, `token-store.cjs` — OAuth flow
  and OS-encrypted (`safeStorage`) token storage.
- `fake-drive-provider.cjs` — in-memory `FakeDriveProvider` used by tests.
- `file-ops.cjs` — hashing, scanning, atomic writes, safe-path and trash helpers.
- `explorer-ops.cjs` — Explorer-tab file operations.
- `similar-scanner.cjs` (`scanSimilarGroups`), `rebalance.cjs` (`planRebalance`),
  `update-service.cjs` (electron-updater).

`src/` (renderer): `App.tsx` holds every page. Feature components
(`SyncPolicyControls`, `GoogleConnectionControls`, `ExplorerTab`, `DedupeReport`,
`SimilarReport`, `RebalanceReport`, `ConfirmDialog`) sit beside `Design.css` (the
real stylesheet) and `App.css` / `index.css`.

## Sync invariants (do not break)

- A `files` row in state `tombstone` or `forgotten` is bookkeeping only. It must
  never be reconciled or fed back into the planner, or deliberately removed files
  resurrect.
- One Drive file id maps to exactly one row. A rename retires the source row as
  `forgotten` with `drive_file_id = null`; `knownDriveIds` (every id ever tracked)
  keeps the old Drive copy from being re-adopted or re-downloaded.
- A remote that Drive **lists** but cannot be read must stay in the listing as
  `{ hash: null, unreadable: true }`. The reconciler skips those rows and excludes
  them from `untrackedRemote`. Reading absence as deletion previously caused large,
  wrong `trash-local` runs — never regress this.
- Deletion behavior is intentional, not a bug: with
  `deletionPolicy: propagate-to-trash`, a remote that is genuinely gone trashes the
  local copy, and a local that is genuinely gone trashes the remote.
- The changes feed drives incremental sync. A missing cursor forces an
  authoritative re-list. Only clear `changes_page_token` when you actually intend
  a full authoritative reconcile, and only on a build that has the unreadable-file
  guard.
- Keep pure decision modules (`sync-policy`, `first-sync`, `rebalance`) free of
  I/O so a preview and the applied run agree exactly.

## Live data & runtime

- Runtime data lives in `%APPDATA%\unite-drive\`: `sync.sqlite` (manifest + the
  operation queue), `sync-settings.json`, and `tokens/`.
- The app runs as a **tray app**. Before editing that database or reinstalling,
  stop every `Unite Drive` process. Install the built NSIS package silently with
  `/S`.
- Recovery rule: to force a re-download of a missing file, re-insert its row as
  `active` with `baseline_hash = NULL`; the idle path synthesizes a present remote
  and queues a non-destructive download.

## Conventions

- Main process is CommonJS (`.cjs`); renderer is TypeScript + React. Match the
  existing style; do not add a bundler or TS to the main process.
- Tests live next to their module as `*.test.cjs` and run under `node --test`;
  sync-engine tests use `FakeDriveProvider`. Add a regression test with each fix.
- `main` is protected: land work through a PR and squash-merge only after the
  required `ci` check (lint + test on `windows-latest`) is green. No direct pushes.
