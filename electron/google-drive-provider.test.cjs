const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const { GoogleDriveProvider } = require('./google-drive-provider.cjs')

function makeGoogleApi() {
  const files = new Map()
  let nextId = 1
  const publicFile = (file) => {
    const { content: _content, ...metadata } = file
    return { ...metadata, appProperties: { ...(metadata.appProperties ?? {}) }, parents: [...(metadata.parents ?? [])] }
  }
  const readMedia = async (stream) => {
    const chunks = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }
  const changeLog = []
  let changeSeq = 0
  const recordChange = (fileId, file, removed = false) => {
    changeLog.push({ seq: Number(changeSeq) + 1, fileId, time: new Date().toISOString(), removed, file: file ? publicFile(file) : null })
    changeSeq += 1
  }
  const api = {
    files: {
      list: async ({ q }) => {
        let result = [...files.values()]
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          result = result.filter((file) => file.mimeType === 'application/vnd.google-apps.folder' && file.appProperties?.uniteDriveRoot === '1' && !file.trashed)
        } else {
          const parent = q.match(/'([^']+)' in parents/)?.[1]
          if (parent) result = result.filter((file) => file.parents.includes(parent))
          result = result.filter((file) => !file.trashed)
          if (q.includes("key='managed'")) result = result.filter((file) => file.appProperties?.managed === '1')
          const operationId = q.match(/key='operationId' and value='([^']+)'/)?.[1]
          if (operationId) result = result.filter((file) => file.appProperties?.operationId === operationId)
        }
        return { data: { files: result.map(publicFile) } }
      },
      create: async ({ requestBody, media }) => {
        const content = media ? await readMedia(media.body) : Buffer.alloc(0)
        const id = `google-${nextId++}`
        const file = {
          id,
          name: requestBody.name,
          mimeType: requestBody.mimeType ?? 'application/octet-stream',
          parents: requestBody.parents ?? [],
          appProperties: { ...(requestBody.appProperties ?? {}) },
          size: String(content.length),
          md5Checksum: crypto.createHash('md5').update(content).digest('hex'),
          modifiedTime: new Date().toISOString(),
          trashed: false,
          content,
        }
        files.set(id, file)
        recordChange(id, file)
        return { data: publicFile(file) }
      },
      update: async ({ fileId, requestBody = {}, media }) => {
        const file = files.get(fileId)
        if (!file) throw Object.assign(new Error('not found'), { code: 404 })
        if (media) {
          file.content = await readMedia(media.body)
          file.size = String(file.content.length)
          file.md5Checksum = crypto.createHash('md5').update(file.content).digest('hex')
          file.modifiedTime = new Date().toISOString()
        }
        if (requestBody.name) file.name = requestBody.name
        if (requestBody.trashed !== undefined) file.trashed = requestBody.trashed
        if (requestBody.appProperties) file.appProperties = { ...file.appProperties, ...requestBody.appProperties }
        recordChange(fileId, file)
        return { data: publicFile(file) }
      },
      get: async ({ fileId, alt }) => {
        const file = files.get(fileId)
        if (!file) throw Object.assign(new Error('not found'), { code: 404 })
        return alt === 'media'
          ? { data: Readable.from([Buffer.from(file.content)]) }
          : { data: publicFile(file) }
      },
      delete: async ({ fileId }) => {
        const file = files.get(fileId)
        if (!file) throw Object.assign(new Error('not found'), { code: 404 })
        files.delete(fileId)
        recordChange(fileId, null, true)
        return { data: {} }
      },
    },
    about: { get: async () => ({ data: { storageQuota: { limit: '1000', usage: String([...files.values()].reduce((sum, file) => sum + Number(file.size), 0)) } } }) },
    changes: {
      getStartPageToken: async () => ({ data: { startPageToken: String(changeSeq + 1) } }),
      list: async ({ pageToken }) => {
        const from = Number(pageToken) || 1
        const items = changeLog.filter((entry) => entry.seq >= from)
        return { data: { changes: items, newStartPageToken: String(changeSeq + 1) } }
      },
    },
    seed(file) {
      const id = file.id ?? `google-${nextId++}`
      files.set(id, {
        mimeType: 'application/octet-stream',
        parents: [],
        appProperties: {},
        size: String(file.content.length),
        md5Checksum: crypto.createHash('md5').update(file.content).digest('hex'),
        trashed: false,
        modifiedTime: new Date().toISOString(),
        ...file,
        id,
      })
      recordChange(id, files.get(id))
      return id
    },
    filesById: files,
  }
  return api
}

