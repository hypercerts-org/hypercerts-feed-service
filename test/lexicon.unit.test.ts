import { readFileSync } from 'node:fs'

import { jsonToLex } from '@atproto/lex'
import { describe, expect, it } from 'vitest'

import { FeedErrorCode } from '../src/feed/errors.js'
import {
  itemView,
  maearthFeedParams,
} from '../src/lexicons/org/hypercerts/feed/defs.js'
import {
  $input as hydratedInput,
  $output as hydratedOutput,
} from '../src/lexicons/org/hypercerts/feed/getFeed.js'
import {
  $input as skeletonInput,
  $output as skeletonOutput,
} from '../src/lexicons/org/hypercerts/feed/getFeedSkeleton.js'

type JsonObject = Record<string, unknown>

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isJsonArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value)

const asJsonObject = (value: unknown): JsonObject => {
  if (!isJsonObject(value)) throw new Error('Expected a Lexicon JSON object')
  return value
}

const valueAt = (root: JsonObject, ...path: string[]): unknown => {
  let value: unknown = root
  for (const key of path) {
    value = asJsonObject(value)[key]
  }
  return value
}

const objectAt = (root: JsonObject, ...path: string[]): JsonObject =>
  asJsonObject(valueAt(root, ...path))

const arrayAt = (root: JsonObject, ...path: string[]): readonly unknown[] => {
  const value = valueAt(root, ...path)
  if (!isJsonArray(value)) throw new Error('Expected a Lexicon JSON array')
  return value
}

const readLexicon = (relativePath: string): JsonObject => {
  const source = readFileSync(
    new URL(`../lexicons/${relativePath}`, import.meta.url),
    'utf8',
  )
  const value: unknown = JSON.parse(source)
  if (!isJsonObject(value)) throw new Error('Expected a Lexicon document')
  return value
}

const skeletonLexicon = readLexicon('org/hypercerts/feed/getFeedSkeleton.json')
const hydratedLexicon = readLexicon('org/hypercerts/feed/getFeed.json')
const defsLexicon = readLexicon('org/hypercerts/feed/defs.json')

const skeletonMain = objectAt(skeletonLexicon, 'defs', 'main')
const hydratedMain = objectAt(hydratedLexicon, 'defs', 'main')
const defs = objectAt(defsLexicon, 'defs')

const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actorDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const uri = `at://${actorDid}/org.hypercerts.claim.activity/3kpn`
const targetUri = `at://${viewerDid}/org.hypercerts.claim.activity/target`
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const blobCid = 'bafkreiehxpuhtr5f6v4eu4byjo2j7kkrhjvd7psmfu4imnpdzb3bdqb7vy'
const createdAt = '2026-07-21T10:00:00.000Z'
const feedId = 'org.hypercerts.feed.defs#hypercertsFeed'
const paramsType = 'org.hypercerts.feed.defs#hypercertsFeedParams'
const supportedFeedKinds = [
  'cert',
  'collection',
  'project-with-cert',
  'evaluation',
  'measurement',
  'endorsement',
  'update',
] as const

const feedRequest = {
  feedId,
  params: { $type: paramsType, viewerDid },
  limit: 20,
  cursor: 'next-page',
}

const uriImage = {
  $type: 'org.hypercerts.defs#uri',
  uri: 'https://example.com/image.png',
}
const blobJson = {
  $type: 'blob',
  ref: { $link: blobCid },
  mimeType: 'image/png',
  size: 128,
}
const blob = jsonToLex(blobJson, { strict: true })
const blobWith = (overrides: JsonObject): JsonObject => ({
  ...blobJson,
  ...overrides,
})
const smallImage = {
  $type: 'org.hypercerts.defs#smallImage',
  image: blob,
}
const largeImage = {
  $type: 'org.hypercerts.defs#largeImage',
  image: blob,
}
const smallBlob = {
  $type: 'org.hypercerts.defs#smallBlob',
  blob,
}
const actor = {
  did: actorDid,
  displayName: 'Actor',
  avatar: smallImage,
}
const recordRef = { uri: targetUri, cid }
const recordSubject = {
  $type: 'org.hypercerts.feed.defs#recordView',
  ...recordRef,
}
const actorSubject = {
  $type: 'org.hypercerts.feed.defs#actorView',
  did: viewerDid,
}

