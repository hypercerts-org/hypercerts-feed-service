import { describe, expect, it, vi } from 'vitest'

import type { ServiceAuthCredentials } from '../src/auth/service-auth.js'
import { applyAuthenticatedViewer } from '../src/auth/input.js'
import { createMaearthFeed, MaearthFeedService } from '../src/feed/maearth.js'
import {
  MAEARTH_FEED_ID,
  MAEARTH_FEED_PARAMS_TYPE,
} from '../src/feed/maearth-types.js'
import { FeedRegistry } from '../src/feed/registry.js'
import { FeedService } from '../src/feed/service.js'
import { Metrics } from '../src/metrics.js'

const viewerDid = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const request = {
  feedId: MAEARTH_FEED_ID,
  params: { $type: MAEARTH_FEED_PARAMS_TYPE, viewerDid },
}

const setup = () => {
  const query = vi.fn().mockResolvedValue({ rows: [] })
  const pages = new FeedRegistry([
    createMaearthFeed({ database: { query }, metrics: new Metrics() }),
  ])
  return { query, pages, service: new MaearthFeedService(pages) }
}

const recordCreatedAt = '2026-10-14T14:00:00.5+02:00'
const recordCid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'

const repostRow = (overrides: Record<string, unknown> = {}) => ({
  uri: `at://${viewerDid}/app.certified.feed.repost/one`,
  cid: recordCid,
  collection: 'app.certified.feed.repost',
  actor_did: viewerDid,
  kind: 'repost',
  sort_value: '2026-10-14T12:00:00.123456Z',
  // The record's own text, deliberately not the sort time's form: it must pass through unchanged.
  record_created_at: recordCreatedAt,
  reposted_post_uri: `at://${viewerDid}/org.hypercerts.context.attachment/post`,
  reposted_post_cid: recordCid,
  followed_project_uri: null,
  followed_did: null,
  like_count: 3,
  repost_count: 2,
  reply_count: 1,
  ...overrides,
})

const noCounts = { like_count: null, repost_count: null, reply_count: null }
const followedDid = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const followedProject = `at://${followedDid}/org.hypercerts.collection/project`
const projectFollowRow = (overrides: Record<string, unknown> = {}) =>
  repostRow({
    uri: `at://${viewerDid}/app.certified.graph.entityFollow/one`,
    collection: 'app.certified.graph.entityFollow',
    kind: 'project-follow',
    reposted_post_uri: null,
    reposted_post_cid: null,
    followed_project_uri: followedProject,
    ...noCounts,
    ...overrides,
  })
const accountFollowRow = (overrides: Record<string, unknown> = {}) =>
  repostRow({
    uri: `at://${viewerDid}/app.certified.graph.follow/one`,
    collection: 'app.certified.graph.follow',
    kind: 'account-follow',
    reposted_post_uri: null,
    reposted_post_cid: null,
    followed_did: followedDid,
    ...noCounts,
    ...overrides,
  })

const decodeCursorPayload = (cursor: string): unknown =>
  JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))

describe('MaEarth feed boundary', () => {
  it('rejects unsupported and former camelCase kinds and out-of-range pagination before querying', async () => {
    const { query, service } = setup()
    for (const kind of ['donation', 'post', 'projectFollow', 'accountFollow']) {
      await expect(
        service.getFeed({
          ...request,
          params: { ...request.params, kinds: [kind] },
        }),
      ).rejects.toMatchObject({
        code: 'InvalidRequest',
        status: 422,
        message: expect.stringContaining(
          'use update, repost, project-follow, account-follow',
        ) as unknown,
      })
    }
    for (const limit of [0, 51]) {
      await expect(
        service.getFeed({ ...request, limit }),
      ).rejects.toMatchObject({ code: 'InvalidRequest', status: 422 })
    }
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects structurally invalid params with 400 before semantic checks', async () => {
    const { query, service } = setup()
    await expect(
      service.getFeed({
        ...request,
        params: { ...request.params, actorDid: 'not-a-did' },
      }),
    ).rejects.toMatchObject({ code: 'InvalidRequest', status: 400 })
    expect(query).not.toHaveBeenCalled()
  })

  it('binds an authenticated viewer, rejects body identity overrides and requires a viewer anonymously', async () => {
    const { query, service } = setup()
    const credentials: ServiceAuthCredentials = {
      did: viewerDid,
      didDocument: { id: viewerDid },
      jwt: {
        header: { alg: 'ES256' },
        payload: { iss: viewerDid, aud: 'did:web:feed.example', exp: 1 },
        message: new Uint8Array(),
        signature: new Uint8Array(),
      },
    }
    expect(
      applyAuthenticatedViewer(
        { ...request, params: { $type: MAEARTH_FEED_PARAMS_TYPE } },
        credentials,
      ),
    ).toEqual(request)
    expect(() =>
      applyAuthenticatedViewer(
        {
          ...request,
          params: {
            ...request.params,
            viewerDid: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
          },
        },
        credentials,
      ),
    ).toThrow('does not match')
    await expect(
      service.getFeed({
        ...request,
        params: { $type: MAEARTH_FEED_PARAMS_TYPE },
      }),
    ).rejects.toMatchObject({ code: 'InvalidRequest', status: 422 })
    expect(() =>
      applyAuthenticatedViewer(
        { ...request, params: { $type: MAEARTH_FEED_PARAMS_TYPE } },
        undefined,
      ),
    ).toThrow('params.viewerDid is required for anonymous requests')
    expect(query).not.toHaveBeenCalled()
  })
})

