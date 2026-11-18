import { describe, expect, it } from 'vitest'

import { type FeedError, FeedErrorCode } from '../src/feed/errors.js'
import { FEED_KINDS, type HypercertsFeedParams } from '../src/feed/types.js'
import { normalizeFeedRequest } from '../src/feed/validation.js'

const paramsType = 'org.hypercerts.feed.defs#hypercertsFeedParams'
const viewer = 'did:plc:ar7c4by46qjdydhdevvrndac'

const feedParams = (
  params: Omit<HypercertsFeedParams, '$type'>,
): HypercertsFeedParams => ({ $type: paramsType, ...params })

describe('feed request validation', () => {
  it('normalizes the viewer-follow request defaults', () => {
    expect(
      normalizeFeedRequest(feedParams({ viewerDid: viewer })),
    ).toMatchObject({
      viewerDid: viewer,
      trustedEvaluators: [],
      kinds: [],
      limit: 20,
    })
  })

  it('deduplicates evaluator DIDs before applying the list limit', () => {
    const result = normalizeFeedRequest(
      feedParams({
        viewerDid: viewer,
        trustedEvaluators: Array.from({ length: 100 }, () => viewer),
      }),
    )

    expect(result.trustedEvaluators).toEqual([viewer])
  })

  it('reports Hypercerts parameter failures through the generic InvalidRequest error', () => {
    expect(() =>
      normalizeFeedRequest(
        feedParams({ viewerDid: viewer, kinds: ['cert.creat'] }),
      ),
    ).toThrow(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
        status: 422,
      }),
    )

    const trustedEvaluators = Array.from(
      { length: 65 },
      (_, index) => `did:plc:${index.toString(36).padStart(24, 'a')}`,
    )
    expect(() =>
      normalizeFeedRequest(
        feedParams({ viewerDid: viewer, trustedEvaluators }),
      ),
    ).toThrow(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
        status: 422,
      }),
    )
  })

  it('accepts every kebab-case kind and rejects the former dotted names with the supported list', () => {
    expect(
      normalizeFeedRequest(
        feedParams({ viewerDid: viewer, kinds: [...FEED_KINDS] }),
      ).kinds,
    ).toEqual(FEED_KINDS)

    for (const former of [
      'cert.create',
      'collection.create',
      'project.created_with_cert',
      'evaluation.create',
      'measurement.create',
      'update.create',
      'endorsement.award',
    ]) {
      expect(() =>
        normalizeFeedRequest(
          feedParams({ viewerDid: viewer, kinds: [former] }),
        ),
      ).toThrow(
        'use one of: cert, collection, project-with-cert, evaluation, measurement, endorsement, update.',
      )
    }
  })

  it('rejects empty event kind values', () => {
    expect(() =>
      normalizeFeedRequest(feedParams({ viewerDid: viewer, kinds: [''] })),
    ).toThrow(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
        status: 422,
      }),
    )
  })

  it.each(['', 'excellent'])(
    'rejects unsupported organization quality %j',
    (quality) => {
      expect(() =>
        normalizeFeedRequest(
          feedParams({
            viewerDid: viewer,
            organizationQuality: {
              allowed: [quality],
              includeUnrated: false,
            },
          }),
        ),
      ).toThrow(
        expect.objectContaining<Partial<FeedError>>({
          code: FeedErrorCode.InvalidRequest,
        }),
      )
    },
  )

  it('rejects malformed viewers and page sizes', () => {
    expect(() =>
      normalizeFeedRequest(feedParams({ viewerDid: 'alice.test' })),
    ).toThrow(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
      }),
    )
    expect(() =>
      normalizeFeedRequest(feedParams({ viewerDid: viewer }), { limit: 51 }),
    ).toThrow(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
      }),
    )
  })
})
