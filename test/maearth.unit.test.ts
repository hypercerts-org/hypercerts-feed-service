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
  ...overrides,
})

const decodeCursorPayload = (cursor: string): unknown =>
  JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))

describe('MaEarth feed boundary', () => {
  it('returns merge metadata while keeping the skeleton URI-only', async () => {
    const { query, pages, service } = setup()
    const uri = `at://${viewerDid}/app.certified.feed.repost/one`
    const target = `at://${viewerDid}/org.hypercerts.context.attachment/post`
    query.mockResolvedValue({
      rows: [
        {
          uri,
          cid: 'internal-cid',
          collection: 'app.certified.feed.repost',
          actor_did: viewerDid,
          kind: 'repost',
          sort_value: '2026-10-14T12:00:00.123456Z',
          reposted_post_uri: target,
        },
      ],
    })
    expect(await service.getFeed(request)).toEqual({
      feed: [
        {
          subject: uri,
          view: {
            $type: 'org.hypercerts.feed.defs#maearthFeedView',
            kind: 'repost',
            createdAt: '2026-10-14T12:00:00.123456Z',
            repostedPostUri: target,
          },
        },
      ],
    })
    expect(await new FeedService(pages).getFeedSkeleton(request)).toEqual({
      feed: [{ subject: uri }],
    })
  })

  it('rejects unsupported kinds and out-of-range pagination before querying', async () => {
    const { query, service } = setup()
    await expect(
      service.getFeed({
        ...request,
        params: { ...request.params, kinds: ['donation'] },
      }),
    ).rejects.toMatchObject({ code: 'InvalidRequest', status: 422 })
    for (const limit of [0, 51, 100]) {
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

  it('binds an authenticated viewer and rejects body identity overrides', () => {
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

  it('deduplicates kinds and binds the actor and decoded cursor position', async () => {
    const { query, service } = setup()
    const first = await setupCursor()
    await service.getFeed({
      ...request,
      params: {
        ...request.params,
        actorDid: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
        kinds: ['post', 'repost', 'post'],
      },
      limit: 5,
      cursor: first.cursor,
    })
    expect(query.mock.calls[0]?.[1]).toEqual([
      viewerDid,
      'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
      ['post', 'repost'],
      first.position.value,
      first.position.uri,
      6,
    ])
  })

  it('emits a feed-scoped cursor for the last returned row only when another row exists', async () => {
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
  })

  it('requires an explicit valid viewer DID, and the anonymous path rejects a missing one', async () => {
    const { query, service } = setup()
    await expect(
      service.getFeed({
        ...request,
        params: { $type: MAEARTH_FEED_PARAMS_TYPE },
      }),
    ).rejects.toMatchObject({ code: 'InvalidRequest', status: 422 })
    await expect(
      service.getFeed({
        ...request,
        params: { $type: MAEARTH_FEED_PARAMS_TYPE, viewerDid: 'not-a-did' },
      }),
    ).rejects.toMatchObject({ code: 'InvalidRequest', status: 400 })
    expect(() =>
      applyAuthenticatedViewer(
        { ...request, params: { $type: MAEARTH_FEED_PARAMS_TYPE } },
        undefined,
      ),
    ).toThrow('params.viewerDid is required for anonymous requests')
    expect(query).not.toHaveBeenCalled()
  })

  it.each([
    ['an unsupported kind', { kind: 'donation' }],
    ['a missing kind', { kind: undefined }],
    ['a repost without a target URI', { reposted_post_uri: null }],
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

  it('omits repostedPostUri for non-repost kinds and keeps it out of the skeleton', async () => {
    const { query, service } = setup()
    const uri = `at://${viewerDid}/org.hypercerts.context.attachment/post`
    query.mockResolvedValue({
      rows: [
        repostRow({
          uri,
          collection: 'org.hypercerts.context.attachment',
          kind: 'post',
          reposted_post_uri: null,
        }),
      ],
    })
    expect((await service.getFeed(request)).feed[0]?.view).toEqual({
      $type: 'org.hypercerts.feed.defs#maearthFeedView',
      kind: 'post',
      createdAt: '2026-10-14T12:00:00.123456Z',
    })
  })
})

/** A cursor issued by the feed itself, so the test never hand-builds cursor bytes. */
async function setupCursor(): Promise<{
  cursor: string
  position: { value: string; uri: string }
}> {
  const { query, service } = setup()
  const rows = [
    repostRow({ uri: `at://${viewerDid}/app.certified.feed.repost/b` }),
    repostRow({
      uri: `at://${viewerDid}/app.certified.feed.repost/a`,
      sort_value: '2026-10-14T11:00:00.000000Z',
    }),
  ]
  query.mockResolvedValue({ rows })
  const page = await service.getFeed({ ...request, limit: 1 })
  if (page.cursor === undefined) throw new Error('Expected a cursor')
  return {
    cursor: page.cursor,
    position: { value: String(rows[0]?.sort_value), uri: String(rows[0]?.uri) },
  }
}