function provider(driveApi) {
  return new GoogleDriveProvider({ auth: {}, accountId: 'google-user', email: 'user@example.com', driveApi })
}

async function readableText(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString()
}

test('creates one app-owned root and reports Google storage quota', async () => {
  const api = makeGoogleApi()
  const drive = provider(api)
  const first = await drive.ensureManagedRoot()
  const second = await drive.ensureManagedRoot()
  assert.equal(first.rootFolderId, second.rootFolderId)
  assert.deepEqual(await drive.getQuota(), { limitBytes: 1000, usageBytes: 0 })
})

test('creates uploads idempotently and downloads the same bytes', async () => {
  const api = makeGoogleApi()
  const drive = provider(api)
  const root = await drive.ensureManagedRoot()
  const upload = (content) => drive.uploadFile({
    rootFolderId: root.rootFolderId,
    relativePath: 'docs/a.txt',
    readable: Readable.from([content]),
    size: Buffer.byteLength(content),
    hash: crypto.createHash('sha256').update(content).digest('hex'),
    idempotencyKey: 'stable-operation-id',
  })
  const first = await upload('first content')
  const second = await upload('first content')
  const downloaded = await drive.downloadFile(first.driveFileId)
  assert.equal(first.driveFileId, second.driveFileId)
  assert.equal(await readableText(downloaded.readable), 'first content')
  assert.equal((await drive.listManagedFiles(root.rootFolderId)).length, 1)
})

test('lists app-managed and manually added binary files under the managed root', async () => {
  const api = makeGoogleApi()
  const drive = provider(api)
  const root = await drive.ensureManagedRoot()
  api.seed({ id: 'outside', name: 'outside.txt', parents: ['other-root'], content: Buffer.from('outside'), appProperties: { managed: '1', relativePath: 'outside.txt' } })
  api.seed({ id: 'native-doc', name: 'doc', mimeType: 'application/vnd.google-apps.document', parents: [root.rootFolderId], content: Buffer.from('native'), appProperties: { managed: '1', relativePath: 'doc' } })
  api.seed({ id: 'managed', name: 'inside.txt', parents: [root.rootFolderId], content: Buffer.from('inside'), appProperties: { managed: '1', relativePath: 'folder/inside.txt', sha256: 'saved-hash', md5: crypto.createHash('md5').update('inside').digest('hex') } })
  api.seed({ id: 'manual', name: 'added-in-Drive.txt', parents: [root.rootFolderId], content: Buffer.from('added manually') })
  api.seed({ id: 'backslash-name', name: 'a\\b.txt', parents: [root.rootFolderId], content: Buffer.from('backslash') })
  api.seed({ id: 'ads-name', name: 'hidden.txt:stream', parents: [root.rootFolderId], content: Buffer.from('ads') })
  api.seed({ id: 'reserved-name', name: 'CON.txt', parents: [root.rootFolderId], content: Buffer.from('reserved') })
  const files = await drive.listManagedFiles(root.rootFolderId)
  assert.deepEqual(files.map((file) => file.relativePath), ['folder/inside.txt', 'added-in-Drive.txt'])
  assert.equal(files[0].hash, 'saved-hash')
  assert.equal(files[1].driveFileId, 'manual')
  assert.equal(api.filesById.get('manual').appProperties.relativePath, 'added-in-Drive.txt')
  // Unsafe file names (backslash, ADS colon, reserved device name) are skipped
  // instead of being reinterpreted or written as invalid Windows paths.
  assert.ok(!files.some((file) => ['backslash-name', 'ads-name', 'reserved-name'].includes(file.driveFileId)))
})

test('rehashes remotely edited binary content and updates its cached hash', async () => {
  const api = makeGoogleApi()
  const drive = provider(api)
  const root = await drive.ensureManagedRoot()
  const content = Buffer.from('edited in Drive')
  const md5 = crypto.createHash('md5').update(content).digest('hex')
  api.seed({ id: 'edited', name: 'edited.txt', parents: [root.rootFolderId], content, appProperties: { managed: '1', relativePath: 'edited.txt', sha256: 'stale-hash', md5: 'old-md5' } })
  const files = await drive.listManagedFiles(root.rootFolderId)
  assert.equal(files[0].hash, crypto.createHash('sha256').update(content).digest('hex'))
  assert.equal(api.filesById.get('edited').appProperties.md5, md5)
})