describe('MaEarth feed query contract', () => {
  it('binds viewer, actor, kinds, cursor position, limit + 1 and the count switch in SQL order with a default page size of 20', async () => {
    const { query, service } = setup()
    await service.getFeed(request)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[1]).toEqual([
      viewerDid,
      null,
      [],
      null,
      null,
      21,
      true,
    ])
  })

  it('turns the count lookup off for the skeleton, which returns URIs only', async () => {
    const { query, pages } = setup()
    await new FeedService(pages).getFeedSkeleton(request)
    expect(query.mock.calls[0]?.[1]).toEqual([
      viewerDid,
      null,
      [],
      null,
      null,
      21,
      false,
    ])
  })

  it('emits a feed-scoped cursor for the last returned row only when another row exists, and binds its decoded position', async () => {
    const { query, service } = setup()
    const rows = [
      repostRow({ uri: `at://${viewerDid}/app.certified.feed.repost/b` }),
      repostRow({
        uri: `at://${viewerDid}/app.certified.feed.repost/a`,
        sort_value: '2026-10-14T11:00:00.000000Z',
      }),
    ]
    query.mockResolvedValueOnce({ rows })
    const page = await service.getFeed({ ...request, limit: 1 })
    expect(page.feed.map((item) => item.uri)).toEqual([rows[0]?.uri])
    if (page.cursor === undefined) throw new Error('Expected a cursor')
    expect(decodeCursorPayload(page.cursor)).toEqual({
      version: 1,
      feedId: MAEARTH_FEED_ID,
      value: { value: rows[0]?.sort_value, uri: rows[0]?.uri },
    })

    query.mockResolvedValueOnce({ rows: [rows[0]] })
    expect(
      (await service.getFeed({ ...request, limit: 1 })).cursor,
    ).toBeUndefined()

    await service.getFeed({
      ...request,
      params: {
        ...request.params,
        actorDid: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
        kinds: ['update', 'repost', 'update'],
      },
      limit: 5,
      cursor: page.cursor,
    })
    expect(query.mock.calls[2]?.[1]).toEqual([
      viewerDid,
      'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
      ['update', 'repost'],
      rows[0]?.sort_value,
      rows[0]?.uri,
      6,
      true,
    ])
  })

  it.each([
    ['an unsupported kind', { kind: 'donation' }],
    ['a missing sort value', { sort_value: undefined }],
    ['a missing collection', { collection: undefined }],
    ['a missing actor DID', { actor_did: undefined }],
  ])('fails closed on a malformed query row with %s', async (_label, patch) => {
    const { query, pages, service } = setup()
    query.mockResolvedValue({ rows: [repostRow(patch)] })
    await expect(service.getFeed(request)).rejects.toThrow(
      /MaEarth query metadata is incomplete or has an unsupported kind/,
    )
    await expect(
      new FeedService(pages).getFeedSkeleton(request),
    ).rejects.toThrow(/MaEarth query metadata is incomplete/)
  })

  it.each([
    ['a malformed record CID', { cid: 'not-a-cid' }],
    ['a malformed actor DID', { actor_did: 'not-a-did' }],
  ])('rejects a getFeed view with %s', async (_label, patch) => {
    const { query, service } = setup()
    query.mockResolvedValue({ rows: [repostRow(patch)] })
    await expect(service.getFeed(request)).rejects.toThrow()
  })

  it.each([
    ['missing', null],
    ['not a datetime', 'yesterday'],
    // A timestamp, but the response format forbids the unknown-offset marker.
    ['the unknown-offset form', '2026-10-14T12:00:00-00:00'],
  ])(
    'omits createdAt instead of failing the page when the record value is %s',
    async (_label, value) => {
      const { query, service } = setup()
      query.mockResolvedValue({
        rows: [repostRow({ record_created_at: value })],
      })
      const { feed } = await service.getFeed(request)
      expect(feed).toHaveLength(1)
      expect(feed[0]).not.toHaveProperty('createdAt')
    },
  )

  it("returns each kind's flat item with its own subject, puts a repost's counts on its subject, and keeps them out of the skeleton", async () => {
    const { query, pages, service } = setup()
    const otherCid =
      'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'
    const rows = [
      projectFollowRow(),
      accountFollowRow({
        uri: `at://${followedDid}/app.certified.graph.follow/one`,
        cid: otherCid,
        actor_did: followedDid,
        followed_did: viewerDid,
      }),
      repostRow(),
      repostRow({
        uri: `at://${viewerDid}/org.hypercerts.context.attachment/post`,
        collection: 'org.hypercerts.context.attachment',
        kind: 'update',
        reposted_post_uri: null,
        reposted_post_cid: null,
      }),
    ]
    query.mockResolvedValue({ rows })
    const sortAt = '2026-10-14T12:00:00.123456Z'
    // The record's own value passes through unchanged; sortAt is the value the cursor encodes.
    const createdAt = recordCreatedAt
    expect((await service.getFeed(request)).feed).toEqual([
      {
        uri: rows[0]?.uri,
        cid: recordCid,
        author: { did: viewerDid },
        kind: 'project-follow',
        sortAt,
        createdAt,
        // An entity follow's subject names no CID.
        subject: {
          $type: 'org.hypercerts.feed.defs#recordView',
          uri: followedProject,
        },
      },
      {
        uri: rows[1]?.uri,
        cid: otherCid,
        author: { did: followedDid },
        kind: 'account-follow',
        sortAt,
        createdAt,
        subject: {
          $type: 'org.hypercerts.feed.defs#actorView',
          did: viewerDid,
        },
      },
      {
        uri: rows[2]?.uri,
        cid: recordCid,
        author: { did: viewerDid },
        kind: 'repost',
        sortAt,
        createdAt,
        // The numbers describe the original post, so they sit on the subject, not the repost.
        subject: {
          $type: 'org.hypercerts.feed.defs#recordView',
          uri: rows[2]?.reposted_post_uri,
          cid: recordCid,
          likeCount: 3,
          repostCount: 2,
          replyCount: 1,
        },
      },
      {
        uri: rows[3]?.uri,
        cid: recordCid,
        author: { did: viewerDid },
        kind: 'update',
        sortAt,
        createdAt,
        likeCount: 3,
        repostCount: 2,
        replyCount: 1,
      },
    ])
    expect(await new FeedService(pages).getFeedSkeleton(request)).toEqual({
      feed: rows.map((row) => ({ uri: row.uri })),
    })
  })

  it.each([
    // The query returns null for a value over its length bound.
    ['null', null],
    ['not a CID', 'yesterday'],
  ])(
    "omits the repost subject's cid instead of failing the page when it is %s",
    async (_label, value) => {
      const { query, service } = setup()
      query.mockResolvedValue({
        rows: [repostRow({ reposted_post_cid: value })],
      })
      const { feed } = await service.getFeed(request)
      expect(feed).toHaveLength(1)
      expect(feed[0]?.subject).toMatchObject({
        $type: 'org.hypercerts.feed.defs#recordView',
        likeCount: 3,
      })
      expect(feed[0]?.subject).not.toHaveProperty('cid')
    },
  )

  it.each([
    [
      'a project-follow without a target',
      projectFollowRow({ followed_project_uri: null }),
    ],
    [
      'a project-follow with a malformed URI',
      projectFollowRow({ followed_project_uri: 'not-a-uri' }),
    ],
    [
      'a project-follow targeting another collection',
      projectFollowRow({
        followed_project_uri: `at://${followedDid}/org.hypercerts.claim.activity/activity`,
      }),
    ],
    [
      'a project-follow also carrying a DID',
      projectFollowRow({ followed_did: followedDid }),
    ],
    [
      'an account-follow without a target',
      accountFollowRow({ followed_did: null }),
    ],
    [
      'an account-follow with a malformed DID',
      accountFollowRow({ followed_did: 'not-a-did' }),
    ],
    [
      'an account-follow also carrying a project URI',
      accountFollowRow({ followed_project_uri: followedProject }),
    ],
    [
      'a repost carrying a project URI',
      repostRow({ followed_project_uri: followedProject }),
    ],
    ['a repost carrying a DID', repostRow({ followed_did: followedDid })],
    [
      'an update carrying a DID',
      repostRow({
        kind: 'update',
        reposted_post_uri: null,
        reposted_post_cid: null,
        followed_did: followedDid,
      }),
    ],
    ['a repost without a target URI', repostRow({ reposted_post_uri: null })],
    [
      'a repost with a malformed target URI',
      repostRow({ reposted_post_uri: 'not-a-uri' }),
    ],
    [
      'a repost whose target has an invalid record key',
      repostRow({
        reposted_post_uri: `at://${followedDid}/org.hypercerts.context.attachment/..`,
      }),
    ],
    [
      'a repost whose target has an overlong record key',
      repostRow({
        reposted_post_uri: `at://${followedDid}/org.hypercerts.context.attachment/${'a'.repeat(513)}`,
      }),
    ],
    [
      'a repost whose target is not an attachment',
      repostRow({ reposted_post_uri: followedProject }),
    ],
    [
      'an update carrying a repost CID',
      repostRow({
        kind: 'update',
        reposted_post_uri: null,
        followed_did: null,
      }),
    ],
    [
      'an update carrying a repost target',
      repostRow({
        kind: 'update',
        reposted_post_uri: `at://${followedDid}/org.hypercerts.context.attachment/post`,
      }),
    ],
    [
      'an account-follow carrying a repost CID',
      accountFollowRow({ reposted_post_cid: recordCid }),
    ],
    [
      'a project-follow carrying a repost target',
      projectFollowRow({
        reposted_post_uri: `at://${followedDid}/org.hypercerts.context.attachment/post`,
      }),
    ],
    [
      'an update with a missing target column',
      repostRow({
        kind: 'update',
        reposted_post_uri: null,
        reposted_post_cid: null,
        followed_did: undefined,
      }),
    ],
  ])('fails closed on %s', async (_label, row) => {
    const { query, service } = setup()
    query.mockResolvedValue({ rows: [row] })
    await expect(service.getFeed(request)).rejects.toThrow(
      /subject that does not match its kind/,
    )
  })
})

