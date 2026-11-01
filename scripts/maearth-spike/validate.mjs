import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Resolved transitively through @atproto/lex (hoisted by the lockfile); this
// disposable harness deliberately declares no extra dependency for it.
import { cidForLex } from '@atproto/lex-cbor'
import pg from 'pg'

const required = (name) => {
  const value = process.env[name]
  if (!value)
    throw new Error(
      `${name} is required; run this script inside the disposable Compose validation container.`,
    )
  return value
}
const pool = new pg.Pool({
  host: 'postgres',
  database: 'happyview',
  user: 'spike',
  password: required('SPIKE_DB_PASSWORD'),
  max: 1,
})
const fixtureToken = required('SPIKE_FIXTURE_TOKEN')
const apiRoot = required('SPIKE_API_DIR')
const apiManifestPath = join(apiRoot, 'api/manifest.json')
const apiInstallerPath = join(apiRoot, 'api/tooling/installer.js')
const apiSha = required('SPIKE_API_SHA')
const feedSha = required('SPIKE_FEED_SHA')
const handleResolverUrl = 'https://resolver.invalid'
const viewer = 'did:plc:cccccccccccccccccccccccc'
const followed = 'did:plc:dddddddddddddddddddddddd'
const stranger = 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee'
const other = 'did:plc:ffffffffffffffffffffffff'
const project = `at://${stranger}/org.hypercerts.collection/project`
const original = `at://${stranger}/org.hypercerts.context.attachment/original`
const refCid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const attachment = 'org.hypercerts.context.attachment'
const accountFollow = 'app.certified.graph.follow'
const entityFollow = 'app.certified.graph.entityFollow'
const repost = 'app.certified.feed.repost'
const projectCollection = 'org.hypercerts.collection'
const activity = `at://${stranger}/org.hypercerts.claim.activity/activity`
const createdAt = '2026-10-14T12:00:00.123456Z'
const recordSubject = {
  $type: 'app.certified.defs#recordSubject',
  uri: project,
}
const evidence = {
  viewer,
  sources: { feedHead: feedSha, apiHead: apiSha },
  checks: [],
  schema: [],
  fixtures: [],
  apiEndpoints: [],
}
const check = (name) => {
  evidence.checks.push(name)
  console.log(`PASS ${name}`)
}

async function until(label, action) {
  let last
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const value = await action()
      if (value) return value
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(
    `${label} did not complete within 20 seconds; inspect the task's Compose logs.`,
    { cause: last },
  )
}

async function json(url, options) {
  const response = await fetch(url, options)
  const body = await response.json()
  if (!response.ok)
    throw new Error(
      `${new URL(url).pathname} returned HTTP ${response.status}: ${JSON.stringify(body)}`,
    )
  return body
}

async function api(endpoint, params = {}) {
  const url = new URL(`/xrpc/${endpoint}`, 'http://happyview:3000')
  for (const [key, rawValue] of Object.entries(params)) {
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue])
      url.searchParams.append(key, String(value))
  }
  return json(url, { method: 'GET', headers: { accept: 'application/json' } })
}

async function loadApiBundle() {
  const { loadAssets } = await import(pathToFileURL(apiInstallerPath).href)
  const manifestBytes = await readFile(apiManifestPath)
  // Git-independent provenance: the mounted checkout may not carry .git.
  evidence.sources.apiManifestSha256 = createHash('sha256')
    .update(manifestBytes)
    .digest('hex')
  const bundleManifest = JSON.parse(manifestBytes.toString('utf8'))
  const { assets } = await loadAssets(apiManifestPath)
  const counts = Object.fromEntries(
    ['lexicon', 'script'].map((kind) => [
      kind,
      assets.filter((asset) => asset.kind === kind).length,
    ]),
  )
  assert.equal(counts.lexicon + counts.script, assets.length)
  return { assets, bundleManifest, counts }
}

function installerAssetIds(summary, assets) {
  assert(
    Array.isArray(summary.changed),
    'Installer result must include changed assets',
  )
  assert(
    Array.isArray(summary.unchanged),
    'Installer result must include unchanged assets',
  )
  const actual = [...summary.changed, ...summary.unchanged].sort()
  const expected = assets.map((asset) => asset.id).sort()
  assert.equal(
    actual.length,
    expected.length,
    'Installer result must account for every declared asset exactly once',
  )
  assert.deepEqual(
    actual,
    expected,
    'Installer result must match the complete manifest asset set',
  )
  return actual
}

