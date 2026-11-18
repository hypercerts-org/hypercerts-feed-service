import { jsonToLex, type JsonObject } from '@atproto/lex'
import { describe, expect, it } from 'vitest'

import { FEED_KINDS, type FeedKind } from '../src/feed/types.js'
import type { ActorView } from '../src/hydration/types.js'
import {
  getEndorsedActorDid,
  validateFeedRecord,
  type ValidatedFeedRecord,
} from '../src/hydration/validation.js'
import { buildItemContent, buildItemSubject } from '../src/hydration/views.js'

const actorDid = 'did:plc:abcdefghijklmnopqrstuvwx'
const subjectDid = 'did:plc:zyxwvutsrqponmlkjihgfedc'
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const secondCid = 'bafyreifxcn6ts5hr6oequ5w5jyrpwrdl6p5lq46jasnxmcw3h3sme6asru'
const blobCid = 'bafkreiehxpuhtr5f6v4eu4byjo2j7kkrhjvd7psmfu4imnpdzb3bdqb7vy'
const secondBlobCid =
  'bafkreiemp3jntpsz4ioppt6h3j24nqglpxlvd5fiodypsi3pb424xl2yjy'
const createdAt = '2026-07-20T00:00:00.000Z'
const targetUri = `at://${subjectDid}/org.hypercerts.claim.activity/target`

const strongRef = (uri = targetUri, valueCid = cid): JsonObject => ({
  $type: 'com.atproto.repo.strongRef',
  uri,
  cid: valueCid,
})

const didSubject = (did = subjectDid): JsonObject => ({
  $type: 'app.certified.defs#did',
  did,
})

const uriImage = (uri: string): JsonObject => ({
  $type: 'org.hypercerts.defs#uri',
  uri,
})

const smallImage = (overrides: JsonObject = {}): JsonObject => ({
  $type: 'org.hypercerts.defs#smallImage',
  image: {
    $type: 'blob',
    ref: { $link: blobCid },
    mimeType: 'image/png',
    size: 128,
    ...overrides,
  },
})

const largeImage = (overrides: JsonObject = {}): JsonObject => ({
  $type: 'org.hypercerts.defs#largeImage',
  image: {
    $type: 'blob',
    ref: { $link: secondBlobCid },
    mimeType: 'image/webp',
    size: 256,
    ...overrides,
  },
})

const smallBlob = (
  mimeType: string,
  valueCid = blobCid,
  overrides: JsonObject = {},
): JsonObject => ({
  $type: 'org.hypercerts.defs#smallBlob',
  blob: {
    $type: 'blob',
    ref: { $link: valueCid },
    mimeType,
    size: 512,
    ...overrides,
  },
})

const protocolValue = (value: JsonObject): unknown =>
  jsonToLex(value, { strict: true })

const records = {
  activity: {
    $type: 'org.hypercerts.claim.activity',
    title: 'Restore the watershed',
    shortDescription: 'Native forest restoration',
    createdAt,
  },
  collection: {
    $type: 'org.hypercerts.collection',
    title: 'Watershed projects',
    createdAt,
  },
  evaluation: {
    $type: 'org.hypercerts.context.evaluation',
    evaluators: [didSubject(actorDid)],
    summary: 'Strong evidence',
    createdAt,
  },
  measurement: {
    $type: 'org.hypercerts.context.measurement',
    metric: 'hectares restored',
    unit: 'ha',
    value: '42',
    createdAt,
  },
  update: {
    $type: 'org.hypercerts.context.attachment',
    title: 'Field report',
    createdAt,
  },
  endorsement: {
    $type: 'app.certified.badge.award',
    badge: strongRef(
      `at://${actorDid}/app.certified.badge.definition/endorsement`,
      secondCid,
    ),
    subject: didSubject(),
    createdAt,
  },
} as const

const collectionKinds = ['collection', 'project-with-cert'] as const

const validated = (
  kind: FeedKind,
  collection: string,
  value: unknown,
): ValidatedFeedRecord => {
  const result = validateFeedRecord(kind, collection, value)
  expect(result).toBeDefined()
  if (result === undefined) {
    throw new Error(
      'Expected the test fixture to produce a validated feed record.',
    )
  }
  return result
}

const endorsedActor: ActorView = {
  did: subjectDid,
  displayName: 'Subject',
}