describe('MaEarth count projection', () => {
  const countsError = /counts that do not match its kind/

  it.each([
    [
      'an update without counts',
      repostRow({
        kind: 'update',
        reposted_post_uri: null,
        reposted_post_cid: null,
        ...noCounts,
      }),
    ],
    ['a repost without a reply count', repostRow({ reply_count: null })],
    [
      'a repost with a missing like count',
      repostRow({ like_count: undefined }),
    ],
    ['a negative count', repostRow({ repost_count: -1 })],
    ['a fractional count', repostRow({ like_count: 1.5 })],
    [
      'a count beyond the safe integer range',
      repostRow({ reply_count: 2 ** 53 }),
    ],
    ['a count returned as text', repostRow({ like_count: '3' })],
    ['a project-follow with a count', projectFollowRow({ like_count: 0 })],
    ['an account-follow with a count', accountFollowRow({ reply_count: 1 })],
  ])('fails closed on %s', async (_label, row) => {
    const { query, service } = setup()
    query.mockResolvedValue({ rows: [row] })
    await expect(service.getFeed(request)).rejects.toThrow(countsError)
  })

  it('does not read counts for the skeleton, where the query returns none', async () => {
    const { query, pages } = setup()
    const row = repostRow(noCounts)
    query.mockResolvedValue({ rows: [row] })
    await expect(
      new FeedService(pages).getFeedSkeleton(request),
    ).resolves.toEqual({ feed: [{ uri: row.uri }] })
  })
})
