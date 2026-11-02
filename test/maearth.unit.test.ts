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

const repostRow = (overrides: Record<string, unknown> = {}) => ({
  uri: `at://${viewerDid}/app.certified.feed.repost/one`,
  cid: 'internal-cid',
  collection: 'app.certified.feed.repost',
  actor_did: viewerDid,
  kind: 'repost',
  sort_value: '2026-10-14T12:00:00.123456Z',
  reposted_post_uri: `at://${viewerDid}/org.hypercerts.context.attachment/post`,
  followed_project_uri: null,
  followed_did: null,
  ...overrides,
})

const followedDid = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const followedProject = `at://${followedDid}/org.hypercerts.collection/project`
const projectFollowRow = (overrides: Record<string, unknown> = {}) =>
  repostRow({
    uri: `at://${viewerDid}/app.certified.graph.entityFollow/one`,
    collection: 'app.certified.graph.entityFollow',
    kind: 'projectFollow',
    reposted_post_uri: null,
    followed_project_uri: followedProject,
    ...overrides,
  })
const accountFollowRow = (overrides: Record<string, unknown> = {}) =>
  repostRow({
    uri: `at://${viewerDid}/app.certified.graph.follow/one`,
    collection: 'app.certified.graph.follow',
    kind: 'accountFollow',
    reposted_post_uri: null,
    followed_did: followedDid,
    ...overrides,
  })

const decodeCursorPayload = (cursor: string): unknown =>
  JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))

describe('MaEarth feed boundary', () => {
  it('rejects unsupported kinds and out-of-range pagination before querying', async () => {
    const { query, service } = setup()
    await expect(
      service.getFeed({
        ...request,
        params: { ...request.params, kinds: ['donation'] },
      }),
    ).rejects.toMatchObject({ code: 'InvalidRequest', status: 422 })
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
  it('binds viewer, actor, kinds, cursor position and limit + 1 in SQL order with a default page size of 20', async () => {
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
    expect(page.feed.map((item) => item.subject)).toEqual([rows[0]?.uri])
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
        kinds: ['post', 'repost', 'post'],
      },
      limit: 5,
      cursor: page.cursor,
    })
    expect(query.mock.calls[2]?.[1]).toEqual([
      viewerDid,
      'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
      ['post', 'repost'],
      rows[0]?.sort_value,
      rows[0]?.uri,
      6,
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

  it('returns each follow kind with only its own target and keeps targets out of the skeleton', async () => {
    const { query, pages, service } = setup()
    const rows = [
      projectFollowRow(),
      accountFollowRow(),
      repostRow(),
      repostRow({
        uri: `at://${viewerDid}/org.hypercerts.context.attachment/post`,
        collection: 'org.hypercerts.context.attachment',
        kind: 'post',
        reposted_post_uri: null,
      }),
    ]
    query.mockResolvedValue({ rows })
    const viewType = 'org.hypercerts.feed.defs#maearthFeedView'
    const createdAt = '2026-10-14T12:00:00.123456Z'
    expect((await service.getFeed(request)).feed).toEqual([
      {
        subject: rows[0]?.uri,
        view: {
          $type: viewType,
          kind: 'projectFollow',
          createdAt,
          followedProjectUri: followedProject,
        },
      },
      {
        subject: rows[1]?.uri,
        view: {
          $type: viewType,
          kind: 'accountFollow',
          createdAt,
          followedDid,
        },
      },
      {
        subject: rows[2]?.uri,
        view: {
          $type: viewType,
          kind: 'repost',
          createdAt,
          repostedPostUri: rows[2]?.reposted_post_uri,
        },
      },
      {
        subject: rows[3]?.uri,
        view: { $type: viewType, kind: 'post', createdAt },
      },
    ])
    expect(await new FeedService(pages).getFeedSkeleton(request)).toEqual({
      feed: rows.map((row) => ({ subject: row.uri })),
    })
  })

  it.each([
    [
      'a projectFollow without a target',
      projectFollowRow({ followed_project_uri: null }),
    ],
    [
      'a projectFollow with a malformed URI',
      projectFollowRow({ followed_project_uri: 'not-a-uri' }),
    ],
    [
      'a projectFollow targeting another collection',
      projectFollowRow({
        followed_project_uri: `at://${followedDid}/org.hypercerts.claim.activity/activity`,
      }),
    ],
    [
      'a projectFollow also carrying a DID',
      projectFollowRow({ followed_did: followedDid }),
    ],
    [
      'an accountFollow without a target',
      accountFollowRow({ followed_did: null }),
    ],
    [
      'an accountFollow with a malformed DID',
      accountFollowRow({ followed_did: 'not-a-did' }),
    ],
    [
      'an accountFollow also carrying a project URI',
      accountFollowRow({ followed_project_uri: followedProject }),
    ],
    [
      'a repost carrying a project URI',
      repostRow({ followed_project_uri: followedProject }),
    ],
    ['a repost carrying a DID', repostRow({ followed_did: followedDid })],
    [
      'a post carrying a DID',
      repostRow({
        kind: 'post',
        reposted_post_uri: null,
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
      'a post carrying a repost target',
      repostRow({
        kind: 'post',
        reposted_post_uri: `at://${followedDid}/org.hypercerts.context.attachment/post`,
      }),
    ],
    [
      'a projectFollow carrying a repost target',
      projectFollowRow({
        reposted_post_uri: `at://${followedDid}/org.hypercerts.context.attachment/post`,
      }),
    ],
    [
      'a post with a missing target column',
      repostRow({
        kind: 'post',
        reposted_post_uri: null,
        followed_did: undefined,
      }),
    ],
  ])('fails closed on %s', async (_label, row) => {
    const { query, service } = setup()
    query.mockResolvedValue({ rows: [row] })
    await expect(service.getFeed(request)).rejects.toThrow(
      /target that does not match its kind/,
    )
  })
})