test('skips an added file it cannot read instead of failing the whole listing', async () => {
  for (const status of [403, 404]) {
    const api = makeGoogleApi()
    const drive = provider(api)
    const root = await drive.ensureManagedRoot()
    api.seed({ id: 'manual-private', name: 'added.txt', parents: [root.rootFolderId], content: Buffer.from('manual') })
    api.seed({ id: 'readable-file', name: 'ok.txt', parents: [root.rootFolderId], content: Buffer.from('ok') })
    const originalGet = api.files.get
    api.files.get = async (params, options) => {
      if (params.alt === 'media' && params.fileId === 'manual-private') throw Object.assign(new Error('content unavailable'), { code: status })
      return originalGet(params, options)
    }

    const files = await drive.listManagedFiles(root.rootFolderId)
    assert.equal(files.length, 1)
    assert.equal(files[0].relativePath, 'ok.txt')
  }
})

test('moves managed remote files to and from recoverable trash', async () => {
  const api = makeGoogleApi()
  const drive = provider(api)
  const root = await drive.ensureManagedRoot()
  const remote = await drive.uploadFile({ rootFolderId: root.rootFolderId, relativePath: 'a.txt', readable: Readable.from(['a']), size: 1, hash: crypto.createHash('sha256').update('a').digest('hex') })
  await drive.trashFile(remote.driveFileId)
  assert.equal((await drive.listManagedFiles(root.rootFolderId)).length, 0)
  await drive.restoreFile(remote.driveFileId)
  assert.equal((await drive.listManagedFiles(root.rootFolderId)).length, 1)
})

test('maps Google storage quota errors to the fallback-routing code', async () => {
  const api = makeGoogleApi()
  const originalCreate = api.files.create
  api.files.create = async (request) => {
    if (request.media) throw Object.assign(new Error('quota reached'), { code: 403, errors: [{ reason: 'storageQuotaExceeded' }] })
    return originalCreate(request)
  }
  const drive = provider(api)
  const root = await drive.ensureManagedRoot()
  await assert.rejects(drive.uploadFile({ rootFolderId: root.rootFolderId, relativePath: 'full.txt', readable: Readable.from(['x']), size: 1 }), { code: 'INSUFFICIENT_STORAGE' })
})

test('normalizes a permanently deleted Drive item for safe recreation', async () => {
  const api = makeGoogleApi()
  api.files.update = async () => { throw Object.assign(new Error('not found'), { code: 404 }) }
  const drive = provider(api)
  await assert.rejects(drive.restoreFile('deleted-file'), { code: 'FILE_NOT_FOUND' })
})

test('getStartPageToken and listChanges expose normalized change records', async () => {
  const api = makeGoogleApi()
  const drive = provider(api)
  const root = await drive.ensureManagedRoot()

  const start = await drive.getStartPageToken()

  const one = await drive.uploadFile({ rootFolderId: root.rootFolderId, relativePath: 'a.txt', readable: Readable.from(['one']), size: 3, hash: 'hash-a' })
  const two = await drive.uploadFile({ rootFolderId: root.rootFolderId, relativePath: 'b.txt', readable: Readable.from(['two']), size: 3, hash: 'hash-b' })
  await drive.trashFile(one.driveFileId)
  api.seed({ name: 'c.txt', parents: [root.rootFolderId], content: Buffer.from('c') })
  await api.files.delete({ fileId: two.driveFileId })

  const page = await drive.listChanges({ pageToken: start })

  assert.ok(page.changes.length >= 5)
  assert.equal(page.changes.every((change) => Boolean(change.fileId)), true)
  assert.equal(typeof page.newStartPageToken, 'string')
  assert.equal(page.nextPageToken, null)

  const aLast = page.changes.filter((change) => change.fileId === one.driveFileId).pop()
  assert.equal(aLast.file.trashed, true)
  assert.equal(aLast.file.name, 'a.txt')

  const bLast = page.changes.filter((change) => change.fileId === two.driveFileId).pop()
  assert.equal(bLast.removed, true)
  assert.equal(bLast.file, null)

  const cChange = page.changes.find((change) => change.file?.name === 'c.txt')
  assert.equal(cChange.file.mimeType, 'application/octet-stream')
  assert.equal(cChange.file.relativePath, null)
  assert.equal(cChange.file.parents[0], root.rootFolderId)

  const empty = await drive.listChanges({ pageToken: page.newStartPageToken })
  assert.equal(empty.changes.length, 0)
})

test('rejects a changes listing without a page token', async () => {
  const drive = provider(makeGoogleApi())
  await assert.rejects(drive.listChanges({ pageToken: '' }), TypeError)
})
