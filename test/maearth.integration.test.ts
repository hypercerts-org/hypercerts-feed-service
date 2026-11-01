import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMaearthFeed, MaearthFeedService } from '../src/feed/maearth.js'
import {
  MAEARTH_FEED_ID,
  MAEARTH_FEED_PARAMS_TYPE,
} from '../src/feed/maearth-types.js'
import { FeedRegistry } from '../src/feed/registry.js'
import type { GetFeedSkeletonInput } from '../src/feed/types.js'
import { Metrics } from '../src/metrics.js'

const connectionString = process.env.TEST_DATABASE_URL
if (connectionString === undefined || connectionString === '')
  throw new Error(
    'TEST_DATABASE_URL is required; select a disposable PostgreSQL 16+ database before running MaEarth integration tests.',
  )
// The session-local temp table lives on this one connection, so it must never idle out.
const pool = new Pool({ connectionString, max: 1, idleTimeoutMillis: 0 })
const service = new MaearthFeedService(
  new FeedRegistry([
    createMaearthFeed({ database: pool, metrics: new Metrics() }),
  ]),
)
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

const seed = async (
  actor: string,
  collectionName: string,
  body: Record<string, unknown>,
  options: { key?: string; indexedAt?: string | null } = {},
) => {
  const key = options.key ?? randomUUID()
  const uri = `at://${actor}/${collectionName}/${key}`
  await pool.query(
    'INSERT INTO happyview_records (uri, did, collection, cid, record, indexed_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [
      uri,
      actor,
      collectionName,
      cid,
      JSON.stringify({
        $type: collectionName,
        createdAt: '2026-10-14T12:00:00Z',
        ...body,
      }),
      options.indexedAt === undefined
        ? '2026-10-14 12:00:00+00'
        : options.indexedAt,
    ],
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
const subjects = async (
  viewerDid: string,
  extra: Parameters<typeof request>[1] = {},
) =>
  (await service.getFeed(request(viewerDid, extra))).feed
    .map((item) => item.subject)
    .sort()

interface CollectedItem {
  readonly subject: string
  readonly kind: string
  readonly createdAt: string
}

/** Follows cursors to the end; the cap turns a non-terminating cursor into a failure. */
const collect = async (
  viewerDid: string,
  extra: Parameters<typeof request>[1],
  maxPages = 20,
): Promise<CollectedItem[]> => {
  const items: CollectedItem[] = []
  let cursor: string | undefined
  for (let pageCount = 0; pageCount < maxPages; pageCount++) {
    const page = await service.getFeed(
      request(viewerDid, {
        ...extra,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    )
    items.push(
      ...page.feed.map(({ subject, view }) => ({
        subject,
        kind: view.kind,
        createdAt: view.createdAt,
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
    const page = await service.getFeed(request(viewer, { kinds: ['post'] }))
    expect(page.feed.map((item) => item.subject).sort()).toEqual(
      [own, followed, about].sort(),
    )
    expect(
      (
        await service.getFeed(
          request(viewer, { kinds: ['post'], actorDid: stranger }),
        )
      ).feed.map((item) => item.subject),
    ).toEqual([about])
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
      request(viewer, { kinds: ['accountFollow', 'projectFollow'] }),
    )
    expect(
      page.feed
        .map(({ subject, view }) => ({ subject, kind: view.kind }))
        .sort((left, right) => left.subject.localeCompare(right.subject)),
    ).toEqual(
      [
        { subject: viewerFollow, kind: 'accountFollow' },
        { subject: viewerProject, kind: 'projectFollow' },
        { subject: byAuthor, kind: 'accountFollow' },
        { subject: aboutAuthor, kind: 'accountFollow' },
        { subject: projectByAuthor, kind: 'projectFollow' },
        { subject: aboutProject, kind: 'projectFollow' },
      ].sort((left, right) => left.subject.localeCompare(right.subject)),
    )
  })

  it('returns only followed-account attachment reposts, without requiring target records', async () => {
    const viewer = did(),
      author = did(),
      stranger = did()
    await follow(viewer, author)
    const target = post(stranger)
    const included = await repost(author, { uri: target, cid })
    await repost(stranger, { uri: target, cid })
    await repost(viewer, { uri: target, cid })
    await repost(author, { uri: project(stranger), cid })
    await repost(author, { uri: target })
    await repost(author, { uri: target, cid: '' })
    expect(
      (await service.getFeed(request(viewer, { kinds: ['repost'] }))).feed,
    ).toEqual([
      {
        subject: included,
        view: {
          $type: 'org.hypercerts.feed.defs#maearthFeedView',
          kind: 'repost',
          createdAt: '2026-10-14T12:00:00.000000Z',
          repostedPostUri: target,
        },
      },
    ])
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
    const seen = (await collect(viewer, { kinds: ['post'], limit: 1 })).map(
      (item) => item.subject,
    )
    expect(seen).toEqual([...[valid, tie].sort().reverse(), fallback])
    const first = await service.getFeed(
      request(viewer, { kinds: ['post'], limit: 1 }),
    )
    expect(first.feed[0]?.view.createdAt).toBe('2026-10-14T12:00:00.123456Z')
    if (first.cursor === undefined)
      throw new Error('Expected a next-page cursor for the fixture')
    const foreign: unknown = JSON.parse(
      Buffer.from(first.cursor, 'base64url').toString(),
    )
    if (
      typeof foreign !== 'object' ||
      foreign === null ||
      !('feedId' in foreign)
    ) {
      throw new Error('Expected an object cursor payload')
    }
    foreign.feedId = 'org.hypercerts.feed.defs#hypercertsFeed'
    await expect(
      service.getFeed(
        request(viewer, {
          cursor: Buffer.from(JSON.stringify(foreign)).toString('base64url'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'InvalidCursor' })
  })

  it('does not truncate a graph with more than 500 accounts', async () => {
    const viewer = did()
    const authors = Array.from({ length: 505 }, () => did())
    const expected: string[] = []
    for (const author of authors) {
      await follow(viewer, author)
      expected.push(await update(author))
    }

    const actual = (await collect(viewer, { kinds: ['post'], limit: 50 })).map(
      (item) => item.subject,
    )
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

    expect(await subjects(viewer, { kinds: ['projectFollow'] })).toEqual(
      [edges.get(real), strangerEdges.get(real)].sort(),
    )
    expect(await subjects(viewer, { kinds: ['post'] })).toEqual([
      posts.get(real),
    ])
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
    expect(await subjects(viewer, { kinds: ['projectFollow'] })).toEqual([
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
    await seedCollection(owner, 'project', {
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
    await update(author, { subjects: [{ uri: unlisted, cid }] })
    await update(author, { subjects: [{ uri: nested, cid }] })
    await update(author, { subjects: [{ uri: foreignActivity, cid }] })
    await update(author, { subjects: [{ uri: favoritesActivity, cid }] })
    await update(author, { subjects: [{ uri: 'not-a-uri', cid }] })

    expect(await subjects(viewer, { kinds: ['post'] })).toEqual(
      [byActivity, byCollection, mixed].sort(),
    )
  })

  it('uses the current collection record, not a stored copy of its items', async () => {
    const viewer = did(),
      owner = did()
    const first = activity(owner, 'first')
    const second = activity(owner, 'second')
    const collectionUri = await seedCollection(owner, 'project', {
      items: [first],
    })
    await entityFollow(viewer, project(owner))
    const aboutFirst = await update(owner, { subjects: [{ uri: first, cid }] })
    const aboutSecond = await update(owner, {
      subjects: [{ uri: second, cid }],
    })
    expect(await subjects(viewer, { kinds: ['post'] })).toEqual([aboutFirst])
    await pool.query(
      'UPDATE happyview_records SET record = $1 WHERE uri = $2',
      [
        JSON.stringify({
          $type: 'org.hypercerts.collection',
          type: 'project',
          title: 'Collection',
          createdAt: '2026-10-14T12:00:00Z',
          items: [{ itemIdentifier: { uri: second, cid } }],
        }),
        collectionUri,
      ],
    )
    expect(await subjects(viewer, { kinds: ['post'] })).toEqual([aboutSecond])
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
    expect(await subjects(viewer, { kinds: ['post'] })).toEqual(
      [...expected].sort(),
    )
    for (const limit of [1, 3]) {
      expect(
        (await collect(viewer, { kinds: ['post'], limit })).map(
          (item) => item.subject,
        ),
      ).toEqual(expected)
    }
    expect(
      await subjects(viewer, { kinds: ['post'], actorDid: author }),
    ).toEqual([byCollection, byActivity].sort())
  })
})

describe('MaEarth mediated and null-via follows', () => {
  it('ignores mediated entity follows for viewer scope and for projectFollow items', async () => {
    const viewer = did(),
      author = did(),
      owner = did(),
      stranger = did()
    const via = { uri: project(owner, 'via'), cid }
    await seedCollection(owner, 'project', { key: 'mediated' })
    await seedCollection(owner, 'project', { key: 'direct' })
    await follow(viewer, author)
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
    expect(await subjects(viewer, { kinds: ['projectFollow'] })).toEqual(
      [direct, authorDirect, strangerDirect].sort(),
    )
    expect(await subjects(viewer, { kinds: ['post'] })).toEqual([])
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
    expect(await subjects(viewer)).toEqual(
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
    expect(await subjects(viewer, { kinds: ['post'] })).toEqual([kept])
  })

  it('applies actorDid to follow and repost kinds within viewer scope', async () => {
    const viewer = did(),
      first = did(),
      second = did(),
      target = did()
    await follow(viewer, first)
    await follow(viewer, second)
    const firstFollow = await follow(first, target)
    const secondFollow = await follow(second, target)
    const firstRepost = await repost(first, { uri: post(target), cid })
    const secondRepost = await repost(second, { uri: post(target), cid })
    expect(
      await subjects(viewer, {
        kinds: ['accountFollow'],
        actorDid: first,
      }),
    ).toEqual([firstFollow])
    expect(
      await subjects(viewer, { kinds: ['repost'], actorDid: second }),
    ).toEqual([secondRepost])
    expect(
      await subjects(viewer, {
        kinds: ['accountFollow', 'repost'],
        actorDid: first,
      }),
    ).toEqual([firstFollow, firstRepost].sort())
    expect(await subjects(viewer, { kinds: ['repost'] })).toEqual(
      [firstRepost, secondRepost].sort(),
    )
    expect(secondFollow).toBeDefined()
    // A stranger outside the graph yields nothing, even by explicit actorDid.
    expect(
      await subjects(viewer, { actorDid: did(), kinds: ['repost'] }),
    ).toEqual([])
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
    expect(await subjects(viewer, { actorDid: stranger })).toEqual([about])
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
    expect(all.map((item) => item.subject)).toEqual(expected)
    expect(all.map((item) => item.kind)).toEqual([
      'post',
      'accountFollow',
      'projectFollow',
      'repost',
      'accountFollow',
      'projectFollow',
    ])
    expect(all.map((item) => item.createdAt)).toEqual([
      '2026-10-14T12:05:00.000000Z',
      '2026-10-14T12:04:00.000000Z',
      '2026-10-14T12:03:00.000000Z',
      '2026-10-14T12:02:00.000000Z',
      '2026-10-14T12:01:00.000000Z',
      '2026-10-14T12:00:30.000000Z',
    ])
    expect(
      (await collect(viewer, { kinds: ['post', 'repost'], limit: 1 })).map(
        (item) => item.subject,
      ),
    ).toEqual([authored, reposted])
    const firstPage = await service.getFeed(
      request(viewer, { kinds: ['accountFollow'], limit: 1 }),
    )
    expect(firstPage.feed.map((item) => item.subject)).toEqual([authorFollow])
    expect(
      (
        await service.getFeed(
          request(viewer, {
            kinds: ['accountFollow'],
            limit: 1,
            ...(firstPage.cursor === undefined
              ? {}
              : { cursor: firstPage.cursor }),
          }),
        )
      ).feed.map((item) => item.subject),
    ).toEqual([viewerFollow])
  })

  it('returns only the viewer own posts when the viewer follows nobody', async () => {
    const viewer = did(),
      stranger = did()
    const own = await update(viewer)
    await update(stranger)
    await follow(stranger, viewer)
    await repost(stranger, { uri: post(viewer), cid })
    expect(await subjects(viewer)).toEqual([own])
    expect(await subjects(viewer, { kinds: ['repost'] })).toEqual([])
    expect(await subjects(viewer, { kinds: ['projectFollow'] })).toEqual([])
  })
})

describe('MaEarth effective timestamp range', () => {
  it('keeps every sort value a valid datetime and every cursor round-trippable', async () => {
    const viewer = did(),
      author = did()
    await follow(viewer, author)
    const edgeMax = await update(author, {
      createdAt: '9999-12-31T23:59:59.999999Z',
    })
    const future = await update(author, { createdAt: '2099-06-01T00:00:00Z' })
    // Out-of-range createdAt values fall back to indexed_at.
    const lateOffset = await update(
      author,
      { createdAt: '9999-12-31T23:59:59-01:00' },
      { indexedAt: '2026-10-14 12:00:00+00' },
    )
    const rounded = await update(
      author,
      { createdAt: '9999-12-31T23:59:59.9999999Z' },
      { indexedAt: '2026-10-14 11:30:00+00' },
    )
    const earlyOffset = await update(
      author,
      { createdAt: '0001-01-01T00:00:00+05:00' },
      { indexedAt: '2026-10-14 11:00:00+00' },
    )
    // Both timestamps out of range: the row is excluded.
    await update(
      author,
      { createdAt: '9999-12-31T23:59:59-01:00' },
      { indexedAt: '9999-12-31 23:59:59-01' },
    )
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

    const items = await collect(viewer, { kinds: ['post'], limit: 1 })
    expect(items.map((item) => item.subject)).toEqual([
      edgeMax,
      future,
      lateOffset,
      rounded,
      earlyOffset,
      ...edgeMin,
    ])
    expect(items.map((item) => item.createdAt)).toEqual([
      '9999-12-31T23:59:59.999999Z',
      '2099-06-01T00:00:00.000000Z',
      '2026-10-14T12:00:00.000000Z',
      '2026-10-14T11:30:00.000000Z',
      '2026-10-14T11:00:00.000000Z',
      '0001-01-01T00:00:00.000000Z',
      '0001-01-01T00:00:00.000000Z',
    ])
    // Larger pages must agree with single-item pages.
    expect(
      (await collect(viewer, { kinds: ['post'], limit: 3 })).map(
        (item) => item.subject,
      ),
    ).toEqual(items.map((item) => item.subject))
  })
})