describe('top-level record validation', () => {
  it('accepts exactly the trusted collection and feed-kind matrix', () => {
    const cases: readonly [FeedKind, string, unknown][] = [
      ['cert', 'org.hypercerts.claim.activity', records.activity],
      ['collection', 'org.hypercerts.collection', records.collection],
      ['project-with-cert', 'org.hypercerts.collection', records.collection],
      ['evaluation', 'org.hypercerts.context.evaluation', records.evaluation],
      [
        'measurement',
        'org.hypercerts.context.measurement',
        records.measurement,
      ],
      ['update', 'org.hypercerts.context.attachment', records.update],
      ['endorsement', 'app.certified.badge.award', records.endorsement],
    ]

    for (const [kind, collection, value] of cases) {
      expect(validateFeedRecord(kind, collection, value)).toMatchObject({
        kind,
        collection,
        rawValue: value,
      })
    }
  })

  it('rejects missing or wrong types and collection/kind disagreements', () => {
    expect(
      validateFeedRecord('cert', 'org.hypercerts.claim.activity', {
        title: 'Missing type',
        shortDescription: 'Invalid',
        createdAt,
      }),
    ).toBeUndefined()
    expect(
      validateFeedRecord('cert', 'org.hypercerts.claim.activity', {
        ...records.activity,
        $type: 'org.hypercerts.collection',
      }),
    ).toBeUndefined()
    expect(
      validateFeedRecord(
        'collection',
        'org.hypercerts.claim.activity',
        records.activity,
      ),
    ).toBeUndefined()
    expect(
      validateFeedRecord(
        'cert',
        'org.hypercerts.collection',
        records.collection,
      ),
    ).toBeUndefined()
    expect(
      validateFeedRecord(
        'cert',
        'example.unknown.collection',
        records.activity,
      ),
    ).toBeUndefined()
    for (const kind of collectionKinds) {
      expect(
        validateFeedRecord(kind, 'org.hypercerts.collection', {
          ...records.collection,
          title: undefined,
        }),
      ).toBeUndefined()
    }
  })

  it('rejects schema-invalid fixtures for every remaining collection', () => {
    const invalidCases: readonly [FeedKind, string, unknown][] = [
      [
        'evaluation',
        'org.hypercerts.context.evaluation',
        { ...records.evaluation, summary: undefined },
      ],
      [
        'measurement',
        'org.hypercerts.context.measurement',
        { ...records.measurement, metric: undefined },
      ],
      [
        'update',
        'org.hypercerts.context.attachment',
        { ...records.update, title: undefined },
      ],
      [
        'endorsement',
        'app.certified.badge.award',
        { ...records.endorsement, badge: undefined },
      ],
    ]

    for (const [kind, collection, value] of invalidCases) {
      expect(validateFeedRecord(kind, collection, value)).toBeUndefined()
    }
  })

  it('requires an account subject for endorsement feed records', () => {
    const recordSubject = {
      ...records.endorsement,
      subject: strongRef(),
    }

    expect(
      validateFeedRecord(
        'endorsement',
        'app.certified.badge.award',
        recordSubject,
      ),
    ).toBeUndefined()
    expect(
      getEndorsedActorDid(
        validated(
          'endorsement',
          'app.certified.badge.award',
          records.endorsement,
        ),
      ),
    ).toBe(subjectDid)
    expect(
      getEndorsedActorDid(
        validated('cert', 'org.hypercerts.claim.activity', records.activity),
      ),
    ).toBeUndefined()
  })

  it('rejects malformed known projected blobs using v1.0.0 constraints', () => {
    const invalidCases: readonly [FeedKind, string, unknown][] = [
      [
        'cert',
        'org.hypercerts.claim.activity',
        { ...records.activity, image: smallImage({ size: -1 }) },
      ],
      [
        'cert',
        'org.hypercerts.claim.activity',
        { ...records.activity, image: smallImage({ size: 1.5 }) },
      ],
      [
        'cert',
        'org.hypercerts.claim.activity',
        {
          ...records.activity,
          image: smallImage({ ref: { $link: 'not-a-cid' } }),
        },
      ],
      [
        'cert',
        'org.hypercerts.claim.activity',
        { ...records.activity, image: smallImage({ mimeType: 'image/gif' }) },
      ],
      [
        'update',
        'org.hypercerts.context.attachment',
        {
          ...records.update,
          content: [smallBlob('image/png', blobCid, { size: 10_485_761 })],
        },
      ],
    ]
    const invalidCollectionValues = [
      { ...records.collection, avatar: smallImage({ size: 5_242_881 }) },
      { ...records.collection, banner: largeImage({ size: 10_485_761 }) },
    ]

    for (const [kind, collection, value] of invalidCases) {
      expect(validateFeedRecord(kind, collection, value)).toBeUndefined()
    }
    for (const kind of collectionKinds) {
      for (const value of invalidCollectionValues) {
        expect(
          validateFeedRecord(kind, 'org.hypercerts.collection', value),
        ).toBeUndefined()
      }
    }
  })

  it('rejects schema-invalid evaluation media blobs', () => {
    const invalidCases: readonly [FeedKind, string, unknown][] = [
      [
        'evaluation',
        'org.hypercerts.context.evaluation',
        {
          ...records.evaluation,
          content: [
            smallBlob('application/octet-stream', blobCid, {
              size: 10_485_761,
            }),
          ],
        },
      ],
    ]

    for (const [kind, collection, value] of invalidCases) {
      expect(validateFeedRecord(kind, collection, value)).toBeUndefined()
    }
  })

  it('accepts valid boundary and forward-compatible evaluation media', () => {
    expect(
      validateFeedRecord('evaluation', 'org.hypercerts.context.evaluation', {
        ...records.evaluation,
        content: [
          uriImage('https://example.com/evaluation'),
          { $type: 'example.future#attachment', value: 'future' },
          smallBlob('application/octet-stream', blobCid, {
            size: 10_485_760,
          }),
        ],
      }),
    ).toBeDefined()
  })

  it('preserves the original indexed JSON while views consume parsed validated data', () => {
    const raw: JsonObject = {
      ...records.activity,
      image: smallImage(),
    }
    const result = validated('cert', 'org.hypercerts.claim.activity', raw)

    expect(result.rawValue).toBe(raw)
    expect(result.value).not.toBe(raw)
    expect(result.value.image).not.toBe(raw.image)
    expect(raw.image).toMatchObject({ image: { ref: { $link: blobCid } } })

    raw.title = 'Mutated after validation'
    raw.shortDescription = 'Mutated after validation'
    raw.image = uriImage('https://example.com/mutated.png')

    expect(buildItemContent(result)).toEqual({
      $type: 'org.hypercerts.feed.defs#activityView',
      title: 'Restore the watershed',
      shortDescription: 'Native forest restoration',
      image: protocolValue(smallImage()),
      locationCount: 0,
    })
  })
})

