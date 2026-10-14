# Unite Drive

Windows desktop app for syncing one local folder with multiple Google Drive accounts as a pooled storage space.

## Run and package

- `npm run desktop` starts the Electron app and Vite dev server.
- `npm test` runs the sync, fake-provider, OAuth, and token-storage tests.
- `npm run lint` runs Oxlint.
- `npm run dist:win` creates the x64 Windows installer under `release/`.

## Google OAuth setup

1. Create or select a project in Google Cloud Console and enable the Google Drive API.
2. Configure the OAuth consent screen for the intended users.
3. Create an OAuth client with application type **Desktop app** and download its JSON credentials file.
4. In Unite Drive, open **Settings**, choose **Import credentials JSON**, select that downloaded file, then connect each account. The client secret is encrypted locally and never shown in the interface.
5. Choose a local folder and enable sync.

The app requests full Google Drive access (`auth/drive`) plus `openid`, `email`, and `profile`. `auth/drive` is the minimum scope that still enables two-way sync of files you add directly inside the managed folder: Google's `drive.file` scope only covers files opened or shared through a picker, and there is no folder-scoped write scope, so the app deliberately requests only `drive` (which subsumes `drive.file` and `drive.metadata.readonly`). It creates a `Unite Drive` folder on each account and scans binary files in that folder tree, including files you add yourself. Files are assigned to the connected account with enough remaining space, respecting the configured reserve. The **File routing** settings can turn off automatic selection and pick a default drive for new files (used whenever it has room); files already assigned to a drive are never moved automatically — the explicit **Rebalance drives** action described below is how you relocate them — and a full default drive falls back to the most available one.

Full access is what enables two-way sync of manually-added files (reading their contents, adopting them, and writing local edits back). Accounts connected with the older `drive.file`-only scope must be **reconnected once** to grant the broader scope. Until then, the app skips files it cannot read, keeps the rest of the sync running, and shows a "Reconnect for two-way sync" notice instead of failing the whole sync.

Refresh tokens and the Desktop client secret are encrypted with Electron `safeStorage` and kept in the current Windows user profile. OAuth callbacks use a temporary loopback HTTP listener, state validation, and PKCE S256. No backend service is used.

Connected accounts can be removed from the **Accounts** page (trash icon on the account card) or **Settings** (Remove on the account row). Removing an account forgets its encrypted credentials and local sync mapping on this device and leaves the files already in Google Drive untouched; the local folder is re-scanned and routed to the remaining accounts. Removing the last account pauses sync.

## Rebalancing drives

When one account is nearly full and another has room — for example right after you connect a new account — **Storage → Rebalance drives** moves files off the fuller accounts onto the emptier ones so every drive ends up at roughly the same percentage full.

- The panel previews the exact plan first: which files, on which drives, and how much data in total. Nothing moves until you confirm.
- An optional **Maximum data to move** cap limits a single run; the plan says when the cap was applied.
- Each file is copied to the target account from the local sync folder and checked against Google's checksum, then the source copy is **permanently deleted**. Google Drive's trash still counts against your quota, so trashing the source would not free space right away. Nothing is lost: the file still exists on the new drive and in your local folder.
- Moves are ordinary queued transfers, so they appear in **Transfers**, retry on temporary errors, and can be cancelled before they start. The local copy and the manifest mapping are updated only after the new copy is stored.
- A file that changed locally after the plan was built is left where it is and reconciled by the next normal sync. Accounts reporting an unmetered (unlimited) quota are not part of the balancing.
- Only files Unite Drive manages can move. If a nearly-full drive's space is used by Gmail, Google Photos, or files outside your sync folder, rebalancing can't free it — the panel flags that drive and tells you how much space Unite Drive manages on it.

## Sync safety behavior

- First sync merges existing local files with files inside app-managed Drive roots. Matching hashes are adopted; divergent versions are preserved with conflict-copy names. First sync never propagates deletions.
- Later conflicts default to **Keep both versions**. The alternatives are to prefer this PC or Google Drive.
- Deletions default to moving the other copy to its recoverable trash. Alternatively, keep the copy that remains and restore the missing side.
- Downloads are written to a temporary file and atomically renamed only after the transfer completes. Uploads use stable operation IDs, content hashes, resumable Google Drive uploads, and bounded retries.
- The local SQLite manifest records file/account mappings, content baselines, deletion tombstones, and queued operations. It lives in Electron's user-data directory.
- Changing the selected local folder after sync has started is blocked. Disable sync, reset local sync state, select the new folder, then re-enable sync. Reset clears local mappings/queued work only; it does not delete remote files.
- **Sync now** retries operations that exhausted automatic retries.
- The **Transfers** tab shows the live work queue (queued, running, retrying, failed, and recent completed transfers). Individual queued/retrying/failed items can be cancelled; an in-flight transfer cannot. Cancelling drops that work now, but the change can be re-queued on the next scan if it is still pending.
- Completed transfers are pruned automatically (kept for 7 days and the newest 200) and can also be cleared on demand from the queue.

## Background and startup

- Closing the window does not quit the app. Unite Drive keeps running in the system tray so local changes and the periodic Drive poll keep syncing; use the tray icon to reopen the window, run **Sync now**, pause or resume syncing, or quit.
- Quitting waits for any in-flight sync to finish first, so a transfer in progress is not thrown away; the app exits once the current sync cycle drains. Closing and reopening the window has no effect on syncing.
- Only one instance runs at a time. Launching the app again focuses the existing window instead of starting a second sync watcher against the same folder.
- **Launch at login** (Settings → Background & startup) starts Unite Drive when you sign in to Windows. The preference is stored with the other settings and applied immediately.

## Updates

The installed app can check GitHub Releases for a newer version and install it in the background. It reads the `app-update.yml` manifest that electron-builder generates from the `build.publish` GitHub remote, and reports an "unsupported" status when running from source.

- Shortly after launch, and periodically while the app runs, Unite Drive checks for a newer release, downloads it, and installs it the next time you quit. **Settings → Updates** shows the installed version and current status, offers **Check for updates**, and shows **Restart to update** once a download finishes. **Automatically check for updates** can be turned off; a manual check is still available from Settings and the tray menu.
- The update feed is read anonymously, so the repository (or at least its releases) must be **public**.
- To publish a release, bump `version` in `package.json`, merge that to `main`, then push a matching tag — for example `git tag v1.0.1; git push origin v1.0.1`. The **Release** workflow builds the installer and attaches it, `latest.yml`, and the blockmap to a GitHub Release tagged `v<version>`. The tag must match `version`. You can also publish from your machine with `npm run release:win` (set `GH_TOKEN` to a token with `repo` scope) as a fallback.
- Windows installers are not code signed. electron-updater checks a downloaded installer against `publisherName` only when signing is configured, so unsigned builds still update, but Windows shows a SmartScreen warning on install. Only the installed NSIS build can self-update; the portable executable cannot.

## Current limitations

- Google Drive native Docs/Sheets/Slides export and conversion are not implemented; binary files are supported. Rebalancing moves binary file bytes only, and file-level sharing/permissions on the original copy are not carried over to the new copy.
- The app watches local changes and polls Drive periodically; it does not use Drive push notifications.
- Conflict copies and the app-owned Drive folder are intended to be managed by Unite Drive; do not independently reorganize those folders during sync.
