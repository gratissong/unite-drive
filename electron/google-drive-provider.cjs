const path = require('node:path').posix
const { createHash } = require('node:crypto')
const { google } = require('googleapis')
const { hasUnsafeSegment, normalizeRelativePath } = require('./sync-store.cjs')

const folderMimeType = 'application/vnd.google-apps.folder'
const managedRootProperty = 'uniteDriveRoot'
const managedFileProperty = 'managed'
const appPropertyMaxBytes = 124

class GoogleDriveProvider {
  constructor({ auth, accountId, email, driveApi }) {
    if (!auth || !accountId || !email) throw new TypeError('Google auth, account ID, and email are required')
    this.auth = auth
    this.accountId = accountId
    this.email = email
    this.drive = driveApi ?? google.drive({ version: 'v3', auth })
    this.contentHashCache = new Map()
    this.changesCapable = true
  }

  async ensureManagedRoot() {
    const query = `mimeType = '${folderMimeType}' and trashed = false and appProperties has { key='${managedRootProperty}' and value='1' }`
    const response = await this.drive.files.list({
      q: query,
      pageSize: 100,
      fields: 'files(id,name,mimeType,appProperties)',
      spaces: 'drive',
    })
    let folder = response.data.files?.[0]
    if (!folder) {
      const created = await this.drive.files.create({
        requestBody: {
          name: 'Unite Drive',
          mimeType: folderMimeType,
          appProperties: { [managedRootProperty]: '1' },
        },
        fields: 'id,name,mimeType,appProperties',
      })
      folder = created.data
    }
    return { rootFolderId: folder.id }
  }

  async getQuota() {
    const response = await this.drive.about.get({ fields: 'storageQuota' })
    const quota = response.data.storageQuota ?? {}
    return {
      limitBytes: quota.limit == null ? null : Number(quota.limit),
      usageBytes: Number(quota.usage ?? 0),
    }
  }

  async getStartPageToken() {
    const response = await this.drive.changes.getStartPageToken({})
    const token = response.data?.startPageToken
    if (!token) throw new Error('Google did not return a changes start token')
    return token
  }

  async listChanges({ pageToken }) {
    if (!pageToken) throw new TypeError('A changes page token is required')
    const response = await this.drive.changes.list({
      pageToken,
      pageSize: 1000,
      includeRemoved: true,
      spaces: 'drive',
      supportsAllDrives: true,
      fields: 'nextPageToken,newStartPageToken,changes(fileId,time,removed,file(id,name,mimeType,size,md5Checksum,modifiedTime,appProperties,parents,trashed))',
    })
    const data = response.data ?? {}
    return {
      changes: (data.changes ?? []).map(normalizeChange),
      nextPageToken: data.nextPageToken ?? null,
      newStartPageToken: data.newStartPageToken ?? null,
    }
  }

