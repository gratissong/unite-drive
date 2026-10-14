const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

const operationKinds = new Set([
  'upload',
  'download',
  'rename-remote',
  'trash-local',
  'trash-remote',
  'restore-local',
  'restore-remote',
  'keep-both',
  'move-remote',
])

// Windows reserves these as device names regardless of extension, so a path
// segment matching one cannot exist as a normal local file.
const windowsReservedNames = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

function isWindowsReservedName(segment) {
  return windowsReservedNames.has(segment.split('.')[0].toUpperCase())
}

// True when a single path segment cannot be a safe Windows file name: illegal
// characters (including the NTFS ADS separator `:` and stream actors `* ? " < > |`),
// C0 control characters, a Windows-reserved device name, or a trailing dot or
// space (which Windows silently strips, producing collisions).
function hasControlCharacter(segment) {
  for (let index = 0; index < segment.length; index += 1) {
    if (segment.charCodeAt(index) < 32) return true
  }
  return false
}

function hasUnsafeSegment(segment) {
  return (
    /[:*?"<>|]/.test(segment) ||
    hasControlCharacter(segment) ||
    /[. ]$/.test(segment) ||
    isWindowsReservedName(segment)
  )
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('A relative file path is required')
  const normalized = value.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || segments.includes('..') || segments.some(hasUnsafeSegment)) {
    throw new TypeError('File paths must use safe Windows names inside the sync root')
  }
  return normalized
}

