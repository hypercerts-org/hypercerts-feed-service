import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMaearthFeed, MaearthFeedService } from '../src/feed/maearth.js'
import {
  MAEARTH_FEED_ID,
  MAEARTH_FEED_PARAMS_TYPE,
} from '../src/feed/maearth-types.js'
import { FeedRegistry } from '../src/feed/registry.js'
import { FeedService } from '../src/feed/service.js'
import type { GetFeedSkeletonInput } from '../src/feed/types.js'
import type { ItemView } from '../src/hydration/types.js'
import { Metrics } from '../src/metrics.js'

const connectionString = process.env.TEST_DATABASE_URL
if (connectionString === undefined || connectionString === '')
  throw new Error(
    'TEST_DATABASE_URL is required; select a disposable PostgreSQL 16+ database before running MaEarth integration tests.',
  )
// The session-local temp table lives on this one connection, so it must never idle out.
const pool = new Pool({ connectionString, max: 1, idleTimeoutMillis: 0 })
const registry = new FeedRegistry([
  createMaearthFeed({ database: pool, metrics: new Metrics() }),
])
const service = new MaearthFeedService(registry)
const did = () => `did:web:${randomUUID()}.test`
const project = (actor: string, key = 'project') =>
  `at://${actor}/org.hypercerts.collection/${key}`
const post = (actor: string, key = 'post') =>
  `at://${actor}/org.hypercerts.context.attachment/${key}`
const activity = (actor: string, key = 'activity') =>
  `at://${actor}/org.hypercerts.claim.activity/${key}`
const recordSubject = (uri: string) => ({
  $type: 'app.certified.defs#recordSubject',
  uri,
})
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
// What a repost record names for its post: deliberately not the repost's own CID.
const subjectCid = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'
const recordViewType = 'org.hypercerts.feed.defs#recordView'
const actorViewType = 'org.hypercerts.feed.defs#actorView'
/** The DID authority of a record URI, which is the item's actor. */
const authorOf = (uri: string) => uri.split('/')[2]

/** Every string starting with `at://` at any depth, as HappyView's `extract_at_uris` collects. */
const atUris = (value: unknown): string[] => {
  if (typeof value === 'string') return value.startsWith('at://') ? [value] : []
  if (Array.isArray(value)) return value.flatMap(atUris)
  if (typeof value === 'object' && value !== null)
    return Object.values(value).flatMap(atUris)
  return []
}

const seed = async (
  actor: string,
  collectionName: string,
  body: Record<string, unknown>,
  options: { key?: string; indexedAt?: string | null } = {},
) => {
  const key = options.key ?? randomUUID()
  const uri = `at://${actor}/${collectionName}/${key}`
  const record = {
    $type: collectionName,
    createdAt: '2026-10-14T12:00:00Z',
    ...body,
  }
  await pool.query(
    'INSERT INTO happyview_records (uri, did, collection, cid, record, indexed_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [
      uri,
      actor,
      collectionName,
      cid,
      JSON.stringify(record),
      options.indexedAt === undefined
        ? '2026-10-14 12:00:00+00'
        : options.indexedAt,
    ],
  )
  // HappyView keeps happyview_record_refs complete for every stored record.
  await pool.query(
    'INSERT INTO happyview_record_refs (source_uri, target_uri, collection) SELECT $1, target, $2 FROM unnest($3::text[]) AS target ON CONFLICT DO NOTHING',
    [uri, collectionName, atUris(record)],
  )
  return uri
}
const follow = (
  actor: string,
  subject: string,
  extra: Record<string, unknown> = {},
) => seed(actor, 'app.certified.graph.follow', { subject, ...extra })
const entityFollow = (
  actor: string,
  uri: string,
  extra: Record<string, unknown> = {},
) =>
  seed(actor, 'app.certified.graph.entityFollow', {
    subject: recordSubject(uri),
    ...extra,
  })
const update = (
  actor: string,
  body: Record<string, unknown> = {},
  options: { key?: string; indexedAt?: string | null } = {},
) =>
  seed(
    actor,
    'org.hypercerts.context.attachment',
    { contentType: 'update', ...body },
    options,
  )
