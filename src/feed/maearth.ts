import { readFileSync } from 'node:fs'

import { l } from '@atproto/lex'
import { isDatetimeString, isValidDid, parseAtUriString } from '@atproto/syntax'
import type { QueryResultRow } from 'pg'

import { timestampUriCursor } from './cursor.js'
import { FeedError, FeedErrorCode } from './errors.js'
import {
  MAEARTH_FEED_ID,
  MAEARTH_FEED_PARAMS_TYPE,
  MAEARTH_KINDS,
  isMaearthKind,
  type MaearthFeedParams,
  type MaearthKind,
} from './maearth-types.js'
import type { FeedPageLoader, RegisteredFeed } from './registry.js'
import { defineSqlFeed, type SqlFeedRuntime } from './sql-feed.js'
import type { GetFeedSkeletonInput } from './types.js'
import type {
  GetHydratedFeedOutput,
  ItemSubject,
  ItemView,
} from '../hydration/types.js'
import {
  itemView,
  maearthFeedParams,
} from '../lexicons/org/hypercerts/feed/defs.js'

const sql = readFileSync(
  new URL('./maearth-query.sql', import.meta.url),
  'utf8',
)

interface MaearthQueryRow extends QueryResultRow {
  readonly uri: string
  readonly cid: string
  readonly collection: string
  readonly actor_did: string
  readonly kind: string
  readonly sort_value: string
  /** The record's own createdAt text when it parsed as a timestamp, else null. */
  readonly record_created_at: string | null
  readonly reposted_post_uri: string | null
  /** The repost record's own subject.cid text, bounded by the query; null on other kinds. */
  readonly reposted_post_cid: string | null
  readonly followed_project_uri: string | null
  readonly followed_did: string | null
  /** Null on follow items, and on every row of a skeleton (counts are not computed). */
  readonly like_count: number | null
  readonly repost_count: number | null
  readonly reply_count: number | null
}

type RowCounts = Pick<ItemView, 'likeCount' | 'repostCount' | 'replyCount'>

const POST_COLLECTION = 'org.hypercerts.context.attachment'
const PROJECT_COLLECTION = 'org.hypercerts.collection'