function createSyncStore(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const database = new DatabaseSync(databasePath)
  let closed = false
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      root_folder_id TEXT,
      quota_bytes INTEGER,
      changes_page_token TEXT,
      connected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      relative_path TEXT PRIMARY KEY,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      drive_file_id TEXT,
      baseline_hash TEXT,
      size_bytes INTEGER,
      local_modified_at TEXT,
      remote_modified_at TEXT,
      sync_state TEXT NOT NULL DEFAULT 'active',
      deleted_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      account_id TEXT,
      drive_file_id TEXT,
      state TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS operations_ready_idx ON operations(state, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS files_account_idx ON files(account_id);
    CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications(created_at DESC);
  `)

  const fileColumns = database.prepare('PRAGMA table_info(files)').all()
  if (!fileColumns.some((column) => column.name === 'size_bytes')) {
    database.exec('ALTER TABLE files ADD COLUMN size_bytes INTEGER')
  }

  const upsertFileStatement = database.prepare(`
    INSERT INTO files (relative_path, account_id, drive_file_id, baseline_hash, size_bytes, local_modified_at, remote_modified_at, sync_state, deleted_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(relative_path) DO UPDATE SET
      account_id = excluded.account_id,
      drive_file_id = excluded.drive_file_id,
      baseline_hash = excluded.baseline_hash,
      size_bytes = excluded.size_bytes,
      local_modified_at = excluded.local_modified_at,
      remote_modified_at = excluded.remote_modified_at,
      sync_state = excluded.sync_state,
      deleted_at = excluded.deleted_at,
      updated_at = excluded.updated_at
  `)
  const insertOperationStatement = database.prepare(`
    INSERT INTO operations (id, kind, relative_path, account_id, drive_file_id, state, attempts, next_attempt_at, payload_json, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)

  function upsertFile(record) {
    const relativePath = normalizeRelativePath(record.relativePath)
    const now = record.updatedAt ?? new Date().toISOString()
    upsertFileStatement.run(
      relativePath,
      record.accountId ?? null,
      record.driveFileId ?? null,
      record.baselineHash ?? null,
      record.sizeBytes ?? null,
      record.localModifiedAt ?? null,
      record.remoteModifiedAt ?? null,
      record.syncState ?? 'active',
      record.deletedAt ?? null,
      now,
    )
    return getFile(relativePath)
  }

  function getFile(relativePath) {
    return database.prepare('SELECT * FROM files WHERE relative_path = ?').get(normalizeRelativePath(relativePath)) ?? null
  }

  function listFiles() {
    return database.prepare('SELECT * FROM files ORDER BY relative_path').all()
  }

  function upsertAccount(account) {
    if (!account.id || !account.email) throw new TypeError('Account id and email are required')
    const now = account.updatedAt ?? new Date().toISOString()
    database.prepare(`
      INSERT INTO accounts (id, email, root_folder_id, quota_bytes, changes_page_token, connected_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        root_folder_id = excluded.root_folder_id,
        quota_bytes = excluded.quota_bytes,
        changes_page_token = COALESCE(excluded.changes_page_token, accounts.changes_page_token),
        updated_at = excluded.updated_at
    `).run(
      account.id,
      account.email,
      account.rootFolderId ?? null,
      account.quotaBytes ?? null,
      account.changesPageToken ?? null,
      account.connectedAt ?? now,
      now,
    )
    return getAccount(account.id)
  }

  function getAccount(id) {
    return database.prepare('SELECT * FROM accounts WHERE id = ?').get(id) ?? null
  }

  function getChangesPageToken(accountId) {
    const account = getAccount(accountId)
    return account?.changes_page_token ?? null
  }

  function setChangesPageToken(accountId, token) {
    if (!accountId) throw new TypeError('An account id is required')
    database.prepare('UPDATE accounts SET changes_page_token = ? WHERE id = ?').run(token ?? null, accountId)
    return getChangesPageToken(accountId)
  }

  function listAccounts() {
    return database.prepare('SELECT * FROM accounts ORDER BY email').all()
  }

  function removeAccount(id) {
    if (!id) throw new TypeError('An account id is required')
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare('DELETE FROM operations WHERE account_id = ?').run(id)
      database.prepare('DELETE FROM files WHERE account_id = ?').run(id)
      database.prepare('DELETE FROM accounts WHERE id = ?').run(id)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  function withTransaction(fn) {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  function addNotification({ id = randomUUID(), kind = 'info', title, message, createdAt = new Date().toISOString() }) {
    if (!title || !message) throw new TypeError('Notification title and message are required')
    database.prepare(`
      INSERT INTO notifications (id, kind, title, message, created_at, read_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).run(id, kind, String(title).slice(0, 160), String(message).slice(0, 2000), createdAt)
    return getNotification(id)
  }

  function getNotification(id) {
    return database.prepare('SELECT * FROM notifications WHERE id = ?').get(id) ?? null
  }

  function listNotifications({ limit = 100, unreadOnly = false } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
    return unreadOnly
      ? database.prepare('SELECT * FROM notifications WHERE read_at IS NULL ORDER BY created_at DESC LIMIT ?').all(safeLimit)
      : database.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?').all(safeLimit)
  }

  function countUnreadNotifications() {
    return Number(database.prepare('SELECT COUNT(*) AS count FROM notifications WHERE read_at IS NULL').get().count)
  }

  function markNotificationRead(id) {
    return Number(database.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL')
      .run(new Date().toISOString(), id).changes)
  }

  function markAllNotificationsRead() {
    return Number(database.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL')
      .run(new Date().toISOString()).changes)
  }

  function clearNotifications() {
    return Number(database.prepare('DELETE FROM notifications').run().changes)
  }

  function getMetadata(key) {
    const row = database.prepare('SELECT value FROM metadata WHERE key = ?').get(key)
    return row ? JSON.parse(row.value) : null
  }

  function setMetadata(key, value) {
    database.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(value))
  }

  function resetSyncState() {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec('DELETE FROM operations; DELETE FROM files; DELETE FROM metadata;')
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  function enqueueOperation(operation) {
    if (!operationKinds.has(operation.kind)) throw new TypeError('Unknown operation kind')
    const relativePath = normalizeRelativePath(operation.relativePath)
    const now = operation.createdAt ?? new Date().toISOString()
    const id = operation.id ?? randomUUID()
    insertOperationStatement.run(
      id,
      operation.kind,
      relativePath,
      operation.accountId ?? null,
      operation.driveFileId ?? null,
      operation.nextAttemptAt ?? now,
      JSON.stringify(operation.payload ?? {}),
      now,
      now,
    )
    return getOperation(id)
  }

  function getOperation(id) {
    const operation = database.prepare('SELECT * FROM operations WHERE id = ?').get(id)
    return operation ? { ...operation, payload: JSON.parse(operation.payload_json) } : null
  }

  function listOperations(state) {
    const rows = state
      ? database.prepare('SELECT * FROM operations WHERE state = ? ORDER BY created_at, rowid').all(state)
      : database.prepare('SELECT * FROM operations ORDER BY created_at, rowid').all()
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }))
  }

  function claimNextOperation(now = new Date().toISOString()) {
    database.exec('BEGIN IMMEDIATE')
    try {
      const operation = database.prepare(`
        SELECT id FROM operations
        WHERE state IN ('queued', 'retry') AND next_attempt_at <= ?
        ORDER BY created_at, rowid
        LIMIT 1
      `).get(now)
      if (!operation) {
        database.exec('COMMIT')
        return null
      }
      database.prepare(`
        UPDATE operations
        SET state = 'running', attempts = attempts + 1, updated_at = ?
        WHERE id = ?
      `).run(now, operation.id)
      database.exec('COMMIT')
      return getOperation(operation.id)
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  function updateOperation(id, state, { nextAttemptAt, error } = {}) {
    if (!['completed', 'retry', 'failed', 'queued'].includes(state)) throw new TypeError('Invalid operation state')
    const now = new Date().toISOString()
    database.prepare(`
      UPDATE operations
      SET state = ?, next_attempt_at = COALESCE(?, next_attempt_at), last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(state, nextAttemptAt ?? null, error ? String(error).slice(0, 2000) : null, now, id)
    return getOperation(id)
  }

  function recoverInterruptedOperations() {
    const now = new Date().toISOString()
    return Number(database.prepare(`
      UPDATE operations SET state = 'queued', updated_at = ? WHERE state = 'running'
    `).run(now).changes)
  }

  function requeueFailedOperations() {
    const now = new Date().toISOString()
    return Number(database.prepare(`
      UPDATE operations
      SET state = 'queued', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ?
      WHERE state = 'failed'
    `).run(now, now).changes)
  }

  function deleteOperation(id) {
    if (!id) throw new TypeError('An operation id is required')
    return Number(database.prepare('DELETE FROM operations WHERE id = ?').run(id).changes)
  }

  function clearCompletedOperations() {
    return Number(database.prepare("DELETE FROM operations WHERE state = 'completed'").run().changes)
  }

  function pruneOperations({ retentionDays = 7, maxCompleted = 200 } = {}) {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    let removed = Number(database.prepare("DELETE FROM operations WHERE state = 'completed' AND updated_at < ?").run(cutoff).changes)
    removed += Number(database.prepare(`
      DELETE FROM operations
      WHERE state = 'completed' AND id NOT IN (
        SELECT id FROM operations WHERE state = 'completed' ORDER BY updated_at DESC, rowid DESC LIMIT ?
      )
    `).run(maxCompleted).changes)
    return removed
  }

  return {
    close: () => {
      if (closed) return
      closed = true
      database.close()
    },
    claimNextOperation,
    enqueueOperation,
    getAccount,
    getFile,
    getOperation,
    getMetadata,
    getNotification,
    listAccounts,
    listFiles,
    listNotifications,
    listOperations,
    addNotification,
    countUnreadNotifications,
    markNotificationRead,
    markAllNotificationsRead,
    clearNotifications,
    clearCompletedOperations,
    deleteOperation,
    pruneOperations,
    recoverInterruptedOperations,
    removeAccount,
    requeueFailedOperations,
    resetSyncState,
    setChangesPageToken,
    getChangesPageToken,
    setMetadata,
    updateOperation,
    upsertAccount,
    upsertFile,
    withTransaction,
  }
}

module.exports = { createSyncStore, hasUnsafeSegment, normalizeRelativePath }