  async listManagedFiles(rootFolderId) {
    const files = []

    const visitedFolders = new Set()
    const listFolder = async (folderId, parentRelativePath = '') => {
      if (visitedFolders.has(folderId)) return
      visitedFolders.add(folderId)
      let pageToken
      do {
        const response = await this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          pageSize: 1000,
          pageToken,
          spaces: 'drive',
          fields: 'nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,appProperties,parents,trashed)',
        })
        for (const file of response.data.files ?? []) {
          // A remote file name is a single, literal segment. Reject names that
          // cannot be a safe Windows file: `\` must not be reinterpreted as a
          // separator, and absolute/unsafe names (ADS `:`, reserved devices,
          // illegal characters) cannot be stored locally anyway.
          if (!file.appProperties?.relativePath && !isSafeRemoteFileName(file.name)) continue
          const relativePath = file.appProperties?.relativePath || path.join(parentRelativePath, file.name)
          if (file.mimeType === folderMimeType) {
            await listFolder(file.id, relativePath)
            continue
          }
          if (file.mimeType?.startsWith('application/vnd.google-apps.')) continue

          let safeRelativePath
          try {
            safeRelativePath = normalizeRelativePath(relativePath)
          } catch {
            continue
          }
          let hash
          try {
            hash = await this.#resolveContentHash(file, safeRelativePath)
          } catch (error) {
            if (error.code === 'DRIVE_FILE_ACCESS_REQUIRED') continue
            throw error
          }
          files.push({
            accountId: this.accountId,
            driveFileId: file.id,
            rootFolderId,
            relativePath: safeRelativePath,
            hash,
            size: Number(file.size ?? 0),
            modifiedAt: file.modifiedTime ?? null,
            md5Checksum: file.md5Checksum ?? null,
          })
        }
        pageToken = response.data.nextPageToken
      } while (pageToken)
    }

    await listFolder(rootFolderId)
    return files
  }

  async uploadFile({ rootFolderId, relativePath, readable, size, hash, driveFileId, idempotencyKey }) {
    validateAppProperty(relativePath, 'relative path')
    const existingId = driveFileId ?? (idempotencyKey ? await this.#findOperationFile(rootFolderId, idempotencyKey) : null)
    const requestBody = {
      name: path.basename(relativePath),
      appProperties: {
        [managedFileProperty]: '1',
        relativePath,
        sha256: hash,
        ...(idempotencyKey ? { operationId: idempotencyKey } : {}),
      },
    }
    const media = { mimeType: 'application/octet-stream', body: readable }
    let response
    try {
      response = existingId
        ? await this.drive.files.update({ fileId: existingId, requestBody, media, uploadType: 'resumable', fields: 'id,name,size,md5Checksum,modifiedTime,appProperties' })
        : await this.drive.files.create({ requestBody: { ...requestBody, parents: [rootFolderId] }, media, uploadType: 'resumable', fields: 'id,name,size,md5Checksum,modifiedTime,appProperties' })
    } catch (error) {
      readable.destroy()
      const status = Number(error.code ?? error.response?.status)
      const reasons = [
        ...(error.errors ?? []).map((item) => item.reason),
        ...(error.response?.data?.error?.errors ?? []).map((item) => item.reason),
      ]
      if (status === 403 && reasons.includes('storageQuotaExceeded')) error.code = 'INSUFFICIENT_STORAGE'
      throw error
    }
    const file = response.data
    const appProperties = { ...requestBody.appProperties, md5: file.md5Checksum ?? '' }
    if (file.md5Checksum) {
      await this.drive.files.update({ fileId: file.id, requestBody: { appProperties }, fields: 'id,appProperties' })
    }
    return {
      accountId: this.accountId,
      driveFileId: file.id,
      rootFolderId,
      relativePath,
      hash,
      size: Number(file.size ?? size),
      modifiedAt: file.modifiedTime ?? null,
      md5Checksum: file.md5Checksum ?? null,
    }
  }

  async downloadFile(driveFileId) {
    const metadata = await this.drive.files.get({ fileId: driveFileId, fields: 'id,md5Checksum,modifiedTime,appProperties,size,mimeType' })
    if (metadata.data.mimeType?.startsWith('application/vnd.google-apps.')) {
      const error = new Error('Google Docs files are not supported by binary sync yet')
      error.code = 'UNSUPPORTED_GOOGLE_DOC'
      throw error
    }
    let response
    try {
      response = await this.drive.files.get({ fileId: driveFileId, alt: 'media' }, { responseType: 'stream' })
    } catch (error) {
      if (Number(error.code ?? error.response?.status) === 403) {
        const permissionError = new Error('Google listed this file but did not grant Unite Drive permission to read its contents. This can happen for files added outside the app with the current drive.file access. Reconnect with an approved read scope or add the file through an authorized Google Drive picker.')
        permissionError.code = 'DRIVE_FILE_ACCESS_REQUIRED'
        throw permissionError
      }
      throw error
    }
    return {
      readable: response.data,
      hash: metadata.data.appProperties?.sha256 ?? null,
      modifiedAt: metadata.data.modifiedTime ?? null,
      size: Number(metadata.data.size ?? 0),
    }
  }

  async renameFile(driveFileId, relativePath) {
    validateAppProperty(relativePath, 'relative path')
    const current = await this.drive.files.get({ fileId: driveFileId, fields: 'id,appProperties' })
    const appProperties = { ...(current.data.appProperties ?? {}), [managedFileProperty]: '1', relativePath }
    const response = await this.drive.files.update({
      fileId: driveFileId,
      requestBody: { name: path.basename(relativePath), appProperties },
      fields: 'id,name,size,md5Checksum,modifiedTime,appProperties',
    })
    return {
      accountId: this.accountId,
      driveFileId: response.data.id,
      relativePath,
      hash: appProperties.sha256 ?? null,
      size: Number(response.data.size ?? 0),
      modifiedAt: response.data.modifiedTime ?? null,
    }
  }

  async trashFile(driveFileId) {
    await this.drive.files.update({ fileId: driveFileId, requestBody: { trashed: true }, fields: 'id,trashed' })
  }

  // Permanently removes a file (skips Drive trash). Used by a rebalance move once
  // the replacement copy is safely stored on another account; Drive trash would
  // keep counting against the quota and defeat the purpose of freeing space.
  async deleteFile(driveFileId) {
    try {
      await this.drive.files.delete({ fileId: driveFileId })
    } catch (error) {
      if (Number(error.code ?? error.response?.status) === 404) error.code = 'FILE_NOT_FOUND'
      throw error
    }
  }

  async restoreFile(driveFileId) {
    try {
      await this.drive.files.update({ fileId: driveFileId, requestBody: { trashed: false }, fields: 'id,trashed' })
    } catch (error) {
      if (Number(error.code ?? error.response?.status) === 404) {
        error.code = 'FILE_NOT_FOUND'
      }
      throw error
    }
  }

  async #findOperationFile(rootFolderId, operationId) {
    validateAppProperty(operationId, 'operation ID')
    const escapedId = escapeQueryValue(operationId)
    const response = await this.drive.files.list({
      q: `'${rootFolderId}' in parents and trashed = false and appProperties has { key='${managedFileProperty}' and value='1' } and appProperties has { key='operationId' and value='${escapedId}' }`,
      pageSize: 1,
      fields: 'files(id)',
      spaces: 'drive',
    })
    return response.data.files?.[0]?.id ?? null
  }

  async #resolveContentHash(file, relativePath) {
    const properties = file.appProperties ?? {}
    if (properties.sha256 && properties.md5 === file.md5Checksum) {
      if (properties[managedFileProperty] !== '1' || properties.relativePath !== relativePath) {
        await this.#saveManagedProperties(file.id, properties, relativePath, properties.sha256, file.md5Checksum)
      }
      return properties.sha256
    }
    const cacheKey = `${file.id}:${file.md5Checksum ?? ''}`
    const cachedHash = this.contentHashCache.get(cacheKey)
    if (cachedHash) return cachedHash
    if (!file.md5Checksum) {
      await this.#saveManagedProperties(file.id, properties, relativePath, properties.sha256 ?? '', '')
      return properties.sha256 ?? null
    }
    let response
    try {
      response = await this.drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' })
    } catch (error) {
      if ([403, 404].includes(Number(error.code ?? error.response?.status))) {
        const permissionError = new Error('Google listed this file but did not grant Unite Drive permission to read its contents. This can happen for files added outside the app with the current drive.file access. Reconnect with an approved read scope or add the file through an authorized Google Drive picker.')
        permissionError.code = 'DRIVE_FILE_ACCESS_REQUIRED'
        throw permissionError
      }
      throw error
    }
    const hash = createHash('sha256')
    for await (const chunk of response.data) hash.update(chunk)
    const sha256 = hash.digest('hex')
    this.contentHashCache.set(cacheKey, sha256)
    await this.#saveManagedProperties(file.id, properties, relativePath, sha256, file.md5Checksum)
    return sha256
  }

  async #saveManagedProperties(fileId, properties, relativePath, sha256, md5) {
    try {
      await this.drive.files.update({
        fileId,
        requestBody: {
          appProperties: {
            ...properties,
            [managedFileProperty]: '1',
            relativePath,
            ...(sha256 ? { sha256 } : {}),
            ...(md5 ? { md5 } : {}),
          },
        },
        fields: 'id,appProperties',
      })
    } catch (error) {
      if (Number(error.code ?? error.response?.status) !== 403) throw error
    }
  }
}

function normalizeChange(change) {
  const file = change?.file
  return {
    fileId: change?.fileId ?? null,
    time: change?.time ?? null,
    removed: Boolean(change?.removed),
    file: file
      ? {
          id: file.id,
          name: file.name ?? null,
          mimeType: file.mimeType ?? null,
          size: file.size == null ? null : Number(file.size),
          md5Checksum: file.md5Checksum ?? null,
          modifiedAt: file.modifiedTime ?? null,
          parents: [...(file.parents ?? [])],
          trashed: Boolean(file.trashed),
          appProperties: { ...(file.appProperties ?? {}) },
          relativePath: file.appProperties?.relativePath ?? null,
        }
      : null,
  }
}

function isSafeRemoteFileName(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (name.includes('/') || name.includes('\\')) return false
  return !hasUnsafeSegment(name)
}

function validateAppProperty(value, label) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > appPropertyMaxBytes) {
    const error = new Error(`${label} exceeds Google Drive appProperties limits`)
    error.code = 'APP_PROPERTY_TOO_LONG'
    throw error
  }
}

function escapeQueryValue(value) {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

module.exports = { GoogleDriveProvider, appPropertyMaxBytes, escapeQueryValue, validateAppProperty }