const contentByKind = {
  cert: {
    $type: 'org.hypercerts.feed.defs#activityView',
    title: 'Restore the watershed',
    image: uriImage,
    locationCount: 2,
  },
  collection: {
    $type: 'org.hypercerts.feed.defs#collectionView',
    title: 'Watershed projects',
    image: largeImage,
    itemCount: 3,
  },
  'project-with-cert': {
    $type: 'org.hypercerts.feed.defs#collectionView',
    title: 'Watershed project',
    itemCount: 1,
  },
  evaluation: {
    $type: 'org.hypercerts.feed.defs#evaluationView',
    summary: 'Strong evidence',
  },
  measurement: {
    $type: 'org.hypercerts.feed.defs#measurementView',
    metric: 'hectares restored',
    subjects: [recordRef],
  },
  update: {
    $type: 'org.hypercerts.feed.defs#updateView',
    title: 'Field report',
    image: smallBlob,
    subjects: [recordRef],
  },
} as const

const hypercertsItem = (
  kind: (typeof supportedFeedKinds)[number],
): JsonObject => {
  // Evaluations point at a record and endorsements at an account; an endorsement has no content.
  const subject =
    kind === 'evaluation'
      ? recordSubject
      : kind === 'endorsement'
        ? actorSubject
        : undefined
  const content = kind === 'endorsement' ? undefined : contentByKind[kind]
  return {
    uri,
    cid,
    author: actor,
    kind,
    sortAt: createdAt,
    createdAt,
    ...(subject === undefined ? {} : { subject }),
    ...(content === undefined ? {} : { content }),
  }
}

const withContent = (item: JsonObject, content: JsonObject): JsonObject => ({
  ...item,
  content,
})