const repost = (
  actor: string,
  subject: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => seed(actor, 'app.certified.feed.repost', { subject, ...extra })
const like = (
  actor: string,
  subject: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => seed(actor, 'app.certified.feed.like', { subject, ...extra })
const comment = (
  actor: string,
  subjectUris: string[],
  extra: Record<string, unknown> = {},
) =>
  seed(actor, 'org.hypercerts.context.attachment', {
    contentType: 'comment',
    subjects: subjectUris.map((uri) => ({ uri, cid })),
    ...extra,
  })
/** An `app.certified.defs#did` party, the only `from`/`to` variant a receipt rule matches. */
const didParty = (actor: string) => ({
  $type: 'app.certified.defs#did',
  did: actor,
})
/**
 * Stores a receipt that matches no rule by default: `to` and `for` name unrelated
 * accounts and `from` is absent. Each test overrides only the field it exercises.
 */
const receipt = (
  author: string,
  body: Record<string, unknown> = {},
  options: { key?: string; indexedAt?: string | null } = {},
) =>
  seed(
    author,
    'org.hypercerts.funding.receipt',
    {
      to: didParty(did()),
      for: { uri: project(did(), 'unrelated'), cid },
      amount: '10',
      ...body,
    },
    options,
  )
/** Stores a current org.hypercerts.collection record at `project(actor, key)`. */
const seedCollection = (
  actor: string,
  type: string | undefined,
  options: { key?: string; items?: string[] } = {},
) => {
  const key = options.key ?? 'project'
  return seed(
    actor,
    'org.hypercerts.collection',
    {
      title: 'Collection',
      ...(type === undefined ? {} : { type }),
      items: (options.items ?? []).map((uri) => ({
        itemIdentifier: { uri, cid },
      })),
    },
    { key },
  )
}
const request = (
  viewerDid: string,
  extra: Omit<GetFeedSkeletonInput, 'feedId' | 'params'> & {
    kinds?: string[]
    actorDid?: string
  } = {},
): GetFeedSkeletonInput => ({
  feedId: MAEARTH_FEED_ID,
  params: {
    $type: MAEARTH_FEED_PARAMS_TYPE,
    viewerDid,
    ...(extra.kinds === undefined ? {} : { kinds: extra.kinds }),
    ...(extra.actorDid === undefined ? {} : { actorDid: extra.actorDid }),
  },
  ...(extra.limit === undefined ? {} : { limit: extra.limit }),
  ...(extra.cursor === undefined ? {} : { cursor: extra.cursor }),
})
const uris = async (
  viewerDid: string,
  extra: Parameters<typeof request>[1] = {},
) =>
  (await service.getFeed(request(viewerDid, extra))).feed
    .map((item) => item.uri)
    .sort()

interface CollectedItem {
  readonly uri: string
  readonly kind: string
  readonly sortValue: string
}

const minutesFromNow = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString()

/**
 * Follows cursors to the end through the registry's page boundary, which carries
 * each row's sort value as the cursor encodes it. The cap turns a
 * non-terminating cursor into a failure.
 */
const collect = async (
  viewerDid: string,
  extra: Parameters<typeof request>[1],
  maxPages = 20,
): Promise<CollectedItem[]> => {
  const items: CollectedItem[] = []
  let cursor: string | undefined
  for (let pageCount = 0; pageCount < maxPages; pageCount++) {
    const page = await registry.loadPage(
      request(viewerDid, {
        ...extra,
        ...(cursor === undefined ? {} : { cursor }),
      }),
      'metadata',
    )
    items.push(
      ...page.rows.map(({ uri, kind, sortValue }) => ({
        uri,
        kind,
        sortValue,
      })),
    )
    cursor = page.cursor
    if (cursor === undefined) return items
  }
  throw new Error(
    `Pagination did not finish within ${String(maxPages)} pages; check cursor termination.`,
  )
}

beforeAll(async () => {
  // A session-local table prevents interaction with ingested or sibling-suite rows.
  await pool.query(`CREATE TEMP TABLE happyview_records (
    uri text PRIMARY KEY, did text NOT NULL, collection text NOT NULL,
    cid text NOT NULL, record text NOT NULL, indexed_at text
  )`)
  // Mirrors HappyView's record_refs migration; the count lookup relies on its index.
  await pool.query(`CREATE TEMP TABLE happyview_record_refs (
    source_uri text NOT NULL REFERENCES happyview_records(uri) ON DELETE CASCADE,
    target_uri text NOT NULL, collection text NOT NULL,
    PRIMARY KEY (source_uri, target_uri)
  )`)
  await pool.query(
    'CREATE INDEX idx_record_refs_target ON happyview_record_refs (target_uri, collection)',
  )
})
afterAll(async () => {
  await pool.end()
})

describe('MaEarth Following SQL', () => {
  it('selects posts by followed authors, own posts, and posts about followed projects only', async () => {
    const viewer = did(),
      author = did(),
      stranger = did()
    await follow(viewer, author)
    await seedCollection(stranger, 'project')
    await entityFollow(viewer, project(stranger))
    const own = await update(viewer)
    const followed = await update(author)
    const about = await update(stranger, {
      subjects: [{ uri: project(stranger), cid }],
    })
    await update(stranger, { subjects: 'not-an-array' })
    await update(author, { contentType: 'report' })
    const page = await service.getFeed(request(viewer, { kinds: ['update'] }))
    expect(page.feed.map((item) => item.uri).sort()).toEqual(
      [own, followed, about].sort(),
    )
  })

  it('uses both follower and target scope for follows, rejects mediated account follows and unknown entity variants', async () => {
    const viewer = did(),
      author = did(),
      stranger = did(),
      target = did()
    await seedCollection(target, 'project')
    await seedCollection(stranger, 'project')
    const viewerFollow = await follow(viewer, author)
    const viewerProject = await entityFollow(viewer, project(target))
    const byAuthor = await follow(author, stranger)
    const aboutAuthor = await follow(stranger, author)
    const projectByAuthor = await entityFollow(author, project(stranger))
    const aboutProject = await entityFollow(stranger, project(target))
    await follow(author, target, { via: { uri: project(target), cid } })
    await seed(author, 'app.certified.graph.entityFollow', {
      subject: { $type: 'app.future.defs#entity', uri: project(target) },
    })
    await entityFollow(stranger, project(stranger))
    const page = await service.getFeed(
      request(viewer, { kinds: ['account-follow', 'project-follow'] }),
    )
    // The record's own createdAt, as seeded; sortAt is the same instant in the cursor's form.
    const createdAt = '2026-10-14T12:00:00Z'
    const sortAt = '2026-10-14T12:00:00.000000Z'
    const account = (uri: string, followedDid: string) => ({
      uri,
      cid,
      author: { did: authorOf(uri) },
      kind: 'account-follow',
      sortAt,
      createdAt,
      subject: { $type: actorViewType, did: followedDid },
    })
    const entity = (uri: string, followedProjectUri: string) => ({
      uri,
      cid,
      author: { did: authorOf(uri) },
      kind: 'project-follow',
      sortAt,
      createdAt,
      // An entity follow's subject names no CID, and a follow has no counts.
      subject: { $type: recordViewType, uri: followedProjectUri },
    })
    const byUri = (left: { uri: string }, right: { uri: string }) =>
      left.uri.localeCompare(right.uri)
    // The follower is the item URI's authority; the subject names only the
    // followed target, so a stranger's follow of `author` names `author`.
    expect([...page.feed].sort(byUri)).toEqual(
      [
        account(viewerFollow, author),
        entity(viewerProject, project(target)),
        account(byAuthor, stranger),
        account(aboutAuthor, author),
        entity(projectByAuthor, project(stranger)),
        entity(aboutProject, project(target)),
      ].sort(byUri),
    )
  })

  it('returns only followed-account attachment reposts, without requiring target records', async () => {
    const viewer = did(),
      author = did(),
      stranger = did()
    await follow(viewer, author)
    const target = post(stranger)
    const included = await repost(author, { uri: target, cid: subjectCid })
    await repost(stranger, { uri: target, cid })
    await repost(viewer, { uri: target, cid })
    await repost(author, { uri: project(stranger), cid })
    await repost(author, { uri: target })
    await repost(author, { uri: target, cid: '' })
    expect(
      (await service.getFeed(request(viewer, { kinds: ['repost'] }))).feed,
    ).toEqual([
      {
        uri: included,
        cid,
        author: { did: author },
        kind: 'repost',
        sortAt: '2026-10-14T12:00:00.000000Z',
        createdAt: '2026-10-14T12:00:00Z',
        // The original post, with the CID the repost names for it and the post's
        // counts. The repost item itself has no counts.
        subject: {
          $type: recordViewType,
          uri: target,
          cid: subjectCid,
          likeCount: 0,
          // Distinct reposters: author (three records, CID ignored), stranger, viewer.
          repostCount: 3,
          replyCount: 0,
        },
      },
    ])
  })

  it('returns the CID a repost names for its post, and omits one that is not a CID or is overlong instead of failing the page', async () => {
    const viewer = did(),
      author = did(),
      stranger = did()
    await follow(viewer, author)
    const named = await repost(author, {
      uri: post(stranger, 'a'),
      cid: subjectCid,
    })
    const notACid = await repost(author, {
      uri: post(stranger, 'b'),
      cid: 'not-a-cid',
    })
    const overlong = await repost(author, {
      uri: post(stranger, 'c'),
      cid: 'b'.repeat(300),
    })
    const { feed } = await service.getFeed(
      request(viewer, { kinds: ['repost'], limit: 50 }),
    )
    const subjectOf = (uri: string) =>
      feed.find((item) => item.uri === uri)?.subject
    expect(subjectOf(named)).toMatchObject({ cid: subjectCid })
    for (const uri of [notACid, overlong]) {
      expect(subjectOf(uri)).toMatchObject({ $type: recordViewType })
      expect(subjectOf(uri)).not.toHaveProperty('cid')
    }
  })

  it('excludes reposts whose target URI would fail output validation instead of failing the page', async () => {
    const viewer = did(),
      author = did(),
      stranger = did()
    await follow(viewer, author)
    const valid = await repost(author, { uri: post(stranger), cid })
    // Boundary values that are still valid AT-URIs stay in the feed.
    const longestKey = await repost(author, {
      uri: post(stranger, 'k'.repeat(512)),
      cid,
    })
    const longestDid = `did:web:${'a'.repeat(2040)}`
    const longestAuthority = await repost(author, {
      uri: post(longestDid),
      cid,
    })
    await repost(author, { uri: post(stranger, '..'), cid })
    await repost(author, { uri: post(stranger, '.'), cid })
    await repost(author, { uri: post(stranger, 'k'.repeat(513)), cid })
    await repost(author, { uri: post(`did:web:${'a'.repeat(2041)}`), cid })
    const items = await service.getFeed(
      request(viewer, { kinds: ['repost'], limit: 50 }),
    )
    expect(items.feed.map((item) => item.uri).sort()).toEqual(
      [valid, longestKey, longestAuthority].sort(),
    )
  })

  it('paginates equal instants without gaps, retains microseconds and safely handles malformed timestamps and JSON', async () => {
    const viewer = did(),
      author = did()
    await follow(viewer, author)
    const valid = await update(author, {
      createdAt: '2026-10-14T14:00:00.123456+02:00',
    })
    const tie = await update(author, {
      createdAt: '2026-10-14T12:00:00.123456Z',
    })
    const fallback = await update(
      author,
      { createdAt: 'invalid' },
      { indexedAt: '2026-10-14 11:00:00+00' },
    )
    // Matches the RFC3339 shape but is not a real date, so it fails input validation.
    const impossible = await update(
      author,
      { createdAt: '2026-13-45T12:00:00Z' },
      { indexedAt: '2026-10-14 10:00:00+00' },
    )
    for (const indexedAt of ['infinity', '2026-10-14', 'invalid', null]) {
      await update(
        author,
        { createdAt: '2026-10-14T12:00:00-00:00' },
        { indexedAt },
      )
    }
    const malformed = await update(author)
    await pool.query(
      'UPDATE happyview_records SET record = $1 WHERE uri = $2',
      ['{invalid', malformed],
    )
    const items = await collect(viewer, { kinds: ['update'], limit: 1 })
    expect(items.map((item) => item.uri)).toEqual([
      ...[valid, tie].sort().reverse(),
      fallback,
      impossible,
    ])
    // Both tied rows share one instant, kept to the microsecond.
    expect(items[0]?.sortValue).toBe('2026-10-14T12:00:00.123456Z')
    expect(items[1]?.sortValue).toBe('2026-10-14T12:00:00.123456Z')
  })

  it('does not truncate a graph with more than 500 accounts', async () => {
    const viewer = did()
    const authors = Array.from({ length: 505 }, () => did())
    const expected: string[] = []
    for (const author of authors) {
      await follow(viewer, author)
      expected.push(await update(author))
    }

    const actual = (
      await collect(viewer, { kinds: ['update'], limit: 50 })
    ).map((item) => item.uri)
    expect(actual.sort()).toEqual(expected.sort())
  })
})

describe('MaEarth project resolution', () => {
  it('counts only followed collections whose current record type is project', async () => {
    const viewer = did(),
      owner = did(),
      follower = did()
    const real = project(owner, 'real')
    const favorites = project(owner, 'favorites')
    const untyped = project(owner, 'untyped')
    const garbled = project(owner, 'garbled')
    const missing = project(owner, 'missing')
    await seedCollection(owner, 'project', { key: 'real' })
    await seedCollection(owner, 'favorites', { key: 'favorites' })
    await seedCollection(owner, undefined, { key: 'untyped' })
    const garbledUri = await seedCollection(owner, 'project', {
      key: 'garbled',
    })
    await pool.query(
      'UPDATE happyview_records SET record = $1 WHERE uri = $2',
      ['{invalid', garbledUri],
    )
    const kept = [real, favorites, untyped, garbled, missing]
    const edges = new Map<string, string>()
    for (const uri of kept) edges.set(uri, await entityFollow(viewer, uri))
    const strangerEdges = new Map<string, string>()
    for (const uri of kept)
      strangerEdges.set(uri, await entityFollow(follower, uri))
    const posts = new Map<string, string>()
    for (const uri of kept)
      posts.set(uri, await update(owner, { subjects: [{ uri, cid }] }))

    expect(await uris(viewer, { kinds: ['project-follow'] })).toEqual(
      [edges.get(real), strangerEdges.get(real)].sort(),
    )
    expect(await uris(viewer, { kinds: ['update'] })).toEqual([posts.get(real)])
  })

  it('requires an authored entity follow by a followed account to resolve to a project too', async () => {
    const viewer = did(),
      author = did(),
      owner = did()
    await follow(viewer, author)
    await seedCollection(owner, 'project', { key: 'real' })
    await seedCollection(owner, 'portfolio', { key: 'portfolio' })
    const included = await entityFollow(author, project(owner, 'real'))
    await entityFollow(author, project(owner, 'portfolio'))
    await entityFollow(author, project(owner, 'never-stored'))
    expect(await uris(viewer, { kinds: ['project-follow'] })).toEqual([
      included,
    ])
  })

  it('matches posts through the collection URI or an activity listed in its current items only', async () => {
    const viewer = did(),
      author = did(),
      owner = did(),
      other = did()
    const listed = activity(owner, 'listed')
    const unlisted = activity(owner, 'unlisted')
    const nested = project(other, 'nested')
    const collectionUri = await seedCollection(owner, 'project', {
      items: [listed, nested, 'not-a-uri'],
    })
    await entityFollow(viewer, project(owner))
    // A project the viewer does not follow, and a followed non-project, never contribute activities.
    const foreignActivity = activity(other, 'foreign')
    await seedCollection(other, 'project', {
      key: 'unfollowed',
      items: [foreignActivity],
    })
    const favoritesActivity = activity(other, 'favorite')
    await seedCollection(other, 'favorites', {
      key: 'favorites',
      items: [favoritesActivity],
    })
    await entityFollow(viewer, project(other, 'favorites'))

    const byActivity = await update(author, {
      subjects: [{ uri: listed, cid }],
    })
    const byCollection = await update(author, {
      subjects: [{ uri: project(owner), cid: '' }],
    })
    const mixed = await update(author, {
      subjects: [
        { uri: unlisted, cid },
        { uri: listed, cid: 'different-cid' },
      ],
    })
    const byUnlisted = await update(author, {
      subjects: [{ uri: unlisted, cid }],
    })
    await update(author, { subjects: [{ uri: nested, cid }] })
    await update(author, { subjects: [{ uri: foreignActivity, cid }] })
    await update(author, { subjects: [{ uri: favoritesActivity, cid }] })
    await update(author, { subjects: [{ uri: 'not-a-uri', cid }] })

    expect(await uris(viewer, { kinds: ['update'] })).toEqual(
      [byActivity, byCollection, mixed].sort(),
    )

    // Matching follows the collection's current items, not what was listed earlier.
    await pool.query(
      'UPDATE happyview_records SET record = $1 WHERE uri = $2',
      [
        JSON.stringify({
          $type: 'org.hypercerts.collection',
          type: 'project',
          title: 'Collection',
          createdAt: '2026-10-14T12:00:00Z',
          items: [{ itemIdentifier: { uri: unlisted, cid } }],
        }),
        collectionUri,
      ],
    )
    expect(await uris(viewer, { kinds: ['update'] })).toEqual(
      [byCollection, mixed, byUnlisted].sort(),
    )
  })
})

describe('MaEarth author-driven and target-driven rows', () => {
  it('returns a member-authored post that also references a followed project exactly once', async () => {
    const viewer = did(),
      author = did(),
      owner = did(),
      stranger = did()
    const listed = activity(owner, 'listed')
    await seedCollection(owner, 'project', { items: [listed] })
    await entityFollow(viewer, project(owner))
    await follow(viewer, author)
    const own = await update(viewer, {
      subjects: [{ uri: project(owner), cid }],
      createdAt: '2026-10-14T12:03:00Z',
    })
    const byCollection = await update(author, {
      subjects: [{ uri: project(owner), cid }],
      createdAt: '2026-10-14T12:02:00Z',
    })
    const byActivity = await update(author, {
      subjects: [{ uri: listed, cid }],
      createdAt: '2026-10-14T12:01:00Z',
    })
    // Control: a non-member's post about the project is target-driven and also appears once.
    const strangerPost = await update(stranger, {
      subjects: [{ uri: project(owner), cid }],
      createdAt: '2026-10-14T12:00:00Z',
    })
    const expected = [own, byCollection, byActivity, strangerPost]
    expect(await uris(viewer, { kinds: ['update'] })).toEqual(
      [...expected].sort(),
    )
    for (const limit of [1, 3]) {
      expect(
        (await collect(viewer, { kinds: ['update'], limit })).map(
          (item) => item.uri,
        ),
      ).toEqual(expected)
    }
    expect(await uris(viewer, { kinds: ['update'], actorDid: author })).toEqual(
      [byCollection, byActivity].sort(),
    )
  })
})

describe('MaEarth mediated and null-via follows', () => {
  it('ignores mediated entity follows for viewer scope and for project-follow items', async () => {
    const viewer = did(),
      author = did(),
      owner = did(),
      stranger = did()
    const via = { uri: project(owner, 'via'), cid }
    await seedCollection(owner, 'project', { key: 'mediated' })
    await seedCollection(owner, 'project', { key: 'direct' })
    const viewerFollow = await follow(viewer, author)
    // A mediated account follow neither widens scope nor appears as an item.
    const mediatedAccount = did()
    await follow(viewer, mediatedAccount, { via })
    await update(mediatedAccount)
    await entityFollow(viewer, project(owner, 'mediated'), { via })
    const direct = await entityFollow(viewer, project(owner, 'direct'))
    // Followed author and stranger edges toward the mediated project.
    await entityFollow(author, project(owner, 'mediated'), { via })
    await entityFollow(stranger, project(owner, 'mediated'), { via })
    const authorDirect = await entityFollow(author, project(owner, 'direct'))
    const strangerDirect = await entityFollow(
      stranger,
      project(owner, 'direct'),
    )
    await update(stranger, {
      subjects: [{ uri: project(owner, 'mediated'), cid }],
    })
    expect(await uris(viewer, { kinds: ['project-follow'] })).toEqual(
      [direct, authorDirect, strangerDirect].sort(),
    )
    expect(await uris(viewer, { kinds: ['update'] })).toEqual([])
    expect(await uris(viewer, { kinds: ['account-follow'] })).toEqual([
      viewerFollow,
    ])
  })

  it('treats a JSON null via as direct for account and entity follows', async () => {
    const viewer = did(),
      author = did(),
      owner = did(),
      stranger = did()
    await seedCollection(owner, 'project')
    const viewerFollow = await follow(viewer, author, { via: null })
    const viewerEntity = await entityFollow(viewer, project(owner), {
      via: null,
    })
    const authorPost = await update(author)
    const aboutProject = await update(stranger, {
      subjects: [{ uri: project(owner), cid }],
    })
    const strangerFollow = await follow(stranger, author, { via: null })
    const strangerEntity = await entityFollow(stranger, project(owner), {
      via: null,
    })
    expect(await uris(viewer)).toEqual(
      [
        viewerFollow,
        viewerEntity,
        authorPost,
        aboutProject,
        strangerFollow,
        strangerEntity,
      ].sort(),
    )
  })
})

describe('MaEarth record shape and filters', () => {
  it('ignores records whose $type differs from their collection', async () => {
    const viewer = did(),
      author = did(),
      owner = did()
    await follow(viewer, author, { $type: 'app.certified.graph.entityFollow' })
    // The mismatched follow does not put `author` in scope.
    await update(author)
    const trusted = did()
    await follow(viewer, trusted)
    await update(trusted, { $type: 'org.hypercerts.context.other' })
    await seedCollection(owner, 'project')
    await entityFollow(viewer, project(owner), {
      $type: 'app.certified.graph.follow',
    })
    await update(owner, { subjects: [{ uri: project(owner), cid }] })
    const kept = await update(trusted)
    expect(await uris(viewer, { kinds: ['update'] })).toEqual([kept])
  })

  it('applies actorDid to follow and repost kinds within viewer scope', async () => {
    const viewer = did(),
      first = did(),
      second = did(),
      target = did()
    await follow(viewer, first)
    await follow(viewer, second)
    const firstFollow = await follow(first, target)
    await follow(second, target)
    const firstRepost = await repost(first, { uri: post(target), cid })
    const secondRepost = await repost(second, { uri: post(target), cid })
    expect(
      await uris(viewer, {
        kinds: ['account-follow'],
        actorDid: first,
      }),
    ).toEqual([firstFollow])
    expect(await uris(viewer, { kinds: ['repost'], actorDid: second })).toEqual(
      [secondRepost],
    )
    expect(
      await uris(viewer, {
        kinds: ['account-follow', 'repost'],
        actorDid: first,
      }),
    ).toEqual([firstFollow, firstRepost].sort())
    expect(await uris(viewer, { kinds: ['repost'] })).toEqual(
      [firstRepost, secondRepost].sort(),
    )
    // A stranger outside the graph yields nothing, even by explicit actorDid.
    expect(await uris(viewer, { actorDid: did(), kinds: ['repost'] })).toEqual(
      [],
    )
  })

  it('returns an actor-restricted page for an author outside the followed graph', async () => {
    const viewer = did(),
      followedProject = did(),
      stranger = did()
    await seedCollection(followedProject, 'project')
    await entityFollow(viewer, project(followedProject))
    const about = await update(stranger, {
      subjects: [{ uri: project(followedProject), cid }],
    })
    await update(did(), { subjects: [{ uri: project(followedProject), cid }] })
    expect(await uris(viewer, { actorDid: stranger })).toEqual([about])
  })

  it('pages a mixed-kind feed with distinct timestamps, with and without kinds and cursor', async () => {
    const viewer = did(),
      author = did(),
      stranger = did(),
      owner = did()
    await seedCollection(owner, 'project')
    const viewerFollow = await follow(viewer, author, {
      createdAt: '2026-10-14T12:01:00Z',
    })
    const viewerProject = await entityFollow(viewer, project(owner), {
      createdAt: '2026-10-14T12:00:30Z',
    })
    const reposted = await repost(
      author,
      { uri: post(stranger), cid },
      { createdAt: '2026-10-14T12:02:00Z' },
    )
    const projectFollower = await entityFollow(stranger, project(owner), {
      createdAt: '2026-10-14T12:03:00Z',
    })
    const authorFollow = await follow(author, stranger, {
      createdAt: '2026-10-14T12:04:00Z',
    })
    const authored = await update(author, { createdAt: '2026-10-14T12:05:00Z' })
    const expected = [
      authored,
      authorFollow,
      projectFollower,
      reposted,
      viewerFollow,
      viewerProject,
    ]
    const all = await collect(viewer, { limit: 2 })
    expect(all.map((item) => item.uri)).toEqual(expected)
    expect(all.map((item) => item.kind)).toEqual([
      'update',
      'account-follow',
      'project-follow',
      'repost',
      'account-follow',
      'project-follow',
    ])
    expect(all.map((item) => item.sortValue)).toEqual([
      '2026-10-14T12:05:00.000000Z',
      '2026-10-14T12:04:00.000000Z',
      '2026-10-14T12:03:00.000000Z',
      '2026-10-14T12:02:00.000000Z',
      '2026-10-14T12:01:00.000000Z',
      '2026-10-14T12:00:30.000000Z',
    ])
    expect(
      (await collect(viewer, { kinds: ['update', 'repost'], limit: 1 })).map(
        (item) => item.uri,
      ),
    ).toEqual([authored, reposted])
    expect(
      (await collect(viewer, { kinds: ['account-follow'], limit: 1 })).map(
        (item) => item.uri,
      ),
    ).toEqual([authorFollow, viewerFollow])
  })

  it('returns only the viewer own posts when the viewer follows nobody', async () => {
    const viewer = did(),
      stranger = did()
    const own = await update(viewer)
    await update(stranger)
    await follow(stranger, viewer)
    await repost(stranger, { uri: post(viewer), cid })
    expect(await uris(viewer)).toEqual([own])
    expect(await uris(viewer, { kinds: ['repost'] })).toEqual([])
    expect(await uris(viewer, { kinds: ['project-follow'] })).toEqual([])
  })
})

describe('MaEarth follow targets', () => {
  it('excludes a followed account follow whose subject is too long to be a DID instead of failing the page', async () => {
    const viewer = did(),
      author = did()
    const viewerFollow = await follow(viewer, author)
    const kept = await follow(author, did())
    await follow(author, `did:web:${'a'.repeat(2041)}`)
    expect(await uris(viewer, { kinds: ['account-follow'] })).toEqual(
      [viewerFollow, kept].sort(),
    )
  })
})

describe('MaEarth effective timestamp range', () => {
  it('keeps every sort value a valid datetime and every cursor round-trippable', async () => {
    const viewer = did(),
      author = did()
    await follow(viewer, author)
    // A createdAt before year 1 is not a usable time, so it falls back to indexed_at.
    const earlyOffset = await update(
      author,
      { createdAt: '0001-01-01T00:00:00+05:00' },
      { indexedAt: '2026-10-14 11:00:00+00' },
    )
    // With indexed_at before year 1 as well, the row is excluded.
    await update(
      author,
      { createdAt: '0001-01-01T00:00:00+05:00' },
      { indexedAt: '0001-01-01 00:00:00+05' },
    )
    const edgeMin = [
      await update(author, { createdAt: '0001-01-01T00:00:00Z' }),
      await update(author, { createdAt: '0001-01-01T00:00:00Z' }),
    ]
      .sort()
      .reverse()

    const items = await collect(viewer, { kinds: ['update'], limit: 1 })
    expect(items.map((item) => item.uri)).toEqual([earlyOffset, ...edgeMin])
    expect(items.map((item) => item.sortValue)).toEqual([
      '2026-10-14T11:00:00.000000Z',
      '0001-01-01T00:00:00.000000Z',
      '0001-01-01T00:00:00.000000Z',
    ])
    // Larger pages must agree with single-item pages.
    expect(
      (await collect(viewer, { kinds: ['update'], limit: 3 })).map(
        (item) => item.uri,
      ),
    ).toEqual(items.map((item) => item.uri))
  })
})

describe('MaEarth future-dated items', () => {
  it('shows an item within the five-minute skew and hides later ones', async () => {
    const viewer = did(),
      author = did()
    await follow(viewer, author)
    const withinSkew = await update(author, { createdAt: minutesFromNow(4) })
    await update(author, { createdAt: minutesFromNow(10) })
    await update(author, { createdAt: '2099-06-01T00:00:00Z' })
    const past = await update(author, { createdAt: minutesFromNow(-10) })
    expect(
      (await collect(viewer, { kinds: ['update'], limit: 1 })).map(
        (item) => item.uri,
      ),
    ).toEqual([withinSkew, past])
    expect(await uris(viewer, { kinds: ['update'] })).toEqual(
      [withinSkew, past].sort(),
    )
  })

  it('hides future-dated items instead of re-dating them with indexed_at', async () => {
    const viewer = did(),
      author = did()
    await follow(viewer, author)
    const past = { indexedAt: '2026-10-14 12:00:00+00' }
    const hidden = [
      // Past the skew: the 10-minute row must stay hidden under a 15-minute skew.
      [{ createdAt: minutesFromNow(10) }, past, 'now-plus-10m'],
      // Real timestamps that land beyond year 9999 after their offset or rounding.
      [{ createdAt: '9999-12-31T23:59:59-01:00' }, past, 'offset-year-10000'],
      [
        { createdAt: '9999-12-31T23:59:59.9999999Z' },
        past,
        'rounded-year-10000',
      ],
      // No usable createdAt, and a future indexed_at.
      [
        { createdAt: 'invalid' },
        { indexedAt: '2099-06-01 00:00:00+00' },
        'indexed-at-2099',
      ],
    ] as const
    for (const [body, options, key] of hidden)
      await update(author, body, { ...options, key })
    const control = await update(
      author,
      { createdAt: 'invalid' },
      { ...past, key: 'control' },
    )
    expect(await uris(viewer, { kinds: ['update'] })).toEqual([control])
  })

  it('applies to every kind, including target-driven rows from strangers', async () => {
    const viewer = did(),
      author = did(),
      stranger = did(),
      owner = did()
    await seedCollection(owner, 'project')
    const viewerFollow = await follow(viewer, author)
    const viewerProject = await entityFollow(viewer, project(owner))
    const future = { createdAt: '2099-06-01T00:00:00Z' }
    await follow(author, stranger, future)
    await follow(stranger, author, future)
    await entityFollow(author, project(owner), future)
    await entityFollow(stranger, project(owner), future)
    await repost(author, { uri: post(stranger), cid }, future)
    await update(author, future)
    await update(stranger, {
      subjects: [{ uri: project(owner), cid }],
      ...future,
    })
    const visible = await entityFollow(stranger, project(owner), {
      createdAt: minutesFromNow(-1),
    })
    expect(await uris(viewer)).toEqual(
      [viewerFollow, viewerProject, visible].sort(),
    )
  })
})

describe('MaEarth item createdAt and sortAt', () => {
  it("returns the record's own createdAt unchanged, omits an unusable one, and orders by sortAt, the value the cursor encodes", async () => {
    const viewer = did(),
      author = did()
    await follow(viewer, author)
    // Not UTC and not microsecond-normalized: the view must repeat it as written.
    const ownCreatedAt = '2026-10-14T14:00:00.123456+02:00'
    const offset = await update(author, { createdAt: ownCreatedAt })
    // An impossible date that the atproto datetime check alone would let through, and the
    // unknown-offset form: each sorts by indexed_at and has no createdAt to show.
    const impossible = await update(
      author,
      { createdAt: '2026-02-30T12:00:00Z' },
      { indexedAt: '2026-10-14 11:00:00+00' },
    )
    const unknownOffset = await update(
      author,
      { createdAt: '2026-10-14T10:30:00-00:00' },
      { indexedAt: '2026-10-14 10:00:00+00' },
    )

    const { feed } = await service.getFeed(
      request(viewer, { kinds: ['update'] }),
    )
    expect(feed.map((item) => item.uri)).toEqual([
      offset,
      impossible,
      unknownOffset,
    ])
    expect(feed[0]?.createdAt).toBe(ownCreatedAt)
    expect(feed[1]).not.toHaveProperty('createdAt')
    expect(feed[2]).not.toHaveProperty('createdAt')
    expect(feed.map((item) => item.sortAt)).toEqual([
      '2026-10-14T12:00:00.123456Z',
      '2026-10-14T11:00:00.000000Z',
      '2026-10-14T10:00:00.000000Z',
    ])

    // The cursor encodes the last returned item's sortAt, so a client can resume from it.
    const first = await service.getFeed(
      request(viewer, { kinds: ['update'], limit: 1 }),
    )
    if (first.cursor === undefined) throw new Error('Expected a cursor')
    const payload: unknown = JSON.parse(
      Buffer.from(first.cursor, 'base64url').toString('utf8'),
    )
    expect(payload).toMatchObject({
      value: { value: first.feed[0]?.sortAt, uri: offset },
    })
  })
})

describe('MaEarth item counts', () => {
  const countsOf = ({
    likeCount,
    repostCount,
    replyCount,
  }: {
    likeCount?: number
    repostCount?: number
    replyCount?: number
  }) => ({
    likeCount,
    repostCount,
    replyCount,
  })
  const expectNoCounts = (value: object | undefined) => {
    for (const key of ['likeCount', 'repostCount', 'replyCount'])
      expect(value).not.toHaveProperty(key)
  }

  it("counts distinct likers and reposters and direct replies on an update item, puts a repost's counts on its subject instead, and gives follows none", async () => {
    const viewer = did(),
      author = did(),
      reposter = did(),
      [likerA, likerB, likerC, likerD, likerE] = [
        did(),
        did(),
        did(),
        did(),
        did(),
      ],
      [replier, stranger] = [did(), did()]
    const viewerFollow = await follow(viewer, author)
    await follow(viewer, reposter)
    const counted = await update(author, { createdAt: '2026-10-14T12:03:00Z' })
    const untouched = await update(author, {
      createdAt: '2026-10-14T12:02:00Z',
    })
    const other = post(stranger)
    const target = { uri: counted, cid }

    // Likes: distinct DIDs, matched by subject URI whatever the CID or via.
    await like(likerA, target)
    await like(likerA, { uri: counted, cid: 'ignored' })
    await like(likerB, target)
    const viaRepost = await repost(stranger, target)
    await like(likerE, target, { via: { uri: viaRepost, cid } })
    // A wrong $type, or a subject elsewhere that merely names the post in via, is no like of it.
    await like(likerC, target, { $type: 'app.certified.feed.repost' })
    await like(likerD, { uri: other, cid }, { via: target })

    // Reposts: the feed's own repost item counts too.
    const repostItem = await repost(reposter, target)

    // Replies: every direct comment counts, not distinct authors.
    const firstReply = await comment(replier, [counted])
    await comment(replier, [counted])
    await comment(stranger, [counted, other])
    await comment(likerA, [firstReply])
    // Naming the post outside subjects, here in its content, does not make a reply to it.
    await comment(likerB, [other], { content: [{ uri: counted }] })
    await seed(stranger, 'org.hypercerts.context.attachment', {
      contentType: 'evidence',
      subjects: [target],
    })
    // A non-array subjects holding the post's URI is no reply and must not fail the page.
    await comment(likerB, [], { subjects: { uri: counted } })

    const feed = (await service.getFeed(request(viewer))).feed
    const itemOf = (uri: string): ItemView => {
      const entry = feed.find((item) => item.uri === uri)
      if (entry === undefined) throw new Error(`Missing feed item ${uri}`)
      return entry
    }
    const originalCounts = { likeCount: 3, repostCount: 2, replyCount: 3 }
    expect(countsOf(itemOf(counted))).toEqual(originalCounts)
    expect(countsOf(itemOf(untouched))).toEqual({
      likeCount: 0,
      repostCount: 0,
      replyCount: 0,
    })
    // Item counts always count the item's own uri, so a repost item has none; the
    // original post's numbers sit on its subject.
    const repostView = itemOf(repostItem)
    expectNoCounts(repostView)
    expect(repostView.subject).toMatchObject({
      $type: recordViewType,
      uri: counted,
      ...originalCounts,
    })
    const followView = itemOf(viewerFollow)
    expectNoCounts(followView)
    expectNoCounts(followView.subject)
  })

  it('leaves counts out of the skeleton and returns the same URIs', async () => {
    const viewer = did(),
      author = did()
    const viewerFollow = await follow(viewer, author)
    const liked = await update(author)
    await like(did(), { uri: liked, cid })
    const skeleton = await new FeedService(registry).getFeedSkeleton(
      request(viewer),
    )
    expect(skeleton.feed.map((item) => item.uri).sort()).toEqual(
      [liked, viewerFollow].sort(),
    )
    for (const item of skeleton.feed) expect(Object.keys(item)).toEqual(['uri'])
  })
})

describe('MaEarth funding receipts', () => {
  it('selects a receipt only when it is for a followed project, or to or from a followed account', async () => {
    const viewer = did(),
      platform = did(),
      followedAuthor = did(),
      org = did(),
      funder = did(),
      owner = did(),
      stranger = did()
    await seedCollection(owner, 'project')
    await seedCollection(owner, 'favorites', { key: 'favorites' })
    await entityFollow(viewer, project(owner))
    await entityFollow(viewer, project(owner, 'favorites'))
    await follow(viewer, org)
    await follow(viewer, funder)
    await follow(viewer, followedAuthor)
    const forProject = { for: { uri: project(owner), cid } }

    const included = [
      // Rule 1: for.uri is a followed project, whatever `to` and `from` say.
      await receipt(platform, {
        ...forProject,
        from: didParty(stranger),
      }),
      // Anonymous: no `from`, still reaches project followers.
      await receipt(platform, forProject),
      // Rule 2: `to` is a followed account; no `from` needed.
      await receipt(platform, { to: didParty(org) }),
      // Rule 3: `from` is a followed account.
      await receipt(platform, { from: didParty(funder) }),
      // Authorship never qualifies, but an author that is followed does not hide a match.
      await receipt(followedAuthor, forProject),
      // The viewer is no special case: their receipts count only through rules 1 and 2.
      await receipt(platform, { ...forProject, from: didParty(viewer) }),
      await receipt(platform, { to: didParty(org), from: didParty(viewer) }),
    ]
    await receipt(platform, { to: didParty(did()), from: didParty(did()) })
    await receipt(platform, { from: didParty(viewer) })
    await receipt(platform, { to: didParty(viewer) })
    // A followed account or the viewer publishing a receipt that matches no rule.
    await receipt(followedAuthor)
    await receipt(viewer)
    // A followed collection that is not a project is not a followed project.
    await receipt(platform, { for: { uri: project(owner, 'favorites'), cid } })

    expect(await uris(viewer, { kinds: ['funding-receipt'] })).toEqual(
      [...included].sort(),
    )

    // Nothing followed means nothing to match, including the viewer's own receipts.
    const lonely = did()
    await receipt(lonely, { from: didParty(lonely), to: didParty(lonely) })
    await receipt(platform, { from: didParty(lonely) })
    expect(await uris(lonely, { kinds: ['funding-receipt'] })).toEqual([])
  })

  it('selects receipts to or from a followed account for a viewer who follows no project', async () => {
    const viewer = did(),
      platform = did(),
      org = did()
    await follow(viewer, org)
    const toOrg = await receipt(platform, { to: didParty(org) })
    const fromOrg = await receipt(platform, { from: didParty(org) })
    await receipt(platform, { from: didParty(did()) })
    expect(await uris(viewer, { kinds: ['funding-receipt'] })).toEqual(
      [toOrg, fromOrg].sort(),
    )
  })

  it('ignores from and to variants that are not app.certified.defs#did', async () => {
    const viewer = did(),
      platform = did(),
      org = did(),
      owner = did()
    await seedCollection(owner, 'project')
    await entityFollow(viewer, project(owner))
    await follow(viewer, org)
    const strongRef = { uri: project(owner), cid }
    const matching = await receipt(platform, { to: didParty(org) })
    for (const party of [
      // Text and strongRef variants never name an account.
      { $type: 'org.hypercerts.funding.receipt#text', value: org },
      { $type: 'com.atproto.repo.strongRef', ...strongRef },
      strongRef,
      // The right DID under another $type or as a bare string is not a DID party.
      { $type: 'org.hypercerts.funding.receipt#text', did: org },
      { did: org },
      org,
      [didParty(org)],
      // The right $type but a DID that is not a string.
      { ...didParty(org), did: 42 },
    ]) {
      await receipt(platform, { to: party })
      await receipt(platform, { from: party })
    }
    expect(await uris(viewer, { kinds: ['funding-receipt'] })).toEqual([
      matching,
    ])
  })

  it('returns a flat item with the publisher as author, no subject or content, and honours the kinds and actorDid filters', async () => {
    const viewer = did(),
      platform = did(),
      other = did(),
      owner = did()
    await seedCollection(owner, 'project')
    const followEdge = await entityFollow(viewer, project(owner))
    const forProject = { for: { uri: project(owner), cid } }
    // The payment happened two hours before the record was written.
    const byPlatform = await receipt(platform, {
      ...forProject,
      occurredAt: '2026-10-14T10:00:00Z',
      type: 'donation',
      currency: 'USD',
      notes: 'must not be copied',
    })
    // createdAt is the record's own text, not UTC-normalized and not occurredAt.
    const ownCreatedAt = '2026-10-14T14:30:00.5+02:00'
    const byOther = await receipt(other, {
      ...forProject,
      createdAt: ownCreatedAt,
    })
    // An unusable createdAt is omitted, never replaced by occurredAt or the sort time.
    const noCreatedAt = await receipt(platform, {
      ...forProject,
      occurredAt: '2026-10-14T09:00:00Z',
      createdAt: '2026-10-14T09:30:00-00:00',
    })
    const aboutProject = await update(other, {
      subjects: [{ uri: project(owner), cid }],
    })

    const { feed } = await service.getFeed(
      request(viewer, { kinds: ['funding-receipt'] }),
    )
    // Exact items: no subject, content or replyCount keys, and no source fields.
    expect(feed).toEqual([
      {
        uri: byOther,
        cid,
        author: { did: other },
        kind: 'funding-receipt',
        sortAt: '2026-10-14T12:30:00.500000Z',
        createdAt: ownCreatedAt,
        likeCount: 0,
        repostCount: 0,
      },
      {
        uri: byPlatform,
        cid,
        author: { did: platform },
        kind: 'funding-receipt',
        // The sort time is occurredAt; createdAt is still the record's own.
        sortAt: '2026-10-14T10:00:00.000000Z',
        createdAt: '2026-10-14T12:00:00Z',
        likeCount: 0,
        repostCount: 0,
      },
      {
        uri: noCreatedAt,
        cid,
        author: { did: platform },
        kind: 'funding-receipt',
        sortAt: '2026-10-14T09:00:00.000000Z',
        likeCount: 0,
        repostCount: 0,
      },
    ])

    expect(await uris(viewer, { kinds: ['update'] })).toEqual([aboutProject])
    // Omitting kinds includes receipts alongside every other kind.
    expect(await uris(viewer)).toEqual(
      [byPlatform, byOther, noCreatedAt, aboutProject, followEdge].sort(),
    )
    // actorDid narrows by the receipt's author, even for an author the viewer does not follow.
    expect(
      await uris(viewer, { kinds: ['funding-receipt'], actorDid: platform }),
    ).toEqual([byPlatform, noCreatedAt].sort())
    expect(await uris(viewer, { actorDid: other })).toEqual(
      [byOther, aboutProject].sort(),
    )
    expect(await uris(viewer, { actorDid: did() })).toEqual([])
  })

  it('counts distinct likers and reposters of a receipt on the item, and has no reply count', async () => {
    const viewer = did(),
      platform = did(),
      owner = did(),
      [likerA, likerB, reposterA, reposterB, replier] = [
        did(),
        did(),
        did(),
        did(),
        did(),
      ]
    await seedCollection(owner, 'project')
    await entityFollow(viewer, project(owner))
    const forProject = { for: { uri: project(owner), cid } }
    const counted = await receipt(platform, forProject)
    const untouched = await receipt(platform, forProject)
    const target = { uri: counted, cid }

    // Distinct DIDs, matched by the receipt's own URI whatever the CID.
    await like(likerA, target)
    await like(likerA, { uri: counted, cid: 'ignored' })
    await like(likerB, target)
    await repost(reposterA, target)
    await repost(reposterB, { uri: counted })
    // A wrong $type, or a like of another record that names the receipt only in via, is not a like of it.
    await like(did(), target, { $type: 'app.certified.feed.repost' })
    await like(did(), { uri: untouched, cid }, { via: target })
    // A comment on the receipt is not counted: receipts carry no reply count.
    await comment(replier, [counted])

    const { feed } = await service.getFeed(
      request(viewer, { kinds: ['funding-receipt'] }),
    )
    const itemOf = (uri: string): ItemView => {
      const entry = feed.find((item) => item.uri === uri)
      if (entry === undefined) throw new Error(`Missing feed item ${uri}`)
      return entry
    }
    expect(itemOf(counted)).toMatchObject({ likeCount: 2, repostCount: 2 })
    expect(itemOf(untouched)).toMatchObject({ likeCount: 1, repostCount: 0 })
    expect(itemOf(counted)).not.toHaveProperty('replyCount')
    expect(itemOf(untouched)).not.toHaveProperty('replyCount')
  })

  it('leaves receipt counts out of the skeleton and returns the same URIs', async () => {
    const viewer = did(),
      platform = did(),
      org = did()
    await follow(viewer, org)
    const liked = await receipt(platform, { to: didParty(org) })
    await like(did(), { uri: liked, cid })
    const skeleton = await new FeedService(registry).getFeedSkeleton(
      request(viewer, { kinds: ['funding-receipt'] }),
    )
    expect(skeleton.feed).toEqual([{ uri: liked }])
  })

  it('sorts by occurredAt, then createdAt, then indexed_at, and pages without gaps', async () => {
    const viewer = did(),
      platform = did(),
      author = did(),
      owner = did()
    await seedCollection(owner, 'project')
    await entityFollow(viewer, project(owner))
    await follow(viewer, author)
    const forProject = { for: { uri: project(owner), cid } }
    const at = (time: string) => `2026-10-14T${time}Z`
    const hidden = { createdAt: at('12:19:00') }

    // An update's occurredAt is not a time: it keeps its own createdAt.
    const withOccurredAt = await update(author, {
      createdAt: at('12:25:00'),
      occurredAt: '2099-06-01T00:00:00Z',
    })
    // No occurredAt: createdAt.
    const byCreated = await receipt(platform, {
      ...forProject,
      createdAt: at('12:20:00'),
    })
    // occurredAt wins over a later createdAt; offsets are normalized to UTC.
    const offset = await receipt(platform, {
      ...forProject,
      occurredAt: '2026-10-14T14:15:00+02:00',
      createdAt: at('12:40:00'),
    })
    // Equal instants are ordered by URI descending, whichever field supplied them.
    const tieA = await receipt(
      platform,
      { ...forProject, occurredAt: at('12:10:00'), createdAt: at('12:30:00') },
      { key: 'tie-a' },
    )
    const tieB = await receipt(
      platform,
      { ...forProject, createdAt: at('12:10:00') },
      { key: 'tie-b' },
    )
    // An unusable occurredAt falls back to createdAt: malformed, impossible,
    // -00:00 (unknown offset), a non-string and before year 1.
    const unusable = [
      ['yesterday', '12:05:00'],
      ['2026-13-45T12:00:00Z', '12:04:00'],
      ['2026-10-14T12:50:00-00:00', '12:03:00'],
      [42, '12:02:00'],
      ['0001-01-01T00:00:00+05:00', '12:01:00'],
    ] as const
    const fallbacks: string[] = []
    for (const [occurredAt, createdAt] of unusable)
      fallbacks.push(
        await receipt(platform, {
          ...forProject,
          occurredAt,
          createdAt: at(createdAt),
        }),
      )
    // Neither field usable: indexed_at.
    const indexed = await receipt(
      platform,
      { ...forProject, occurredAt: 'bad', createdAt: 'bad' },
      { indexedAt: '2026-10-14 12:00:30+00' },
    )
    // A parseable future occurredAt is hidden, not re-dated to its createdAt.
    await receipt(platform, {
      ...forProject,
      occurredAt: '2099-06-01T00:00:00Z',
      ...hidden,
    })
    await receipt(platform, {
      ...forProject,
      occurredAt: minutesFromNow(10),
      ...hidden,
    })

    const expected = [
      withOccurredAt,
      byCreated,
      offset,
      tieB,
      tieA,
      ...fallbacks,
      indexed,
    ]
    const times = [
      '12:25:00',
      '12:20:00',
      '12:15:00',
      '12:10:00',
      '12:10:00',
      '12:05:00',
      '12:04:00',
      '12:03:00',
      '12:02:00',
      '12:01:00',
      '12:00:30',
    ].map((time) => `2026-10-14T${time}.000000Z`)
    for (const limit of [1, 3, 50]) {
      const items = await collect(viewer, {
        kinds: ['update', 'funding-receipt'],
        limit,
      })
      expect(items.map((item) => item.uri)).toEqual(expected)
      expect(items.map((item) => item.sortValue)).toEqual(times)
    }
  })
})
