import { randomBytes } from 'node:crypto'

import pino from 'pino'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'
import { Database } from '../src/database.js'
import { createHypercertsFeed } from '../src/feed/query.js'
import { FeedRegistry } from '../src/feed/registry.js'
import { FeedService } from '../src/feed/service.js'
import {
  HYPERCERTS_FEED_ID,
  HYPERCERTS_FEED_PARAMS_TYPE,
  type HypercertsFeedParams,
  type GetFeedSkeletonInput,
} from '../src/feed/types.js'
import { PostgresIdentityReader } from '../src/hydration/identity.js'
import { Metrics } from '../src/metrics.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
if (!TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is required for integration tests; point it at an empty disposable Postgres 16+ database.',
  )
}
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const staleCid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72a'
const plcAlphabet = 'abcdefghijklmnopqrstuvwxyz234567'

const randomDid = (): string => {
  const bytes = randomBytes(24)
  let suffix = ''
  for (const byte of bytes) suffix += plcAlphabet[byte % plcAlphabet.length]
  return `did:plc:${suffix}`
}

describe('Hypercerts feed definition against Postgres', () => {
  const logger = pino({ enabled: false })
  let admin: Pool
  let database: Database
  let identities: PostgresIdentityReader
  let pages: FeedRegistry
  let service: FeedService
  let externalLabelSeq = 0

  beforeAll(async () => {
    admin = new Pool({ connectionString: TEST_DATABASE_URL })
    await admin.query(`
      CREATE TABLE IF NOT EXISTS record (
        uri text PRIMARY KEY NOT NULL,
        cid text NOT NULL,
        did text NOT NULL,
        collection text NOT NULL,
        json jsonb NOT NULL,
        indexed_at timestamptz NOT NULL DEFAULT NOW(),
        rkey text GENERATED ALWAYS AS (substring(uri from '[^/]+$')) STORED,
        record_created_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS idx_record_did_collection
        ON record(did, collection);
      CREATE INDEX IF NOT EXISTS idx_record_timeline_author_collection_created
        ON record(did, collection, record_created_at DESC, uri DESC)
        WHERE record_created_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS actor (
        did text PRIMARY KEY NOT NULL,
        handle text,
        indexed_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS label_subscription_state (
        url text PRIMARY KEY,
        labeler_did text,
        last_seq bigint NOT NULL DEFAULT 0,
        last_connected_at timestamptz,
        last_event_at timestamptz,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS external_label (
        id bigserial PRIMARY KEY,
        subscription_url text NOT NULL,
        seq bigint NOT NULL,
        label_index integer NOT NULL,
        src text NOT NULL,
        uri text NOT NULL,
        cid text,
        val text NOT NULL,
        neg boolean NOT NULL DEFAULT false,
        cts text NOT NULL,
        exp text,
        sig text,
        ver integer,
        raw_json jsonb,
        received_at timestamptz NOT NULL DEFAULT NOW(),
        FOREIGN KEY (subscription_url)
          REFERENCES label_subscription_state(url) ON DELETE CASCADE,
        UNIQUE (subscription_url, seq, label_index)
      );
      CREATE INDEX IF NOT EXISTS idx_external_label_active_lookup
        ON external_label(uri, val, src, cid, cts DESC, id DESC);
    `)

    const config = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      SERVICE_DID: 'did:web:feed.example',
      DATABASE_MAX_CONNECTIONS: '3',
      DATABASE_STATEMENT_TIMEOUT_MS: '10000',
    })
    database = new Database(config, logger)
    identities = new PostgresIdentityReader(database)
    pages = createPages()
    service = new FeedService(pages)
  })

  afterAll(async () => {
    await database?.close()
    await admin?.end()
  })

  const seedActor = async (
    did: string,
    options: { readonly handle?: string } = {},
  ): Promise<void> => {
    await admin.query(
      `INSERT INTO actor (did, handle, indexed_at)
       VALUES ($1, $2, NOW())`,
      [did, options.handle ?? null],
    )
  }

  const seedRecord = async (
    did: string,
    collection: string,
    rkey: string,
    body: Record<string, unknown>,
    effectiveAt: string,
    options: {
      readonly cid?: string
      readonly indexedAt?: string
      readonly recordCreatedAt?: string | null
    } = {},
  ): Promise<string> => {
    const uri = `at://${did}/${collection}/${rkey}`
    const indexedAt = options.indexedAt ?? effectiveAt
    const recordCreatedAt =
      options.recordCreatedAt === undefined
        ? effectiveAt
        : options.recordCreatedAt
    await admin.query(
      `INSERT INTO record (
         uri, cid, did, collection, json, indexed_at, record_created_at
       )
       VALUES (
         $1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7::timestamptz
       )`,
      [
        uri,
        options.cid ?? cid,
        did,
        collection,
        JSON.stringify(body),
        indexedAt,
        recordCreatedAt,
      ],
    )
    return uri
  }

  const seedFollow = async (viewerDid: string, subjectDid: string): Promise<void> => {
    await seedRecord(
      viewerDid,
      'app.certified.graph.follow',
      `follow-${randomBytes(8).toString('hex')}`,
      { subject: subjectDid },
      '2026-07-20T00:00:00Z',
    )
  }

  type HypercertsFeedOverrides = Omit<
    HypercertsFeedParams,
    '$type' | 'viewerDid'
  > & Pick<GetFeedSkeletonInput, 'limit' | 'cursor'>

  const createPages = (
    trustedQualityLabelerDids: readonly string[] = [],
  ): FeedRegistry =>
    new FeedRegistry([
      createHypercertsFeed(
        { database, metrics: new Metrics() },
        trustedQualityLabelerDids,
      ),
    ])

  const feedRequest = (
    viewerDid: string,
    input: HypercertsFeedOverrides = {},
  ): GetFeedSkeletonInput => {
    const { limit, cursor, ...params } = input
    return {
      feedId: HYPERCERTS_FEED_ID,
      params: {
        $type: HYPERCERTS_FEED_PARAMS_TYPE,
        viewerDid,
        ...params,
      },
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    }
  }

  const getFeedForFollows = async (
    followedDids: readonly string[],
    input: HypercertsFeedOverrides = {},
  ) => {
    const viewerDid = randomDid()
    await seedActor(viewerDid)
    await Promise.all(followedDids.map((did) => seedFollow(viewerDid, did)))
    return service.getFeedSkeleton(feedRequest(viewerDid, input))
  }

  const seedOrganization = async (
    did: string,
    effectiveAt = '2026-07-19T00:00:00Z',
  ): Promise<string> =>
    seedRecord(
      did,
      'app.certified.actor.organization',
      'self',
      { $type: 'app.certified.actor.organization' },
      effectiveAt,
    )

  const seedExternalLabel = async (
    src: string,
    uri: string,
    val: string,
    options: {
      readonly cid?: string | null
      readonly neg?: boolean
      readonly cts?: string
      readonly exp?: string | null
    } = {},
  ): Promise<void> => {
    const subscriptionUrl = `https://labels.example.test/${src}`
    await admin.query(
      `INSERT INTO label_subscription_state (url, labeler_did)
       VALUES ($1, $2)
       ON CONFLICT (url) DO NOTHING`,
      [subscriptionUrl, src],
    )
    externalLabelSeq += 1
    await admin.query(
      `INSERT INTO external_label (
         subscription_url, seq, label_index, src, uri, cid, val, neg, cts, exp
       )
       VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8, $9)`,
      [
        subscriptionUrl,
        externalLabelSeq,
        src,
        uri,
        options.cid ?? null,
        val,
        options.neg ?? false,
        options.cts ?? '2026-07-20T00:00:00Z',
        options.exp ?? null,
      ],
    )
  }

  it('passes readiness capability checks and rejects writes from the service pool', async () => {
    await expect(database.checkCompatibility()).resolves.toEqual({
      compatible: true,
    })
    const did = randomDid()
    await expect(
      database.query(
        `INSERT INTO record (
           uri, cid, did, collection, json, indexed_at, record_created_at
         )
         VALUES ($1, $2, $3, $4, '{}'::jsonb, NOW(), NOW())`,
        [`at://${did}/org.hypercerts.claim.activity/read-only`, cid, did,
          'org.hypercerts.claim.activity'],
      ),
    ).rejects.toThrow(/read-only/i)
  })

  it('loads metadata and exact source pages from the same statement contract', async () => {
    const viewer = randomDid()
    const author = randomDid()
    const selectedBody = {
      $type: 'org.hypercerts.claim.activity',
      marker: 'selected-source-body',
      createdAt: '2026-07-20T00:00:02Z',
    }
    await Promise.all([seedActor(viewer), seedActor(author)])
    await seedFollow(viewer, author)
    const selectedUri = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'source-page-selected',
      selectedBody,
      '2026-07-20T00:00:02Z',
    )
    await seedRecord(
      author,
      'org.hypercerts.collection',
      'source-page-sentinel',
      {
        $type: 'org.hypercerts.collection',
        marker: 'limit-plus-one-sentinel',
        createdAt: '2026-07-20T00:00:01Z',
      },
      '2026-07-20T00:00:01Z',
      { cid: staleCid },
    )
    const request = feedRequest(viewer, { limit: 1 })

    const metadata = await pages.loadPage(request, 'metadata')
    const withSource = await pages.loadPage(request, 'with-source')

    expect(metadata.rows).toEqual([
      {
        uri: selectedUri,
        cid,
        actorDid: author,
        collection: 'org.hypercerts.claim.activity',
        kind: 'cert.create',
        sortValue: '2026-07-20T00:00:02.000000Z',
      },
    ])
    expect(metadata.rows[0]).not.toHaveProperty('sourceValue')
    expect(withSource.rows).toEqual([
      {
        ...metadata.rows[0],
        sourceValue: selectedBody,
      },
    ])
    expect(withSource.cursor).toBe(metadata.cursor)
    expect(metadata.cursor).toBeDefined()
  })

  it('batches actor and both deterministic profile contexts', async () => {
    const actorWithProfiles = randomDid()
    const actorOnly = randomDid()
    const certifiedOnly = randomDid()
    const blueskyOnly = randomDid()
    const missingIdentity = randomDid()
    const wrongCollection = randomDid()
    const sourceDidMismatch = randomDid()
    const staleCertified = { marker: 'stale-certified-self' }
    const currentCertified = { marker: 'current-certified-self' }
    const blueskyBody = { marker: 'bluesky-self' }
    const certifiedOnlyBody = { marker: 'certified-only' }
    const blueskyOnlyBody = { marker: 'bluesky-only' }
    const certifiedUri =
      `at://${actorWithProfiles}/app.certified.actor.profile/self`

    await seedActor(actorWithProfiles, { handle: 'alice.example' })
    await seedActor(actorOnly)
    await admin.query(
      `INSERT INTO record (
         uri, cid, did, collection, json, indexed_at, record_created_at
       )
       VALUES (
         $1, $2, $3, 'app.certified.actor.profile', $4::jsonb, NOW(), NOW()
       )`,
      [
        certifiedUri,
        cid,
        sourceDidMismatch,
        JSON.stringify(staleCertified),
      ],
    )
    await seedRecord(
      actorWithProfiles,
      'app.bsky.actor.profile',
      'self',
      blueskyBody,
      '2026-07-20T00:00:00Z',
    )
    await seedRecord(
      certifiedOnly,
      'app.certified.actor.profile',
      'self',
      certifiedOnlyBody,
      '2026-07-20T00:00:00Z',
    )
    await seedRecord(
      blueskyOnly,
      'app.bsky.actor.profile',
      'self',
      blueskyOnlyBody,
      '2026-07-20T00:00:00Z',
    )
    await admin.query(
      `INSERT INTO record (
         uri, cid, did, collection, json, indexed_at, record_created_at
       )
       VALUES (
         $1, $2, $3, 'org.hypercerts.collection', $4::jsonb, NOW(), NOW()
       )`,
      [
        `at://${wrongCollection}/app.bsky.actor.profile/self`,
        cid,
        wrongCollection,
        JSON.stringify({ marker: 'wrong-collection' }),
      ],
    )
    await admin.query(
      `UPDATE record
       SET cid = $2, json = $3::jsonb
       WHERE uri = $1`,
      [certifiedUri, staleCid, JSON.stringify(currentCertified)],
    )

    await expect(
      identities.getByDids([
        actorWithProfiles,
        actorOnly,
        certifiedOnly,
        blueskyOnly,
        missingIdentity,
        wrongCollection,
        actorWithProfiles,
      ]),
    ).resolves.toEqual(
      new Map([
        [
          actorWithProfiles,
          {
            did: actorWithProfiles,
            actor: {
              did: actorWithProfiles,
              handle: 'alice.example',
            },
            certifiedProfile: currentCertified,
            blueskyProfile: blueskyBody,
          },
        ],
        [
          actorOnly,
          {
            did: actorOnly,
            actor: {
              did: actorOnly,
              handle: null,
            },
          },
        ],
        [
          certifiedOnly,
          { did: certifiedOnly, certifiedProfile: certifiedOnlyBody },
        ],
        [blueskyOnly, { did: blueskyOnly, blueskyProfile: blueskyOnlyBody }],
        [missingIdentity, { did: missingIdentity }],
        [wrongCollection, { did: wrongCollection }],
      ]),
    )
  })

  it('resolves follows and evaluators, applies quality, and classifies before filtering', async () => {
    const viewer = randomDid()
    const trustedLabeler = randomDid()
    const followedOrg = randomDid()
    const blockedOrg = randomDid()
    const purgedAccount = randomDid()
    const evaluator = randomDid()
    const endorsedPersonWithoutActor = randomDid()
    const awardSubject = randomDid()
    const malformedAccount = `invalid-${randomBytes(8).toString('hex')}`

    await Promise.all([
      seedActor(viewer),
      seedActor(followedOrg),
      seedActor(blockedOrg),
      seedActor(evaluator),
      seedActor(awardSubject),
      seedOrganization(followedOrg),
      seedOrganization(blockedOrg),
    ])

    for (const [index, subject] of [
      followedOrg,
      blockedOrg,
      purgedAccount,
    ].entries()) {
      await seedRecord(
        viewer,
        'app.certified.graph.follow',
        `follow-${index}`,
        { subject },
        `2026-07-20T00:00:0${index}Z`,
      )
    }

    await seedExternalLabel(trustedLabeler, followedOrg, 'high-quality')
    await seedExternalLabel(trustedLabeler, blockedOrg, 'likely-test')
    await seedExternalLabel(randomDid(), blockedOrg, 'high-quality', {
      cts: '2026-07-20T00:00:01Z',
    })
    await seedExternalLabel(
      trustedLabeler,
      `at://${blockedOrg}/app.certified.actor.organization/self`,
      'high-quality',
      { cts: '2026-07-20T00:00:02Z' },
    )
    await seedExternalLabel(trustedLabeler, blockedOrg, 'high-quality', {
      cid,
      cts: '2026-07-20T00:00:03Z',
    })

    const definitionUri = await seedRecord(
      evaluator,
      'app.certified.badge.definition',
      'endorsement-definition',
      { badgeType: 'endorsement' },
      '2026-07-20T01:00:00Z',
    )
    await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'scope-award',
      {
        badge: { uri: definitionUri, cid },
        subject: {
          $type: 'app.certified.defs#did',
          did: endorsedPersonWithoutActor,
        },
      },
      '2026-07-20T01:00:01Z',
    )
    await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'malformed-scope-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: malformedAccount },
      },
      '2026-07-20T01:00:02Z',
    )
    await seedRecord(
      malformedAccount,
      'org.hypercerts.claim.activity',
      'must-not-enter-scope',
      { createdAt: '2026-07-21T14:00:00Z' },
      '2026-07-21T14:00:00Z',
    )

    const activityUri = await seedRecord(
      followedOrg,
      'org.hypercerts.claim.activity',
      'paired-activity',
      { createdAt: '2026-07-21T10:00:00Z' },
      '2026-07-21T10:00:00Z',
    )
    const collectionUri = await seedRecord(
      followedOrg,
      'org.hypercerts.collection',
      'project',
      {
        createdAt: '2026-07-21T10:00:10Z',
        items: [{ itemIdentifier: { uri: activityUri, cid } }],
      },
      '2026-07-21T10:00:10Z',
    )
    await seedRecord(
      followedOrg,
      'org.hypercerts.context.evaluation',
      'evaluation',
      { createdAt: '2026-07-21T11:00:00+00:00' },
      '2026-07-21T11:00:00Z',
      { indexedAt: '2026-07-21T09:00:00Z' },
    )
    await seedRecord(
      followedOrg,
      'org.hypercerts.context.attachment',
      'update',
      { contentType: 'update', createdAt: '2026-07-21T09:00:00Z' },
      '2026-07-21T09:00:00Z',
    )
    await seedRecord(
      followedOrg,
      'org.hypercerts.context.attachment',
      'audit',
      { contentType: 'audit', createdAt: '2026-07-21T08:30:00Z' },
      '2026-07-21T08:30:00Z',
    )
    const boardUri = await seedRecord(
      followedOrg,
      'org.hyperboards.board',
      'board',
      { createdAt: { malformed: true } },
      '2026-07-21T08:00:00Z',
      { recordCreatedAt: null },
    )
    const dateOnlyUri = await seedRecord(
      followedOrg,
      'org.hypercerts.context.measurement',
      'date-only-created-at',
      { createdAt: '2026-07-22' },
      '2026-07-21T07:30:00Z',
      { recordCreatedAt: null },
    )
    await seedRecord(
      blockedOrg,
      'org.hypercerts.claim.activity',
      'blocked',
      { createdAt: '2026-07-21T12:00:00Z' },
      '2026-07-21T12:00:00Z',
    )
    const endorsedUri = await seedRecord(
      endorsedPersonWithoutActor,
      'org.hypercerts.claim.activity',
      'endorsed',
      { createdAt: '2026-07-21T07:00:00Z' },
      '2026-07-21T07:00:00Z',
    )

    const feedDefinitionUri = await seedRecord(
      followedOrg,
      'app.certified.badge.definition',
      'feed-endorsement-definition',
      { badgeType: 'endorsement' },
      '2026-07-20T02:00:00Z',
    )
    const visibleAwardUri = await seedRecord(
      followedOrg,
      'app.certified.badge.award',
      'visible-award',
      {
        badge: { uri: feedDefinitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: awardSubject },
        createdAt: '2026-07-21T06:00:00Z',
      },
      '2026-07-21T06:00:00Z',
    )
    await seedRecord(
      followedOrg,
      'app.certified.badge.award',
      'malformed-subject-award',
      {
        badge: { uri: feedDefinitionUri, cid },
        subject: {
          $type: 'app.certified.defs#did',
          did: malformedAccount,
        },
        createdAt: '2026-07-21T05:30:00Z',
      },
      '2026-07-21T05:30:00Z',
    )
    await seedRecord(
      followedOrg,
      'app.certified.badge.award',
      'self-endorsement-award',
      {
        badge: { uri: feedDefinitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: followedOrg },
        createdAt: '2026-07-21T05:15:00Z',
      },
      '2026-07-21T05:15:00Z',
    )
    const rejectedAwardUri = await seedRecord(
      followedOrg,
      'app.certified.badge.award',
      'rejected-award',
      {
        badge: { uri: feedDefinitionUri, cid },
        subject: {
          $type: 'app.certified.defs#did',
          did: endorsedPersonWithoutActor,
        },
        createdAt: '2026-07-21T05:00:00Z',
      },
      '2026-07-21T05:00:00Z',
    )
    await seedRecord(
      endorsedPersonWithoutActor,
      'app.certified.badge.response',
      'rejection',
      { badgeAward: { uri: rejectedAwardUri, cid }, response: 'rejected' },
      '2026-07-21T05:01:00Z',
    )

    pages = createPages([trustedLabeler])
    service = new FeedService(pages)
    const request = feedRequest(viewer, {
      trustedEvaluators: [evaluator],
      organizationQuality: {
        allowed: ['high-quality'],
        includeUnrated: false,
      },
      limit: 50,
    })
    const output = await service.getFeedSkeleton(request)
    const metadata = await pages.loadPage(request, 'metadata')

    expect(metadata.rows.map((item) => item.kind)).toEqual([
      'evaluation.create',
      'project.created_with_cert',
      'update.create',
      'hyperboard.create',
      'measurement.create',
      'cert.create',
      'endorsement.award',
    ])
    expect(output.feed.map((item) => item.subject)).toEqual([
      expect.stringContaining('/org.hypercerts.context.evaluation/'),
      collectionUri,
      expect.stringContaining('/org.hypercerts.context.attachment/update'),
      boardUri,
      dateOnlyUri,
      endorsedUri,
      visibleAwardUri,
    ])
    expect(output.feed.some((item) => item.subject === activityUri)).toBe(false)
    expect(metadata.rows[0]?.sortValue).toBe('2026-07-21T11:00:00.000000Z')
    expect(
      metadata.rows.find((item) => item.uri === boardUri)?.sortValue,
    ).toBe('2026-07-21T08:00:00.000000Z')
    expect(
      metadata.rows.find((item) => item.uri === dateOnlyUri)?.sortValue,
    ).toBe('2026-07-21T07:30:00.000000Z')

    const projectOnly = await getFeedForFollows([followedOrg], {
      organizationQuality: {
        allowed: ['high-quality'],
        includeUnrated: false,
      },
      kinds: ['project.created_with_cert'],
    })
    expect(projectOnly.feed).toHaveLength(1)
    expect(projectOnly.feed[0]?.subject).toBe(collectionUri)

    await seedExternalLabel(trustedLabeler, blockedOrg, 'likely-test', {
      neg: true,
      cts: '2026-07-20T00:00:00Z',
      exp: '2000-01-01T00:00:00Z',
    })
    const expiredNegation = await getFeedForFollows([blockedOrg], {
      organizationQuality: { allowed: ['high-quality'], includeUnrated: true },
    })
    expect(expiredNegation.feed).toEqual([])

    const activelyNegatedOrg = randomDid()
    await Promise.all([
      seedActor(activelyNegatedOrg),
      seedOrganization(activelyNegatedOrg),
    ])
    const activeNegationUri = await seedRecord(
      activelyNegatedOrg,
      'org.hypercerts.claim.activity',
      'active-negation',
      { createdAt: '2026-07-21T04:00:00Z' },
      '2026-07-21T04:00:00Z',
    )
    await seedExternalLabel(trustedLabeler, activelyNegatedOrg, 'likely-test')
    await seedExternalLabel(trustedLabeler, activelyNegatedOrg, 'likely-test', {
      neg: true,
      cts: '2026-07-20T00:00:01Z',
    })
    const activeNegation = await getFeedForFollows([activelyNegatedOrg], {
      organizationQuality: { allowed: ['high-quality'], includeUnrated: true },
    })
    expect(activeNegation.feed).toEqual([{ subject: activeNegationUri }])
  })

  it('detects organizations only through the exact organization self record', async () => {
    const viewer = randomDid()
    const personWithNearMatch = randomDid()
    const organization = randomDid()
    await Promise.all([
      seedActor(viewer),
      seedRecord(
        personWithNearMatch,
        'app.certified.actor.organization',
        'profile',
        { $type: 'app.certified.actor.organization' },
        '2026-07-21T00:00:00Z',
      ),
      seedOrganization(organization, '2026-07-21T00:00:01Z'),
    ])
    const personActivity = await seedRecord(
      personWithNearMatch,
      'org.hypercerts.claim.activity',
      'person-activity',
      { createdAt: '2026-07-21T01:00:00Z' },
      '2026-07-21T01:00:00Z',
    )
    await seedRecord(
      organization,
      'org.hypercerts.claim.activity',
      'organization-activity',
      { createdAt: '2026-07-21T02:00:00Z' },
      '2026-07-21T02:00:00Z',
    )

    const output = await getFeedForFollows(
      [personWithNearMatch, organization],
      {
        organizationQuality: {
        allowed: ['high-quality'],
          includeUnrated: false,
        },
      },
    )

    expect(output.feed.map((item) => item.subject)).toEqual([
      personActivity,
    ])
  })

  it('ignores malformed external-label timestamps without asserting or negating quality', async () => {
    const viewer = randomDid()
    const trustedLabeler = randomDid()
    const malformedCtsAssertion = randomDid()
    const malformedExpAssertion = randomDid()
    const malformedCtsNegation = randomDid()
    const malformedExpNegation = randomDid()
    const unlabeled = randomDid()
    const organizations = [
      malformedCtsAssertion,
      malformedExpAssertion,
      malformedCtsNegation,
      malformedExpNegation,
      unlabeled,
    ]

    await Promise.all([
      seedActor(viewer),
      ...organizations.map((did, index) =>
        seedOrganization(did, `2026-07-21T00:00:0${index}Z`),
      ),
      ...organizations.map((did, index) =>
        seedRecord(
          did,
          'org.hypercerts.claim.activity',
          'quality-timestamp',
          { createdAt: `2026-07-21T01:00:0${index}Z` },
          `2026-07-21T01:00:0${index}Z`,
        ),
      ),
    ])
    await seedExternalLabel(
      trustedLabeler,
      malformedCtsAssertion,
      'high-quality',
      { cts: 'not-a-timestamp' },
    )
    await seedExternalLabel(
      trustedLabeler,
      malformedExpAssertion,
      'high-quality',
      { exp: 'not-a-timestamp' },
    )
    await seedExternalLabel(
      trustedLabeler,
      malformedCtsNegation,
      'likely-test',
    )
    await seedExternalLabel(
      trustedLabeler,
      malformedCtsNegation,
      'likely-test',
      { neg: true, cts: 'not-a-timestamp' },
    )
    await seedExternalLabel(
      trustedLabeler,
      malformedExpNegation,
      'likely-test',
    )
    await seedExternalLabel(
      trustedLabeler,
      malformedExpNegation,
      'likely-test',
      {
        neg: true,
        cts: '2026-07-20T00:00:01Z',
        exp: 'not-a-timestamp',
      },
    )

    pages = createPages([trustedLabeler])
    service = new FeedService(pages)
    const assertions = await getFeedForFollows(
      [malformedCtsAssertion, malformedExpAssertion],
      {
        organizationQuality: {
          allowed: ['high-quality'],
          includeUnrated: false,
        },
      },
    )
    expect(assertions.feed).toEqual([])

    const negations = await getFeedForFollows(
      [malformedCtsNegation, malformedExpNegation, unlabeled],
      {
        organizationQuality: {
        allowed: ['high-quality'],
          includeUnrated: true,
        },
      },
    )
    expect(negations.feed).toEqual([
      {
        subject: `at://${unlabeled}/org.hypercerts.claim.activity/quality-timestamp`,
      },
    ])
  })

  it('expires positive labels and lets equal-time negations cancel assertions', async () => {
    const viewer = randomDid()
    const trustedLabeler = randomDid()
    const expiredAssertionOrg = randomDid()
    const equalNegationOrg = randomDid()
    await Promise.all([
      seedActor(viewer),
      seedOrganization(expiredAssertionOrg),
      seedOrganization(equalNegationOrg),
      seedRecord(
        expiredAssertionOrg,
        'org.hypercerts.claim.activity',
        'expired-assertion',
        { createdAt: '2026-07-21T03:00:00Z' },
        '2026-07-21T03:00:00Z',
      ),
      seedRecord(
        equalNegationOrg,
        'org.hypercerts.claim.activity',
        'equal-negation',
        { createdAt: '2026-07-21T04:00:00Z' },
        '2026-07-21T04:00:00Z',
      ),
    ])
    await seedExternalLabel(
      trustedLabeler,
      expiredAssertionOrg,
      'high-quality',
      { exp: '2000-01-01T00:00:00Z' },
    )
    const equalCts = '2026-07-20T00:00:00Z'
    await seedExternalLabel(
      trustedLabeler,
      equalNegationOrg,
      'likely-test',
      { cts: equalCts },
    )
    await seedExternalLabel(
      trustedLabeler,
      equalNegationOrg,
      'likely-test',
      { neg: true, cts: equalCts },
    )

    pages = createPages([trustedLabeler])
    service = new FeedService(pages)
    const expired = await getFeedForFollows([expiredAssertionOrg], {
      organizationQuality: {
        allowed: ['high-quality'],
        includeUnrated: false,
      },
    })
    expect(expired.feed).toEqual([])

    const equalNegation = await getFeedForFollows([equalNegationOrg], {
      organizationQuality: {
        allowed: ['high-quality'],
        includeUnrated: true,
      },
    })
    expect(equalNegation.feed).toEqual([
      {
        subject: `at://${equalNegationOrg}/org.hypercerts.claim.activity/equal-negation`,
      },
    ])
  })

  it('orders by record_created_at and falls back to indexed_at', async () => {
    const viewer = randomDid()
    const author = randomDid()
    await seedActor(viewer)
    const materialized = await seedRecord(
      author,
      'org.hypercerts.context.measurement',
      'materialized-time',
      { createdAt: '2000-01-01T00:00:00Z' },
      '2026-07-21T12:00:00Z',
      { indexedAt: '2026-07-21T01:00:00Z' },
    )
    const fallback = await seedRecord(
      author,
      'org.hypercerts.context.measurement',
      'indexed-fallback',
      { createdAt: '2099-01-01T00:00:00Z' },
      '2026-07-21T11:00:00Z',
      { recordCreatedAt: null },
    )

    const output = await getFeedForFollows([author])

    expect(output.feed.map((item) => item.subject)).toEqual([
      materialized,
      fallback,
    ])
  })

  it('pairs projects by effective timestamps, including indexed_at fallback', async () => {
    const viewer = randomDid()
    const author = randomDid()
    await seedActor(viewer)

    const materializedActivity = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'materialized-pair-activity',
      { createdAt: '2026-07-21T10:00:30Z' },
      '2026-07-21T10:00:30Z',
      { indexedAt: '2026-07-21T04:00:00Z' },
    )
    const materializedCollection = await seedRecord(
      author,
      'org.hypercerts.collection',
      'materialized-pair-collection',
      {
        createdAt: '2026-07-21T10:00:00Z',
        items: [{ itemIdentifier: { uri: materializedActivity, cid } }],
      },
      '2026-07-21T10:00:00Z',
      { indexedAt: '2026-07-21T01:00:00Z' },
    )
    const fallbackActivity = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'fallback-pair-activity',
      { createdAt: { malformed: true } },
      '2026-07-21T11:00:30Z',
      { recordCreatedAt: null },
    )
    const fallbackCollection = await seedRecord(
      author,
      'org.hypercerts.collection',
      'fallback-pair-collection',
      {
        items: [{ itemIdentifier: { uri: fallbackActivity, cid } }],
      },
      '2026-07-21T11:00:00Z',
      { recordCreatedAt: null },
    )

    await seedFollow(viewer, author)
    const request = feedRequest(viewer, { limit: 50 })
    const output = await service.getFeedSkeleton(request)
    const metadata = await pages.loadPage(request, 'metadata')

    expect(output.feed.map((item) => item.subject)).toEqual([
      fallbackCollection,
      materializedCollection,
    ])
    expect(metadata.rows.map((item) => item.kind)).toEqual([
      'project.created_with_cert',
      'project.created_with_cert',
    ])
  })

  it('uses the latest subject response when deciding whether an endorsement is active', async () => {
    const viewer = randomDid()
    const evaluator = randomDid()
    const subject = randomDid()
    await Promise.all([
      seedActor(viewer),
      seedActor(evaluator),
      seedActor(subject),
    ])

    const definitionUri = await seedRecord(
      evaluator,
      'app.certified.badge.definition',
      'latest-response-definition',
      { badgeType: 'endorsement' },
      '2026-07-21T01:00:00Z',
    )
    const awardUri = await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'latest-response-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: subject },
        createdAt: '2026-07-21T02:00:00Z',
      },
      '2026-07-21T02:00:00Z',
    )
    const subjectActivity = await seedRecord(
      subject,
      'org.hypercerts.claim.activity',
      'active-after-acceptance',
      { createdAt: '2026-07-21T03:00:00Z' },
      '2026-07-21T03:00:00Z',
    )
    await seedRecord(
      subject,
      'app.certified.badge.response',
      'older-rejection',
      {
        badgeAward: { uri: awardUri, cid },
        response: 'rejected',
        createdAt: '2026-07-21T04:00:00Z',
      },
      '2026-07-21T04:00:00Z',
      { indexedAt: '2026-07-21T06:00:00Z' },
    )
    await seedRecord(
      subject,
      'app.certified.badge.response',
      'newer-acceptance',
      {
        badgeAward: { uri: awardUri, cid },
        response: 'accepted',
        createdAt: '2026-07-21T05:00:00Z',
      },
      '2026-07-21T05:00:00Z',
      { indexedAt: '2026-07-21T03:30:00Z' },
    )

    const output = await getFeedForFollows([evaluator], {
      trustedEvaluators: [evaluator],
      limit: 50,
    })

    expect(output.feed.map((item) => item.subject)).toEqual([
      subjectActivity,
      awardUri,
    ])
  })

  it('enforces allowed issuers for evaluator scope and award events', async () => {
    const viewer = randomDid()
    const disallowedIssuer = randomDid()
    const allowedIssuer = randomDid()
    const disallowedSubject = randomDid()
    await Promise.all([
      seedActor(viewer),
      seedActor(disallowedIssuer),
      seedActor(allowedIssuer),
      seedActor(disallowedSubject),
    ])

    const definitionUri = await seedRecord(
      disallowedIssuer,
      'app.certified.badge.definition',
      'restricted-definition',
      { badgeType: 'endorsement', allowedIssuers: [allowedIssuer] },
      '2026-07-21T01:00:00Z',
    )
    const disallowedAwardUri = await seedRecord(
      disallowedIssuer,
      'app.certified.badge.award',
      'disallowed-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: disallowedSubject },
      },
      '2026-07-21T02:00:00Z',
    )
    const disallowedSubjectActivity = await seedRecord(
      disallowedSubject,
      'org.hypercerts.claim.activity',
      'must-not-expand',
      { createdAt: '2026-07-21T03:00:00Z' },
      '2026-07-21T03:00:00Z',
    )

    await expect(
      service.getFeedSkeleton(
        feedRequest(viewer, { trustedEvaluators: [disallowedIssuer] }),
      ),
    ).resolves.toEqual({ feed: [] })
    await expect(
      getFeedForFollows([disallowedIssuer]),
    ).resolves.toEqual({ feed: [] })

    const allowedAwardUri = await seedRecord(
      allowedIssuer,
      'app.certified.badge.award',
      'allowed-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: disallowedSubject },
      },
      '2026-07-21T04:00:00Z',
    )
    const malformedDefinitionUri = await seedRecord(
      allowedIssuer,
      'app.certified.badge.definition',
      'malformed-allowed-issuers-definition',
      { badgeType: 'endorsement', allowedIssuers: { did: allowedIssuer } },
      '2026-07-21T04:00:01Z',
    )
    const malformedAwardUri = await seedRecord(
      allowedIssuer,
      'app.certified.badge.award',
      'malformed-allowed-issuers-award',
      {
        badge: { uri: malformedDefinitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: disallowedSubject },
      },
      '2026-07-21T04:00:02Z',
    )
    const allowedOutput = await getFeedForFollows([allowedIssuer])

    expect(allowedOutput.feed.map((item) => item.subject)).toEqual([
      allowedAwardUri,
    ])
    expect(allowedOutput.feed.some((item) => item.subject === disallowedAwardUri)).toBe(
      false,
    )
    expect(allowedOutput.feed.some((item) => item.subject === malformedAwardUri)).toBe(
      false,
    )
    expect(
      allowedOutput.feed.some(
        (item) => item.subject === disallowedSubjectActivity,
      ),
    ).toBe(false)
  })

  it('does not turn record-target endorsements into account endorsements', async () => {
    const viewer = randomDid()
    const evaluator = randomDid()
    const recordOwner = randomDid()
    await Promise.all([
      seedActor(viewer),
      seedActor(evaluator),
      seedActor(recordOwner),
    ])

    const targetActivity = await seedRecord(
      recordOwner,
      'org.hypercerts.claim.activity',
      'record-target',
      { createdAt: '2026-07-21T03:00:00Z' },
      '2026-07-21T03:00:00Z',
    )
    const definitionUri = await seedRecord(
      evaluator,
      'app.certified.badge.definition',
      'record-target-definition',
      { badgeType: 'endorsement' },
      '2026-07-21T01:00:00Z',
    )
    await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'record-target-award',
      {
        badge: { uri: definitionUri, cid },
        subject: {
          $type: 'com.atproto.repo.strongRef',
          uri: targetActivity,
          cid,
        },
        createdAt: '2026-07-21T02:00:00Z',
      },
      '2026-07-21T02:00:00Z',
    )
    await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'wrong-subject-type-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'example.invalid#did', did: recordOwner },
        createdAt: '2026-07-21T02:30:00Z',
      },
      '2026-07-21T02:30:00Z',
    )

    await expect(
      service.getFeedSkeleton(
        feedRequest(viewer, { trustedEvaluators: [evaluator] }),
      ),
    ).resolves.toEqual({ feed: [] })

    await expect(
      getFeedForFollows([evaluator]),
    ).resolves.toEqual({ feed: [] })
  })

  it('requires exact CIDs when pairing projects and resolving badge definitions', async () => {
    const viewer = randomDid()
    const author = randomDid()
    const endorsementSubject = randomDid()
    await Promise.all([
      seedActor(viewer),
      seedActor(author),
      seedActor(endorsementSubject),
    ])

    const activityUri = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'current-activity-version',
      { createdAt: '2026-07-21T10:00:00Z' },
      '2026-07-21T10:00:00Z',
    )
    const collectionUri = await seedRecord(
      author,
      'org.hypercerts.collection',
      'stale-activity-reference',
      {
        createdAt: '2026-07-21T10:00:10Z',
        items: [{ itemIdentifier: { uri: activityUri, cid: staleCid } }],
      },
      '2026-07-21T10:00:10Z',
    )
    const definitionUri = await seedRecord(
      author,
      'app.certified.badge.definition',
      'current-definition-version',
      { badgeType: 'endorsement' },
      '2026-07-21T09:00:00Z',
    )
    const awardUri = await seedRecord(
      author,
      'app.certified.badge.award',
      'stale-definition-reference',
      {
        badge: { uri: definitionUri, cid: staleCid },
        subject: {
          $type: 'app.certified.defs#did',
          did: endorsementSubject,
        },
        createdAt: '2026-07-21T09:30:00Z',
      },
      '2026-07-21T09:30:00Z',
    )
    const subjectActivity = await seedRecord(
      endorsementSubject,
      'org.hypercerts.claim.activity',
      'must-not-enter-through-stale-definition',
      { createdAt: '2026-07-21T11:00:00Z' },
      '2026-07-21T11:00:00Z',
    )

    await seedFollow(viewer, author)
    const request = feedRequest(viewer, {
      trustedEvaluators: [author],
      limit: 50,
    })
    const output = await service.getFeedSkeleton(request)
    const metadata = await pages.loadPage(request, 'metadata')

    expect(output.feed.map((item) => item.subject)).toEqual([
      collectionUri,
      activityUri,
    ])
    expect(metadata.rows.map((item) => item.kind)).toEqual([
      'collection.create',
      'cert.create',
    ])
    expect(output.feed.some((item) => item.subject === awardUri)).toBe(false)
    expect(
      output.feed.some((item) => item.subject === subjectActivity),
    ).toBe(false)
  })

  it('suppresses a paired activity across a pagination boundary', async () => {
    const viewer = randomDid()
    const author = randomDid()
    await Promise.all([seedActor(viewer), seedActor(author)])

    const pairedActivity = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'paired',
      { createdAt: '2026-07-21T10:00:02Z' },
      '2026-07-21T10:00:02Z',
    )
    const collection = await seedRecord(
      author,
      'org.hypercerts.collection',
      'project',
      {
        createdAt: '2026-07-21T10:00:04Z',
        items: [{ itemIdentifier: { uri: pairedActivity, cid } }],
      },
      '2026-07-21T10:00:04Z',
    )
    const standalone = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'standalone',
      { createdAt: '2026-07-21T10:00:03Z' },
      '2026-07-21T10:00:03Z',
    )
    const old = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'old',
      { createdAt: '2026-07-21T09:00:00Z' },
      '2026-07-21T09:00:00Z',
    )

    await seedFollow(viewer, author)
    const request = feedRequest(viewer, { limit: 2 })
    const first = await service.getFeedSkeleton(request)
    const metadata = await pages.loadPage(request, 'metadata')
    expect(first.feed.map((item) => item.subject)).toEqual([
      collection,
      standalone,
    ])
    expect(metadata.rows[0]?.kind).toBe('project.created_with_cert')

    const second = await service.getFeedSkeleton(
      feedRequest(viewer, { limit: 2, cursor: first.cursor! }),
    )
    expect(second.feed.map((item) => item.subject)).toEqual([old])
  })

  it('paginates equal timestamps by descending URI without repeats', async () => {
    const viewer = randomDid()
    const author = randomDid()
    await Promise.all([seedActor(viewer), seedActor(author)])

    const uris: string[] = []
    for (const rkey of ['a', 'b', 'c']) {
      uris.push(
        await seedRecord(
          author,
          'org.hypercerts.context.measurement',
          rkey,
          { createdAt: '2026-07-21T12:00:00Z' },
          '2026-07-21T12:00:00Z',
        ),
      )
    }

    await seedFollow(viewer, author)
    const first = await service.getFeedSkeleton(
      feedRequest(viewer, { limit: 2 }),
    )
    expect(first.feed.map((item) => item.subject)).toEqual([
      uris[2],
      uris[1],
    ])
    expect(first.cursor).toBeDefined()

    const second = await service.getFeedSkeleton(
      feedRequest(viewer, { limit: 2, cursor: first.cursor! }),
    )
    expect(second.feed.map((item) => item.subject)).toEqual([uris[0]])
    expect(second.cursor).toBeUndefined()
  })

  it('ignores malformed follow subjects before they can enter the feed', async () => {
    const viewer = randomDid()
    const malformedDid = `invalid-${randomBytes(8).toString('hex')}`
    await seedActor(viewer)
    await seedRecord(
      viewer,
      'app.certified.graph.follow',
      'malformed-follow',
      { subject: malformedDid },
      '2026-07-22T01:00:00Z',
    )
    await seedRecord(
      malformedDid,
      'org.hypercerts.claim.activity',
      'must-not-break-feed',
      { createdAt: '2026-07-22T02:00:00Z' },
      '2026-07-22T02:00:00Z',
    )

    await expect(
      service.getFeedSkeleton(feedRequest(viewer)),
    ).resolves.toEqual({ feed: [] })
  })

  it('ignores responses that target a stale award CID', async () => {
    const viewer = randomDid()
    const evaluator = randomDid()
    const subject = randomDid()
    await Promise.all([
      seedActor(viewer),
      seedActor(evaluator),
      seedActor(subject),
    ])

    const definitionUri = await seedRecord(
      evaluator,
      'app.certified.badge.definition',
      'stale-response-definition',
      { badgeType: 'endorsement' },
      '2026-07-22T03:00:00Z',
    )
    const awardUri = await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'stale-response-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: subject },
      },
      '2026-07-22T04:00:00Z',
    )
    const subjectActivity = await seedRecord(
      subject,
      'org.hypercerts.claim.activity',
      'stale-response-subject',
      { createdAt: '2026-07-22T05:00:00Z' },
      '2026-07-22T05:00:00Z',
    )
    await seedRecord(
      subject,
      'app.certified.badge.response',
      'stale-response-rejection',
      {
        badgeAward: { uri: awardUri, cid: staleCid },
        response: 'rejected',
      },
      '2026-07-22T06:00:00Z',
    )

    const authorOutput = await getFeedForFollows([evaluator])
    expect(authorOutput.feed).toEqual([{ subject: awardUri }])

    const evaluatorOutput = await service.getFeedSkeleton(
      feedRequest(viewer, { trustedEvaluators: [evaluator] }),
    )
    expect(evaluatorOutput.feed).toEqual([{ subject: subjectActivity }])
  })

  it('always derives the base scope from the viewer current follows', async () => {
    const viewer = randomDid()
    const followedAuthor = randomDid()
    const unfollowedAuthor = randomDid()
    await seedActor(viewer)
    const followedUri = await seedRecord(
      followedAuthor,
      'org.hypercerts.claim.activity',
      'followed-author',
      { createdAt: '2026-07-22T07:00:00Z' },
      '2026-07-22T07:00:00Z',
    )
    const unfollowedUri = await seedRecord(
      unfollowedAuthor,
      'org.hypercerts.claim.activity',
      'unfollowed-author',
      { createdAt: '2026-07-22T08:00:00Z' },
      '2026-07-22T08:00:00Z',
    )
    await seedFollow(viewer, followedAuthor)

    const output = await service.getFeedSkeleton(feedRequest(viewer))

    expect(output.feed.map((item) => item.subject)).toEqual([
      followedUri,
    ])
    expect(output.feed.some((item) => item.subject === unfollowedUri)).toBe(
      false,
    )
  })

  it('supports more than 500 followed accounts without truncating the scope', async () => {
    const viewer = randomDid()
    const followedDids = Array.from({ length: 501 }, randomDid)
    const selectedAuthor = followedDids.at(-1)!
    await seedActor(viewer)
    await admin.query(
      `INSERT INTO record (
         uri, cid, did, collection, json, indexed_at, record_created_at
       )
       SELECT
         'at://' || $1::text || '/app.certified.graph.follow/scope-' ||
           followed.ordinality::text,
         $2::text,
         $1::text,
         'app.certified.graph.follow',
         jsonb_build_object('subject', followed.did),
         '2026-07-22T10:00:00Z'::timestamptz +
           followed.ordinality * INTERVAL '1 millisecond',
         '2026-07-22T10:00:00Z'::timestamptz +
           followed.ordinality * INTERVAL '1 millisecond'
       FROM unnest($3::text[]) WITH ORDINALITY AS followed(did, ordinality)`,
      [viewer, cid, followedDids],
    )
    const selectedUri = await seedRecord(
      selectedAuthor,
      'org.hypercerts.claim.activity',
      'large-follow-scope',
      { createdAt: '2026-07-22T11:00:00Z' },
      '2026-07-22T11:00:00Z',
    )

    const output = await service.getFeedSkeleton(feedRequest(viewer))

    expect(output.feed.map((item) => item.subject)).toEqual([selectedUri])
  })
})