describe('feed Lexicon contract', () => {
  it('keeps registered feed inputs and UpperCamelCase public errors identical', () => {
    expect(valueAt(hydratedMain, 'input')).toEqual(
      valueAt(skeletonMain, 'input'),
    )
    expect(valueAt(hydratedMain, 'input', 'schema', 'required')).toEqual([
      'feedId',
    ])
    expect(
      valueAt(hydratedMain, 'input', 'schema', 'properties', 'feedId'),
    ).toMatchObject({
      type: 'string',
      knownValues: [feedId, 'org.hypercerts.feed.defs#maearthFeed'],
    })
    expect(
      valueAt(
        defs,
        'hypercertsFeedParams',
        'properties',
        'kinds',
        'items',
        'knownValues',
      ),
    ).toEqual(supportedFeedKinds)
    expect(
      valueAt(defs, 'itemView', 'properties', 'kind', 'knownValues'),
    ).toEqual([
      ...supportedFeedKinds,
      'repost',
      'project-follow',
      'account-follow',
    ])
    expect(
      valueAt(hydratedMain, 'input', 'schema', 'properties', 'params'),
    ).toMatchObject({
      type: 'union',
      closed: false,
      refs: [paramsType, 'org.hypercerts.feed.defs#maearthFeedParams'],
    })
    expect(
      valueAt(defs, 'hypercertsFeedParams', 'required') ?? [],
    ).not.toContain('viewerDid')
    expect(
      valueAt(hydratedMain, 'input', 'schema', 'properties', 'limit'),
    ).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 100,
    })
    expect(
      valueAt(hydratedMain, 'input', 'schema', 'properties', 'cursor'),
    ).toMatchObject({
      type: 'string',
      maxLength: 4096,
    })
    const paramsProperties = objectAt(
      defs,
      'hypercertsFeedParams',
      'properties',
    )
    expect(paramsProperties).not.toHaveProperty('authors')
    expect(paramsProperties).not.toHaveProperty('limit')
    expect(paramsProperties).not.toHaveProperty('cursor')
    expect(valueAt(paramsProperties, 'organizationQuality', 'ref')).toBe(
      'org.hypercerts.feed.defs#organizationQualityPolicy',
    )
    expect(valueAt(hydratedMain, 'errors')).toEqual(
      valueAt(skeletonMain, 'errors'),
    )
    const errorNames = arrayAt(hydratedMain, 'errors').map((error) =>
      valueAt(asJsonObject(error), 'name'),
    )
    expect(errorNames).toEqual([
      'InvalidRequest',
      'UnsupportedFeed',
      'InvalidCursor',
      'InternalError',
    ])
    expect(errorNames).toEqual(Object.values(FeedErrorCode))

    for (const parser of [skeletonInput, hydratedInput]) {
      expect(() => parser.schema.$parse(feedRequest)).not.toThrow()
      expect(() =>
        parser.schema.$parse({
          feedId: 'app.example.feed.defs#futureFeed',
          limit: 100,
          cursor: 'future-page',
        }),
      ).not.toThrow()
      expect(() =>
        parser.schema.$parse({
          feedId: 'app.example.feed.defs#futureFeed',
          params: {
            $type: 'app.example.feed.defs#futureParams',
            future: true,
          },
        }),
      ).not.toThrow()
    }
  })

  it('defines the generic URI-only skeleton wire shape', () => {
    expect(valueAt(skeletonMain, 'output', 'schema', 'required')).toEqual([
      'feed',
    ])
    expect(
      valueAt(skeletonMain, 'output', 'schema', 'properties', 'cursor'),
    ).toMatchObject({
      type: 'string',
      maxLength: 4096,
    })
    expect(
      valueAt(skeletonMain, 'output', 'schema', 'properties', 'feed', 'items'),
    ).toEqual({ type: 'ref', ref: 'org.hypercerts.feed.defs#skeletonItem' })
    expect(valueAt(defs, 'skeletonItem', 'required')).toEqual(['uri'])
    expect(Object.keys(objectAt(defs, 'skeletonItem', 'properties'))).toEqual([
      'uri',
    ])
    expect(valueAt(defs, 'skeletonItem', 'properties', 'uri')).toMatchObject({
      type: 'string',
      format: 'at-uri',
    })
    expect(defs).toHaveProperty('organizationQualityPolicy')
    expect(skeletonLexicon.defs).not.toHaveProperty('organizationQualityPolicy')
    expect(skeletonLexicon.defs).not.toHaveProperty('feedSkeletonItem')

    expect(() =>
      skeletonInput.schema.$parse({
        feedId,
        params: {
          $type: paramsType,
          viewerDid,
          organizationQuality: {
            allowed: ['high-quality'],
            includeUnrated: false,
          },
        },
      }),
    ).not.toThrow()
    expect(() =>
      skeletonInput.schema.$parse({
        feedId,
        params: { $type: paramsType },
      }),
    ).not.toThrow()
    expect(() =>
      skeletonOutput.schema.$parse({ feed: [{ uri }] }),
    ).not.toThrow()
    expect(() =>
      skeletonOutput.schema.$parse({ feed: [{ subject: uri }] }),
    ).toThrow()
  })

  it('keeps every union in the public feed Lexicons open', () => {
    for (const lexicon of [skeletonLexicon, hydratedLexicon, defsLexicon]) {
      expect(JSON.stringify(lexicon)).not.toContain('"closed":true')
    }
  })

  it('defines one flat item with only uri, author, kind and sortAt required and open unions', () => {
    expect(valueAt(hydratedMain, 'output', 'schema', 'required')).toEqual([
      'feed',
    ])
    expect(
      valueAt(hydratedMain, 'output', 'schema', 'properties', 'feed', 'items'),
    ).toEqual({ type: 'ref', ref: 'org.hypercerts.feed.defs#itemView' })
    expect(valueAt(defs, 'itemView', 'required')).toEqual([
      'uri',
      'author',
      'kind',
      'sortAt',
    ])
    expect(objectAt(defs, 'itemView', 'properties')).toMatchObject({
      uri: { type: 'string', format: 'at-uri' },
      cid: { type: 'string', format: 'cid' },
      author: { type: 'ref', ref: '#actorView' },
      sortAt: { type: 'string', format: 'datetime' },
      createdAt: { type: 'string', format: 'datetime' },
      subject: {
        type: 'union',
        closed: false,
        refs: ['#recordView', '#actorView'],
      },
      likeCount: { type: 'integer', minimum: 0 },
      repostCount: { type: 'integer', minimum: 0 },
      replyCount: { type: 'integer', minimum: 0 },
      content: {
        type: 'union',
        closed: false,
        refs: [
          '#activityView',
          '#collectionView',
          '#evaluationView',
          '#measurementView',
          '#updateView',
        ],
      },
    })
    expect(valueAt(defs, 'actorView', 'required')).toEqual(['did'])
    expect(valueAt(defs, 'recordView', 'required')).toEqual(['uri'])
    // The envelope and the per-feed views it carried are gone.
    for (const removed of [
      'feedItem',
      'hypercertsFeedView',
      'maearthFeedView',
      'maearthActor',
      'maearthTarget',
      'actorSummary',
      'endorsementView',
    ]) {
      expect(defs).not.toHaveProperty(removed)
    }
    expect(hydratedLexicon.defs).not.toHaveProperty('feedItem')

    const serialized = JSON.stringify(valueAt(defs, 'itemView'))
    for (const forbidden of [
      'record',
      'recordState',
      'profileSource',
      'actorDid',
      'feedTimestamp',
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`)
    }
  })

  it('keeps activity and collection counts optional on the wire', () => {
    expect(valueAt(defs, 'activityView', 'required')).toEqual(['title'])
    expect(valueAt(defs, 'collectionView', 'required')).toEqual(['title'])
    expect(
      valueAt(defs, 'activityView', 'properties', 'locationCount'),
    ).toEqual({
      type: 'integer',
      minimum: 0,
    })
    expect(valueAt(defs, 'collectionView', 'properties', 'itemCount')).toEqual({
      type: 'integer',
      minimum: 0,
    })

    const activityWithoutCount: Record<string, unknown> = {
      ...contentByKind.cert,
    }
    const collectionWithoutCount: Record<string, unknown> = {
      ...contentByKind.collection,
    }
    delete activityWithoutCount.locationCount
    delete collectionWithoutCount.itemCount

    expect(() =>
      hydratedOutput.schema.$parse({
        feed: [
          withContent(hypercertsItem('cert'), activityWithoutCount),
          withContent(hypercertsItem('collection'), collectionWithoutCount),
        ],
      }),
    ).not.toThrow()
  })

  it('uses protocol-native Hypercerts variants through open image unions', () => {
    expect(defs).not.toHaveProperty('uriImage')
    expect(defs).not.toHaveProperty('blobImage')
    expect(
      Object.keys(objectAt(defs, 'actorView', 'properties')).sort(),
    ).toEqual(['avatar', 'did', 'displayName'])
    expect(valueAt(defs, 'actorView', 'properties', 'avatar')).toEqual({
      type: 'union',
      refs: ['org.hypercerts.defs#uri', 'org.hypercerts.defs#smallImage'],
    })
    expect(valueAt(defs, 'activityView', 'properties', 'image')).toEqual(
      valueAt(defs, 'actorView', 'properties', 'avatar'),
    )
    expect(valueAt(defs, 'collectionView', 'properties', 'image')).toEqual({
      type: 'union',
      refs: [
        'org.hypercerts.defs#uri',
        'org.hypercerts.defs#smallImage',
        'org.hypercerts.defs#largeImage',
      ],
    })
    expect(valueAt(defs, 'updateView', 'properties', 'image')).toEqual({
      type: 'union',
      refs: ['org.hypercerts.defs#uri', 'org.hypercerts.defs#smallBlob'],
    })
  })

  it('moves createdAt and the evaluation target to the item and lists subjects only in measurement and update content', () => {
    for (const name of [
      'activityView',
      'collectionView',
      'evaluationView',
      'measurementView',
      'updateView',
    ]) {
      const properties = objectAt(defs, name, 'properties')
      expect(properties).not.toHaveProperty('createdAt')
      expect(properties).not.toHaveProperty('target')
    }
    for (const name of ['measurementView', 'updateView']) {
      expect(valueAt(defs, name, 'properties', 'subjects')).toMatchObject({
        type: 'array',
        items: { type: 'ref', ref: '#recordView' },
      })
    }
  })

  it('accepts both image variants and every Hypercerts kind with its own subject and content', () => {
    const items = supportedFeedKinds.map((kind) => hypercertsItem(kind))

    expect(() =>
      hydratedOutput.schema.$parse({ feed: items, cursor: 'opaque-cursor' }),
    ).not.toThrow()
  })

  it('accepts unknown future image, subject and content variants and unknown fields', () => {
    const unknownImage = {
      $type: 'example.feed#unknownImage',
      uri: 'https://example.com/future-image.png',
    }
    expect(() =>
      hydratedOutput.schema.$parse({
        feed: [
          {
            ...hypercertsItem('cert'),
            author: {
              did: actorDid,
              avatar: unknownImage,
              handle: 'a.example',
            },
            somethingNew: 1,
          },
          withContent(hypercertsItem('cert'), {
            ...contentByKind.cert,
            image: unknownImage,
          }),
          withContent(hypercertsItem('cert'), {
            $type: 'example.feed#unknownContent',
          }),
          {
            ...hypercertsItem('evaluation'),
            subject: { $type: 'example.feed#unknownSubject' },
          },
        ],
      }),
    ).not.toThrow()
  })

  it.each([
    ['the old envelope', { subject: uri, view: { $type: 'x', kind: 'cert' } }],
    [
      'a missing author',
      (() => {
        const { author: _author, ...item } = hypercertsItem('cert')
        return item
      })(),
    ],
    [
      'a missing sortAt',
      (() => {
        const { sortAt: _sortAt, ...item } = hypercertsItem('cert')
        return item
      })(),
    ],
    [
      'a subject without a discriminator',
      { ...hypercertsItem('evaluation'), subject: recordRef },
    ],
    [
      'a malformed subject reference',
      {
        ...hypercertsItem('evaluation'),
        subject: { ...recordSubject, uri: 'not-an-at-uri' },
      },
    ],
    [
      'a content value without a discriminator',
      withContent(hypercertsItem('cert'), { title: 'No type' }),
    ],
    [
      'a malformed author DID',
      { ...hypercertsItem('cert'), author: { did: 'not-a-did' } },
    ],
    [
      'a malformed sortAt',
      { ...hypercertsItem('cert'), sortAt: '2026-07-21T10:00:00' },
    ],
    [
      'an avatar without a discriminator',
      {
        ...hypercertsItem('cert'),
        author: {
          did: actorDid,
          avatar: { uri: 'https://example.com/image.png' },
        },
      },
    ],
    [
      'a malformed blob CID',
      {
        ...hypercertsItem('cert'),
        author: {
          did: actorDid,
          avatar: {
            $type: 'org.hypercerts.defs#smallImage',
            image: blobWith({ ref: 'not-a-cid' }),
          },
        },
      },
    ],
    [
      'a malformed image URI',
      {
        ...hypercertsItem('cert'),
        author: { did: actorDid, avatar: { ...uriImage, uri: 'not a URI' } },
      },
    ],
    [
      'a negative image size',
      {
        ...hypercertsItem('cert'),
        author: {
          did: actorDid,
          avatar: {
            $type: 'org.hypercerts.defs#smallImage',
            image: blobWith({ size: -1 }),
          },
        },
      },
    ],
    [
      'a malformed measured record',
      withContent(hypercertsItem('measurement'), {
        ...contentByKind.measurement,
        subjects: [{ uri: 'not-an-at-uri', cid: 'not-a-cid' }],
      }),
    ],
  ])('rejects %s', (_label, item) => {
    expect(() => hydratedOutput.schema.$parse({ feed: [item] })).toThrow()
  })
})

describe('MaEarth feed Lexicon contract', () => {
  const maearthKinds = ['update', 'repost', 'project-follow', 'account-follow']

  it('defines bounded open-enum params with the MaEarth kinds', () => {
    expect(valueAt(defs, 'maearthFeed', 'type')).toBe('token')
    expect(valueAt(defs, 'maearthFeedParams', 'required')).toBeUndefined()
    expect(objectAt(defs, 'maearthFeedParams', 'properties')).toMatchObject({
      viewerDid: { type: 'string', format: 'did', maxLength: 256 },
      actorDid: { type: 'string', format: 'did', maxLength: 256 },
      kinds: {
        type: 'array',
        maxLength: 32,
        items: { type: 'string', maxLength: 64, knownValues: maearthKinds },
      },
    })
  })

  it('parses flat MaEarth items, with subject and counts per kind and no content, and rejects malformed ones', () => {
    const base = {
      uri: `at://${actorDid}/app.certified.feed.repost/3kpn`,
      cid,
      author: { did: actorDid },
      kind: 'repost',
      sortAt: '2026-10-14T12:00:00.123456Z',
      // The record's own value, which need not be UTC.
      createdAt: '2026-10-14T14:00:00.5+02:00',
    }
    const postUri = `at://${actorDid}/org.hypercerts.context.attachment/3kpn`
    const projectUri = `at://${actorDid}/org.hypercerts.collection/3kpn`
    const counts = { likeCount: 0, repostCount: 12, replyCount: 3 }
    for (const valid of [
      {
        subject: {
          $type: 'org.hypercerts.feed.defs#recordView',
          uri: postUri,
          cid,
          ...counts,
        },
      },
      // A project follow's subject has no CID.
      {
        kind: 'project-follow',
        subject: {
          $type: 'org.hypercerts.feed.defs#recordView',
          uri: projectUri,
        },
      },
      {
        kind: 'account-follow',
        subject: { $type: 'org.hypercerts.feed.defs#actorView', did: actorDid },
      },
      { kind: 'update', ...counts },
      { kind: 'update' },
    ]) {
      expect(itemView.schema.$parse({ ...base, ...valid })).toEqual({
        ...base,
        ...valid,
      })
    }
    // cid and createdAt are optional; the four required fields are not.
    for (const optional of ['cid', 'createdAt'] as const) {
      const { [optional]: _omitted, ...rest } = base
      expect(() => itemView.schema.$parse(rest)).not.toThrow()
    }
    for (const required of ['uri', 'author', 'kind', 'sortAt'] as const) {
      const { [required]: _omitted, ...rest } = base
      expect(() => itemView.schema.$parse(rest)).toThrow()
    }
    // Objects and unions are open: later fields and variants must not break parsing.
    expect(() =>
      itemView.schema.$parse({
        ...base,
        author: { did: actorDid, handle: 'someone.example.com' },
        subject: {
          $type: 'org.hypercerts.feed.defs#recordView',
          uri: postUri,
          future: true,
        },
        kind: 'future-kind',
        somethingNew: 1,
      }),
    ).not.toThrow()
    for (const invalid of [
      { createdAt: '10000-01-01T00:00:00Z' },
      { createdAt: '2026-10-14T12:00:00' },
      { sortAt: '2026-10-14T12:00:00' },
      { cid: 'not-a-cid' },
      { author: {} },
      { author: { did: 'not-a-did' } },
      { author: actorDid },
      { subject: { uri: postUri } },
      {
        subject: {
          $type: 'org.hypercerts.feed.defs#recordView',
          uri: 'not-an-at-uri',
        },
      },
      {
        subject: {
          $type: 'org.hypercerts.feed.defs#actorView',
          did: 'not-a-did',
        },
      },
      // The parser's 2048-character DID cap is why the SQL guards the follow subject length.
      {
        subject: {
          $type: 'org.hypercerts.feed.defs#actorView',
          did: `did:web:${'a'.repeat(2041)}`,
        },
      },
      {
        subject: {
          $type: 'org.hypercerts.feed.defs#actorView',
          did: projectUri,
        },
      },
      {
        subject: {
          $type: 'org.hypercerts.feed.defs#recordView',
          uri: postUri,
          cid: 'not-a-cid',
        },
      },
      { likeCount: -1 },
      { repostCount: 1.5 },
      { replyCount: '3' },
    ]) {
      expect(() => itemView.schema.$parse({ ...base, ...invalid })).toThrow()
    }
    expect(
      maearthFeedParams.schema.$parse({
        $type: 'org.hypercerts.feed.defs#maearthFeedParams',
        viewerDid,
        kinds: ['update', 'future-kind'],
      }),
    ).toMatchObject({ viewerDid })
  })
})