describe('feed-card view builders', () => {
  it('builds the activity view with a blob descriptor and location count', () => {
    const record = validated('cert', 'org.hypercerts.claim.activity', {
      ...records.activity,
      image: smallImage(),
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-06-01T00:00:00.000Z',
      locations: [strongRef(), strongRef(`${targetUri}-2`, secondCid)],
    })

    expect(buildItemContent(record)).toEqual({
      $type: 'org.hypercerts.feed.defs#activityView',
      title: 'Restore the watershed',
      shortDescription: 'Native forest restoration',
      image: protocolValue(smallImage()),
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-06-01T00:00:00.000Z',
      locationCount: 2,
    })
  })

  it('uses identical strict v1 collection views for both collection kinds', () => {
    const raw = {
      ...records.collection,
      type: 'project',
      shortDescription: 'A coordinated portfolio',
      avatar: uriImage('https://example.com/avatar.png'),
      banner: largeImage(),
      name: 'Legacy name must be ignored',
      image: uriImage('https://example.com/legacy.png'),
      items: [
        { itemIdentifier: strongRef() },
        { itemIdentifier: strongRef(`${targetUri}-2`, secondCid) },
      ],
    }
    const expected = {
      $type: 'org.hypercerts.feed.defs#collectionView',
      collectionType: 'project',
      title: 'Watershed projects',
      shortDescription: 'A coordinated portfolio',
      image: {
        $type: 'org.hypercerts.defs#uri',
        uri: 'https://example.com/avatar.png',
      },
      itemCount: 2,
    }

    for (const kind of ['collection', 'project-with-cert'] as const) {
      expect(
        buildItemContent(validated(kind, 'org.hypercerts.collection', raw)),
      ).toEqual(expected)
    }
  })

  it('uses banner after an unprojected avatar and ignores legacy collection image fields', () => {
    const bannerRecord = validated('collection', 'org.hypercerts.collection', {
      ...records.collection,
      avatar: largeImage({ ref: { $link: blobCid } }),
      banner: largeImage(),
    })
    const legacyRecord = validated('collection', 'org.hypercerts.collection', {
      ...records.collection,
      name: 'Legacy name',
      image: uriImage('https://example.com/legacy.png'),
    })

    expect(buildItemContent(bannerRecord)).toMatchObject({
      title: 'Watershed projects',
      image: protocolValue(largeImage()),
    })
    expect(buildItemContent(legacyRecord)).toEqual({
      $type: 'org.hypercerts.feed.defs#collectionView',
      title: 'Watershed projects',
      itemCount: 0,
    })
  })

  it("returns the hydrated endorsed account as an endorsement's subject, with no content, and rejects missing or mismatched discovered summaries", () => {
    const record = validated(
      'endorsement',
      'app.certified.badge.award',
      records.endorsement,
    )

    expect(buildItemSubject(record, { endorsedActor })).toEqual({
      $type: 'org.hypercerts.feed.defs#actorView',
      ...endorsedActor,
    })
    expect(buildItemContent(record)).toBeUndefined()
    const mismatch =
      'Endorsement subject failed because the endorsed account could not be matched to its discovered identity; verify endorsement DID discovery and identity mapping before serving hydrated pages.'
    expect(() => buildItemSubject(record)).toThrow(mismatch)
    expect(() =>
      buildItemSubject(record, {
        endorsedActor: { ...endorsedActor, did: actorDid },
      }),
    ).toThrow(mismatch)
  })

  it('returns the evaluated record as the evaluation subject and every measured record in measurement content', () => {
    const evaluation = validated(
      'evaluation',
      'org.hypercerts.context.evaluation',
      {
        ...records.evaluation,
        subject: strongRef(),
        measurements: [strongRef(`${targetUri}-2`, secondCid)],
      },
    )
    const measurement = validated(
      'measurement',
      'org.hypercerts.context.measurement',
      {
        ...records.measurement,
        subjects: [strongRef(), strongRef(`${targetUri}-2`, secondCid)],
      },
    )
    expect(buildItemSubject(evaluation)).toEqual({
      $type: 'org.hypercerts.feed.defs#recordView',
      uri: targetUri,
      cid,
    })
    expect(buildItemContent(evaluation)).toEqual({
      $type: 'org.hypercerts.feed.defs#evaluationView',
      summary: 'Strong evidence',
    })
    expect(buildItemContent(measurement)).toEqual({
      $type: 'org.hypercerts.feed.defs#measurementView',
      metric: 'hectares restored',
      subjects: [
        { uri: targetUri, cid },
        { uri: `${targetUri}-2`, cid: secondCid },
      ],
    })
    // A measurement lists its subjects in content; only a single-subject record has an item subject.
    expect(buildItemSubject(measurement)).toBeUndefined()
  })

  it('selects the first image blob for updates, ignores URIs and non-images, and lists every subject', () => {
    const record = validated('update', 'org.hypercerts.context.attachment', {
      ...records.update,
      shortDescription: 'Photos and supporting documents',
      subjects: [strongRef(), strongRef(`${targetUri}-ignored`, secondCid)],
      content: [
        smallBlob('application/pdf'),
        uriImage('https://example.com/arbitrary.png'),
        { $type: 'example.future#attachment', value: 'future' },
        smallBlob('image/webp', secondBlobCid),
        smallBlob('image/png', blobCid),
      ],
    })

    expect(buildItemContent(record)).toEqual({
      $type: 'org.hypercerts.feed.defs#updateView',
      title: 'Field report',
      shortDescription: 'Photos and supporting documents',
      image: protocolValue(smallBlob('image/webp', secondBlobCid)),
      subjects: [
        { uri: targetUri, cid },
        { uri: `${targetUri}-ignored`, cid: secondCid },
      ],
    })
  })

  it('maps all seven feed kinds exhaustively to five content variants, none for an endorsement', () => {
    const cases = {
      cert: {
        collection: 'org.hypercerts.claim.activity',
        value: records.activity,
        expectedType: 'org.hypercerts.feed.defs#activityView',
      },
      collection: {
        collection: 'org.hypercerts.collection',
        value: records.collection,
        expectedType: 'org.hypercerts.feed.defs#collectionView',
      },
      'project-with-cert': {
        collection: 'org.hypercerts.collection',
        value: records.collection,
        expectedType: 'org.hypercerts.feed.defs#collectionView',
      },
      evaluation: {
        collection: 'org.hypercerts.context.evaluation',
        value: records.evaluation,
        expectedType: 'org.hypercerts.feed.defs#evaluationView',
      },
      measurement: {
        collection: 'org.hypercerts.context.measurement',
        value: records.measurement,
        expectedType: 'org.hypercerts.feed.defs#measurementView',
      },
      update: {
        collection: 'org.hypercerts.context.attachment',
        value: records.update,
        expectedType: 'org.hypercerts.feed.defs#updateView',
      },
      endorsement: {
        collection: 'app.certified.badge.award',
        value: records.endorsement,
        expectedType: undefined,
      },
    } satisfies Record<
      FeedKind,
      {
        readonly collection: string
        readonly value: unknown
        readonly expectedType: string | undefined
      }
    >

    expect(
      FEED_KINDS.map((kind) => ({
        kind,
        viewType: buildItemContent(
          validated(kind, cases[kind].collection, cases[kind].value),
        )?.$type,
      })),
    ).toEqual(
      FEED_KINDS.map((kind) => ({
        kind,
        viewType: cases[kind].expectedType,
      })),
    )
  })

  it('omits unknown open-union activity images without rejecting the record', () => {
    const record = validated('cert', 'org.hypercerts.claim.activity', {
      ...records.activity,
      image: { $type: 'example.future#image', value: 'future' },
    })

    expect(buildItemContent(record)).toEqual({
      $type: 'org.hypercerts.feed.defs#activityView',
      title: 'Restore the watershed',
      shortDescription: 'Native forest restoration',
      locationCount: 0,
    })
  })
})