async function runApiInstaller(label, adminToken) {
  const result = spawnSync(process.execPath, [apiInstallerPath], {
    cwd: join(apiRoot, 'api'),
    // Third-party installer code receives only what it needs, never stack credentials.
    env: {
      PATH: process.env.PATH,
      HAPPYVIEW_BASE_URL: 'http://localhost:3000',
      HAPPYVIEW_ADMIN_TOKEN: adminToken,
      HYPERCERTS_HANDLE_RESOLVER_URL: handleResolverUrl,
    },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 180_000,
  })
  await writeFile(
    `/tmp/maearth-${label}-installer.stdout.json`,
    result.stdout ?? '',
  )
  await writeFile(
    `/tmp/maearth-${label}-installer.stderr.log`,
    result.stderr ?? '',
  )
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ??
      result.stderr?.slice(-4000) ??
      'no installer output'
    throw new Error(`Maintained API installer ${label} run failed: ${detail}`)
  }
  const jsonStart = result.stdout.indexOf('{\n')
  assert.notEqual(
    jsonStart,
    -1,
    'Maintained installer must print its JSON result',
  )
  return JSON.parse(result.stdout.slice(jsonStart))
}

async function installAndVerifyApiBundle(adminToken) {
  const { assets, bundleManifest, counts } = await loadApiBundle()
  const firstInstall = await runApiInstaller('install', adminToken)
  installerAssetIds(firstInstall, assets)
  const readback = await runApiInstaller('readback', adminToken)
  installerAssetIds(readback, assets)
  assert.equal(
    readback.changed.length,
    0,
    'Second installer pass must find no missing or differing assets',
  )
  assert.equal(
    readback.unchanged.length,
    assets.length,
    'Second installer pass must read back every declared asset as unchanged',
  )

  const byId = new Map(assets.map((asset) => [asset.id, asset.kind]))
  const countsFor = (ids) =>
    Object.fromEntries(
      ['lexicon', 'script'].map((kind) => [
        kind,
        ids.filter((id) => byId.get(id) === kind).length,
      ]),
    )
  evidence.apiBundle = {
    manifest: 'api/manifest.json',
    modules: bundleManifest.modules,
    sourceSha: apiSha,
    declared: { total: assets.length, byKind: counts },
    firstInstall: {
      changed: firstInstall.changed.length,
      unchanged: firstInstall.unchanged.length,
      changedByKind: countsFor(firstInstall.changed),
      unchangedByKind: countsFor(firstInstall.unchanged),
    },
    readback: {
      changed: readback.changed.length,
      unchanged: readback.unchanged.length,
      unchangedByKind: countsFor(readback.unchanged),
      assetIds: readback.unchanged,
    },
    resolverSetting: firstInstall.resolverSetting?.status ?? null,
  }
  return assets.length
}