/** A strictly valid record AT-URI, the same check the generated parser applies. */
const isRecordUri = (value: unknown, collection: string): value is string => {
  const parsed = parseAtUriString(value)
  return (
    parsed.success &&
    parsed.value.collection === collection &&
    parsed.value.rkey !== undefined &&
    parsed.value.query === undefined &&
    parsed.value.hash === undefined
  )
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * An update and a repost carry all three counts, follows none. A violation is a
 * SQL projection bug, so it fails the request like a mismatched subject does.
 * Where the counts land is decided by `buildItem`: on an update item, and on a
 * repost's subject.
 */
const rowCounts = (kind: MaearthKind, row: MaearthQueryRow): RowCounts => {
  const { like_count: like, repost_count: repost, reply_count: reply } = row
  if (
    (kind === 'update' || kind === 'repost') &&
    isCount(like) &&
    isCount(repost) &&
    isCount(reply)
  )
    return { likeCount: like, repostCount: repost, replyCount: reply }
  if (
    (kind === 'project-follow' || kind === 'account-follow') &&
    like === null &&
    repost === null &&
    reply === null
  )
    return {}
  throw new Error(
    'MaEarth query row has counts that do not match its kind: update and repost need non-negative integer like_count, repost_count and reply_count, follows need none; correct the SQL projection before serving requests.',
  )
}

/**
 * What the item's record points at, mirroring that record's own `subject`: a
 * repost the original post (with the post's counts and the CID the repost
 * names, when it is a valid CID), a project follow the project (a record
 * subject has no CID), an account follow the account, an update nothing. Each
 * kind carries exactly its own subject columns and no other kind's. A
 * violation is a SQL projection bug, so it fails the request instead of
 * emitting an item the client cannot trust.
 */
const rowSubject = (
  kind: MaearthKind,
  row: MaearthQueryRow,
  counts: RowCounts,
): ItemSubject | undefined => {
  const {
    reposted_post_uri: repost,
    reposted_post_cid: repostCid,
    followed_project_uri: project,
    followed_did: did,
  } = row
  if (
    kind === 'repost' &&
    isRecordUri(repost, POST_COLLECTION) &&
    (repostCid === null || typeof repostCid === 'string') &&
    project === null &&
    did === null
  )
    // The repost record's author controls this text, so a value that is not a
    // CID is omitted (recordView.cid is optional) rather than failing the page.
    return {
      $type: 'org.hypercerts.feed.defs#recordView',
      uri: repost,
      ...(repostCid !== null && l.isCidString(repostCid)
        ? { cid: repostCid }
        : {}),
      ...counts,
    }
  if (
    kind === 'project-follow' &&
    repost === null &&
    repostCid === null &&
    isRecordUri(project, PROJECT_COLLECTION) &&
    did === null
  )
    return { $type: 'org.hypercerts.feed.defs#recordView', uri: project }
  if (
    kind === 'account-follow' &&
    repost === null &&
    repostCid === null &&
    project === null &&
    isValidDid(did)
  )
    return { $type: 'org.hypercerts.feed.defs#actorView', did }
  if (
    kind === 'update' &&
    repost === null &&
    repostCid === null &&
    project === null &&
    did === null
  )
    return undefined
  throw new Error(
    "MaEarth query row has a subject that does not match its kind: repost needs a valid reposted_post_uri (and a text or null reposted_post_cid), project-follow a valid followed_project_uri, account-follow a valid followed_did, update none, and no kind may carry another kind's subject; correct the SQL projection before serving requests.",
  )
}

/**
 * The record's own `createdAt`, unchanged, when it is a valid atproto datetime.
 * The SQL already requires a real timestamp of at most 64 characters, but the
 * response parser applies the exact atproto format, and an author must not be
 * able to fail a page with a value it rejects. Anything else is omitted.
 */
const recordCreatedAt = (value: unknown): string | undefined =>
  typeof value === 'string' && isDatetimeString(value) ? value : undefined

const buildItem = (row: MaearthQueryRow, kind: MaearthKind): ItemView => {
  const counts = rowCounts(kind, row)
  const subject = rowSubject(kind, row, counts)
  const createdAt = recordCreatedAt(row.record_created_at)
  return {
    uri: row.uri,
    cid: row.cid,
    author: { did: row.actor_did },
    kind,
    sortAt: row.sort_value,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(subject === undefined ? {} : { subject }),
    // Item counts always count the item's own uri, so only an update has them;
    // a repost's numbers describe its subject.
    ...(kind === 'update' ? counts : {}),
  }
}

// Semantic parameter errors are 422, as for the Hypercerts feed; structurally
// invalid params are rejected earlier, by parseParams, with 400.
const invalidParams = (message: string): FeedError =>
  new FeedError(FeedErrorCode.InvalidRequest, message, 422)

const parseParams = (input: { readonly $type: string }): MaearthFeedParams => {
  try {
    const parsed = maearthFeedParams.schema.$parse(input)
    return {
      $type: MAEARTH_FEED_PARAMS_TYPE,
      ...(parsed.viewerDid === undefined
        ? {}
        : { viewerDid: parsed.viewerDid }),
      ...(parsed.actorDid === undefined ? {} : { actorDid: parsed.actorDid }),
      ...(parsed.kinds === undefined ? {} : { kinds: parsed.kinds }),
    }
  } catch (cause) {
    throw new FeedError(
      FeedErrorCode.InvalidRequest,
      `params does not match ${MAEARTH_FEED_PARAMS_TYPE}; provide valid viewerDid, optional actorDid and supported kinds, then retry.`,
      400,
      { cause },
    )
  }
}

/** One statement resolves the complete current graph and returns merge metadata. */
export const createMaearthFeed = (
  runtime: SqlFeedRuntime<MaearthQueryRow>,
): RegisteredFeed =>
  defineSqlFeed(runtime, {
    id: MAEARTH_FEED_ID,
    params: {
      type: MAEARTH_FEED_PARAMS_TYPE,
      parse: parseParams,
      normalize: (params, pagination) => {
        if (params.viewerDid === undefined || !isValidDid(params.viewerDid)) {
          throw invalidParams(
            'viewerDid is required for the MaEarth Following feed; provide a valid viewer DID and retry.',
          )
        }
        const limit = pagination.limit ?? 20
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          throw invalidParams(
            'limit must be an integer from 1 through 50; change limit and retry.',
          )
        }
        const kinds = [...new Set(params.kinds ?? [])]
        if (kinds.some((kind) => !isMaearthKind(kind))) {
          throw invalidParams(
            `kinds contains an unsupported MaEarth kind; use ${MAEARTH_KINDS.join(', ')} and retry.`,
          )
        }
        return {
          viewerDid: params.viewerDid,
          ...pagination,
          limit,
          actorDid: params.actorDid,
          kinds,
        }
      },
    },
    sql,
    // The last bind enables the count lookup, which only getFeed (with-source) needs.
    bind: ({ params, cursor, mode, fetchLimit }) => [
      params.viewerDid,
      params.actorDid ?? null,
      params.kinds,
      cursor?.value ?? null,
      cursor?.uri ?? null,
      fetchLimit,
      mode === 'with-source',
    ],
    cursor: timestampUriCursor,
    mapRow: (row, mode) => {
      if (
        typeof row.uri !== 'string' ||
        typeof row.cid !== 'string' ||
        typeof row.collection !== 'string' ||
        typeof row.actor_did !== 'string' ||
        typeof row.sort_value !== 'string' ||
        !isMaearthKind(row.kind)
      ) {
        throw new Error(
          'MaEarth query metadata is incomplete or has an unsupported kind; correct the SQL projection before serving requests.',
        )
      }
      const metadata = {
        uri: row.uri,
        cid: row.cid,
        collection: row.collection,
        actorDid: row.actor_did,
        kind: row.kind,
        sortValue: row.sort_value,
      }
      if (mode === 'metadata') return metadata
      return { ...metadata, sourceValue: buildItem(row, row.kind) }
    },
  })

/** The built item, checked against the lexicon and this feed's kinds before it is served. */
const isMaearthItem = (value: unknown): value is ItemView =>
  itemView.schema.$matches(value) && isMaearthKind(value.kind)

/** Projects same-statement merge metadata and counts without identities, repost-target reads or hydration. */
export class MaearthFeedService {
  constructor(private readonly pages: FeedPageLoader) {}

  async getFeed(input: GetFeedSkeletonInput): Promise<GetHydratedFeedOutput> {
    const page = await this.pages.loadPage(input, 'with-source')
    const feed = page.rows.map((row) => {
      if (!isMaearthItem(row.sourceValue)) {
        throw new Error(
          'MaEarth item does not match the itemView lexicon or has an unsupported kind; correct the registered query projection before serving requests.',
        )
      }
      return row.sourceValue
    })
    return {
      feed,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    }
  }
}