async function bootstrap() {
  await until(
    'HappyView health',
    async () => (await fetch('http://happyview:3000/health')).ok,
  )
  const existing = await pool.query(
    'SELECT count(*)::int AS count FROM happyview_records',
  )
  assert.equal(
    existing.rows[0].count,
    0,
    'Refusing to seed a nonempty database; use a fresh, unique disposable Compose project.',
  )
  evidence.schema = (
    await pool.query(`SELECT table_name, column_name, data_type
    FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name IN ('happyview_records', 'happyview_labels')
    ORDER BY table_name, ordinal_position`)
  ).rows
  assert.equal(
    evidence.schema.find((column) => column.column_name === 'record').data_type,
    'text',
  )
  const existingReader = await pool.query(
    "SELECT 1 FROM pg_roles WHERE rolname = 'maearth_reader'",
  )
  if (existingReader.rowCount === 0) {
    const passwordSql = await pool.query(
      "SELECT format('CREATE ROLE maearth_reader LOGIN PASSWORD %L', $1::text) AS sql",
      [required('SPIKE_READER_PASSWORD')],
    )
    await pool.query(passwordSql.rows[0].sql)
  }
  await pool.query(`GRANT CONNECT ON DATABASE happyview TO maearth_reader;
    GRANT USAGE ON SCHEMA public TO maearth_reader;
    GRANT SELECT ON happyview_records, happyview_labels TO maearth_reader;
    ALTER ROLE maearth_reader SET default_transaction_read_only = on`)
  const token = `hv_${randomBytes(16).toString('hex')}`
  const userId = randomUUID()
  const installerDid = `did:web:maearth-installer-${randomUUID()}.invalid`
  const createdAtNow = new Date().toISOString()
  const adminPermissions = [
    'lexicons:create',
    'lexicons:read',
    'script-variables:create',
    'script-variables:read',
    'scripts:read',
    'scripts:manage',
  ]
  await pool.query(
    'INSERT INTO happyview_users (id, created_at, did, is_super) VALUES ($1,$2,$3,1)',
    [userId, createdAtNow, installerDid],
  )
  await pool.query(
    `INSERT INTO happyview_user_permissions (user_id, permission, granted_at)
    SELECT $1, granted.permission, $2
    FROM unnest($3::text[]) AS granted(permission)`,
    [userId, createdAtNow, adminPermissions],
  )
  await pool.query(
    `INSERT INTO happyview_api_keys (id,user_id,name,key_hash,key_prefix,permissions,created_at)
    VALUES ($1,$2,'maearth-spike',$3,$4,$5,$6)`,
    [
      randomUUID(),
      userId,
      createHash('sha256').update(token).digest('hex'),
      token.slice(0, 11),
      JSON.stringify(adminPermissions),
      createdAtNow,
    ],
  )
  const installedAssetCount = await installAndVerifyApiBundle(token)
  await until('Jetstream collection subscription', async () => {
    const status = await json('http://mocks:8080/status')
    return [
      attachment,
      accountFollow,
      entityFollow,
      repost,
      projectCollection,
    ].every((collection) => status.collections.includes(collection))
  })
  evidence.installedAssets = installedAssetCount
  check(
    'Maintained API installer installed and read back every declared Lexicon and Lua script',
  )
  check('HappyView-migrated TEXT schema and registered record subscriptions')
}

let sequence = 0
async function event(did, collection, fields, operation = 'create', rkey) {
  const key =
    rkey ?? `3jzfcijpj2z${'234567abcdefghijklmnopqrstuvwxyz'[sequence]}`
  sequence++
  const record = { $type: collection, createdAt, ...fields }
  return {
    did,
    time_us: Date.now() * 1000 + sequence,
    kind: 'commit',
    commit: {
      rev: `3jzfcikpj2z${'234567abcdefghijklmnopqrstuvwxyz'[sequence]}`,
      operation,
      collection,
      rkey: key,
      ...(operation === 'delete'
        ? {}
        : { record, cid: String(await cidForLex(record)) }),
    },
  }
}
const uriOf = (event) =>
  `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`
async function publish(events) {
  await json('http://mocks:8080/events', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fixtureToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(events),
  })
  for (const event of events) {
    await until(`Persistence of ${event.commit.operation}`, async () => {
      const result = await pool.query(
        'SELECT cid FROM happyview_records WHERE uri = $1',
        [uriOf(event)],
      )
      return event.commit.operation === 'delete'
        ? result.rows.length === 0
        : result.rows[0]?.cid === event.commit.cid
    })
  }
}

async function page(endpoint, options = {}) {
  return json(`http://feed:3000/xrpc/org.hypercerts.feed.${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      feedId: 'org.hypercerts.feed.defs#maearthFeed',
      params: {
        $type: 'org.hypercerts.feed.defs#maearthFeedParams',
        viewerDid: viewer,
        ...options.params,
      },
      limit: options.limit ?? 50,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    }),
  })
}

async function verifyApiEndpoints(events) {
  const follows = await api('app.certified.graph.getFollows', {
    actor: viewer,
    subjects: [followed, other],
  })
  assert.deepEqual(
    follows.results.map((result) => result.subject),
    [followed, other],
  )
  assert.equal(follows.results[0].follow.record.subject, followed)
  assert.equal(follows.results[1].follow, null)
  evidence.apiEndpoints.push({
    endpoint: 'app.certified.graph.getFollows',
    results: 2,
    found: 1,
  })
  check(
    'Installed API Lua graph getFollows reads the ingested followed and absent account subjects',
  )

  const entityFollows = await api('app.certified.graph.getEntityFollows', {
    actor: viewer,
    entities: [project],
  })
  assert.equal(entityFollows.results[0].entity, project)
  assert.equal(entityFollows.results[0].follow.record.subject.uri, project)
  evidence.apiEndpoints.push({
    endpoint: 'app.certified.graph.getEntityFollows',
    results: 1,
    found: 1,
  })
  check(
    'Installed API Lua graph getEntityFollows reads the ingested project edge',
  )

  const attachmentUri = uriOf(events[2])
  const attachmentRecord = await api('org.hypercerts.context.getAttachment', {
    uri: attachmentUri,
  })
  assert.equal(attachmentRecord.attachment.uri, attachmentUri)
  assert.equal(attachmentRecord.attachment.record.title, 'Followed post')
  assert.equal(attachmentRecord.attachment.author.did, followed)
  evidence.apiEndpoints.push({
    endpoint: 'org.hypercerts.context.getAttachment',
    uri: attachmentUri,
  })
  check(
    'Installed API Lua context getAttachment reads the ingested attachment and publisher',
  )

  const filteredAttachments = await api(
    'org.hypercerts.context.listAttachments',
    {
      authors: [followed],
      contentTypes: ['update'],
      limit: 10,
    },
  )
  assert.deepEqual(
    filteredAttachments.attachments.map((item) => item.uri),
    [attachmentUri],
  )
  const expectedPagedUriCount = 5
  const maxApiPages = expectedPagedUriCount * 2
  const pagedUris = []
  let apiCursor
  let apiPages = 0
  do {
    assert(
      apiPages < maxApiPages,
      `listAttachments fixture cursor traversal did not terminate within ${maxApiPages} pages; inspect API cursor handling.`,
    )
    apiPages++
    const result = await api('org.hypercerts.context.listAttachments', {
      contentTypes: ['update'],
      limit: 2,
      ...(apiCursor === undefined ? {} : { cursor: apiCursor }),
    })
    pagedUris.push(...result.attachments.map((item) => item.uri))
    apiCursor = result.cursor
  } while (apiCursor !== undefined)
  assert.equal(pagedUris.length, expectedPagedUriCount)
  assert.equal(new Set(pagedUris).size, expectedPagedUriCount)
  assert.deepEqual(
    pagedUris.slice().sort(),
    [2, 3, 4, 5, 15].map((index) => uriOf(events[index])).sort(),
  )
  evidence.apiEndpoints.push({
    endpoint: 'org.hypercerts.context.listAttachments',
    filteredCount: filteredAttachments.attachments.length,
    pagedCount: pagedUris.length,
    pageSize: 2,
  })
  check(
    'Installed API Lua context listAttachments applies actor/kind filters and paginates ingested records',
  )

  const reposts = await api('app.certified.feed.getReposts', {
    subject: original,
    limit: 10,
  })
  assert.equal(reposts.repostCount, 2)
  assert.deepEqual(
    reposts.reposts.map((item) => item.did).sort(),
    [followed, stranger].sort(),
  )
  evidence.apiEndpoints.push({
    endpoint: 'app.certified.feed.getReposts',
    repostCount: reposts.repostCount,
    reposters: reposts.reposts.map((item) => item.did).sort(),
  })
  check(
    'Installed API Lua feed getReposts reads both ingested reposts of the same target',
  )
}

async function verify() {
  const specs = [
    [viewer, accountFollow, { subject: followed }],
    [viewer, entityFollow, { subject: recordSubject }],
    [followed, attachment, { title: 'Followed post', contentType: 'update' }],
    [viewer, attachment, { title: 'Own post', contentType: 'update' }],
    [
      stranger,
      attachment,
      {
        title: 'About followed project',
        contentType: 'update',
        subjects: [{ uri: project, cid: refCid }],
      },
    ],
    [stranger, attachment, { title: 'Out of scope', contentType: 'update' }],
    [followed, accountFollow, { subject: other }],
    [stranger, accountFollow, { subject: followed }],
    [
      followed,
      accountFollow,
      { subject: other, via: { uri: project, cid: refCid } },
    ],
    // A followed account's entity follow of a favorites-type collection: not a project.
    [
      followed,
      entityFollow,
      {
        subject: {
          ...recordSubject,
          uri: `at://${other}/org.hypercerts.collection/other`,
        },
      },
    ],
    [stranger, entityFollow, { subject: recordSubject }],
    [followed, repost, { subject: { uri: original, cid: refCid } }],
    [stranger, repost, { subject: { uri: original, cid: refCid } }],
    [followed, attachment, { title: 'Not an update', contentType: 'report' }],
    [
      stranger,
      projectCollection,
      {
        title: 'Followed project',
        type: 'project',
        items: [{ itemIdentifier: { uri: activity, cid: refCid } }],
      },
      'project',
    ],
    [
      stranger,
      attachment,
      {
        title: 'About the followed project activity only',
        contentType: 'update',
        subjects: [{ uri: activity, cid: refCid }],
      },
    ],
    [
      other,
      projectCollection,
      { title: 'Favorites', type: 'favorites' },
      'other',
    ],
    // A followed account's entity follow whose collection record was never stored.
    [
      followed,
      entityFollow,
      {
        subject: {
          ...recordSubject,
          uri: `at://${other}/org.hypercerts.collection/missing`,
        },
      },
    ],
  ]
  const events = []
  for (const [did, recordCollection, fields, rkey] of specs)
    events.push(await event(did, recordCollection, fields, 'create', rkey))
  await publish(events)
  evidence.fixtures = events.map((event) => ({
    uri: uriOf(event),
    cid: event.commit.cid,
  }))
  check(
    `${events.length} records persisted through real HappyView Jetstream ingestion with stored CIDs equal to the validator-computed CIDs`,
  )
  await verifyApiEndpoints(events)
  await until(
    'Feed read-only readiness',
    async () => (await fetch('http://feed:3000/ready')).ok,
  )
  const included = [0, 1, 2, 3, 4, 6, 7, 10, 11, 15]
    .map((index) => uriOf(events[index]))
    .sort()
    .reverse()
  const hydrated = await page('getFeed')
  const skeleton = await page('getFeedSkeleton')
  assert.deepEqual(
    hydrated.feed.map((item) => item.subject),
    included,
  )
  assert.deepEqual(
    skeleton.feed,
    included.map((subject) => ({ subject })),
  )
  assert.deepEqual(
    [...new Set(hydrated.feed.map((item) => item.view.kind))].sort(),
    ['accountFollow', 'post', 'projectFollow', 'repost'],
  )
  assert(hydrated.feed.every((item) => item.view.createdAt === createdAt))
  assert.equal(
    hydrated.feed.find((item) => item.view.kind === 'repost').view
      .repostedPostUri,
    original,
  )
  evidence.sample = hydrated
  check(
    'Both HTTP endpoints: scope, all four kinds, microsecond sort time and URI-only skeleton',
  )
  check(
    'Project resolution through real ingestion: a project-type collection counts, an activity-only post matches through its items[], and favorites-type and never-stored collections are excluded',
  )
  const seen = []
  const maxFeedPages = included.length * 2
  let pageCount = 0
  let cursor
  do {
    assert(
      pageCount < maxFeedPages,
      `Feed fixture cursor traversal did not terminate within ${maxFeedPages} pages; inspect feed cursor handling.`,
    )
    pageCount++
    const current = await page('getFeed', { limit: 2, cursor })
    const metadata = await page('getFeedSkeleton', { limit: 2, cursor })
    assert.deepEqual(
      current.feed.map((item) => item.subject),
      metadata.feed.map((item) => item.subject),
    )
    assert.equal(current.cursor, metadata.cursor)
    seen.push(...current.feed.map((item) => item.subject))
    cursor = current.cursor
  } while (cursor)
  assert.deepEqual(seen, included)
  check(
    'Equal-time HTTP pagination: matching cursors, no duplicates or omissions',
  )
  const actorOnly = await page('getFeed', { params: { actorDid: stranger } })
  assert.deepEqual(
    actorOnly.feed.map((item) => item.subject).sort(),
    [4, 7, 10, 15].map((index) => uriOf(events[index])).sort(),
  )
  const kindOnly = await page('getFeed', { params: { kinds: ['post'] } })
  assert.deepEqual(
    kindOnly.feed.map((item) => item.subject),
    [2, 3, 4, 15]
      .map((index) => uriOf(events[index]))
      .sort()
      .reverse(),
  )
  const actorAndKind = await page('getFeed', {
    params: { actorDid: stranger, kinds: ['post'] },
  })
  assert.deepEqual(
    actorAndKind.feed.map((item) => item.subject).sort(),
    [4, 15].map((index) => uriOf(events[index])).sort(),
  )
  check(
    'Feed actor and kind filters work independently and together within viewer scope',
  )
  const mutable = events[2]
  await publish([
    await event(
      followed,
      attachment,
      { title: 'Now a report', contentType: 'report' },
      'update',
      mutable.commit.rkey,
    ),
  ])
  assert(
    !(await page('getFeed')).feed.some(
      (item) => item.subject === uriOf(mutable),
    ),
  )
  const updatedAttachment = await api('org.hypercerts.context.getAttachment', {
    uri: uriOf(mutable),
  })
  assert.equal(updatedAttachment.attachment.record.title, 'Now a report')
  assert(
    (
      await api('org.hypercerts.context.listAttachments', {
        authors: [followed],
        contentTypes: ['report'],
        limit: 10,
      })
    ).attachments.some((item) => item.uri === uriOf(mutable)),
  )
  check(
    'Real ingestion update changes API lookup/filter results and removes the feed post',
  )
  const rep = events[11]
  await publish([await event(followed, repost, {}, 'delete', rep.commit.rkey)])
  assert(
    !(await page('getFeed')).feed.some((item) => item.subject === uriOf(rep)),
  )
  const repostsAfterDelete = await api('app.certified.feed.getReposts', {
    subject: original,
    limit: 10,
  })
  assert.equal(repostsAfterDelete.repostCount, 1)
  assert.deepEqual(
    repostsAfterDelete.reposts.map((item) => item.did),
    [stranger],
  )
  check(
    'Real ingestion deletion removes the repost from both API and feed results',
  )
  const edge = events[0]
  await publish([
    await event(viewer, accountFollow, {}, 'delete', edge.commit.rkey),
  ])
  const afterUnfollow = await page('getFeed')
  assert(!afterUnfollow.feed.some((item) => item.subject === uriOf(events[6])))
  assert(afterUnfollow.feed.some((item) => item.subject === uriOf(events[4])))
  const followAfterDelete = await api('app.certified.graph.getFollows', {
    actor: viewer,
    subjects: [followed],
  })
  assert.equal(followAfterDelete.results[0].follow, null)
  check(
    'Deleting the viewer follow updates API lookup and feed scope while retaining project posts',
  )
  await publish([
    await event(
      followed,
      attachment,
      { title: 'Followed post', contentType: 'update' },
      'update',
      mutable.commit.rkey,
    ),
    await event(
      followed,
      repost,
      { subject: { uri: original, cid: refCid } },
      'create',
      rep.commit.rkey,
    ),
    await event(
      viewer,
      accountFollow,
      { subject: followed },
      'create',
      edge.commit.rkey,
    ),
  ])
  assert.deepEqual(
    (await page('getFeed')).feed.map((item) => item.subject),
    included,
  )
  const restoredFollow = await api('app.certified.graph.getFollows', {
    actor: viewer,
    subjects: [followed],
  })
  assert.equal(restoredFollow.results[0].follow.record.subject, followed)
  const restoredReposts = await api('app.certified.feed.getReposts', {
    subject: original,
    limit: 10,
  })
  assert.equal(restoredReposts.repostCount, 2)
  check(
    'Restored the demonstration records and follow graph after mutation checks',
  )
}

try {
  await bootstrap()
  await verify()
  await writeFile(
    '/tmp/maearth-evidence.json',
    JSON.stringify(evidence, null, 2),
  )
  console.log(
    'Evidence: /tmp/maearth-evidence.json (inside validation container)',
  )
} finally {
  await pool.end()
}
