import { readFileSync } from 'node:fs'

import { isValidDid, parseAtUriString } from '@atproto/syntax'
import type { QueryResultRow } from 'pg'

import { timestampUriCursor } from './cursor.js'
import { FeedError, FeedErrorCode } from './errors.js'
import {
  MAEARTH_FEED_ID,
  MAEARTH_FEED_PARAMS_TYPE,
  MAEARTH_KINDS,
  isMaearthKind,
  type MaearthFeedParams,
  type MaearthFeedView,
  type MaearthKind,
} from './maearth-types.js'
import type { FeedPageLoader, RegisteredFeed } from './registry.js'
import { defineSqlFeed, type SqlFeedRuntime } from './sql-feed.js'
import type { GetFeedSkeletonInput } from './types.js'
import type { GetHydratedFeedOutput } from '../hydration/types.js'
import {
  maearthFeedParams,
  maearthFeedView,
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
  readonly reposted_post_uri: string | null
  readonly followed_project_uri: string | null
  readonly followed_did: string | null
}

type RowTarget = Pick<
  MaearthFeedView,
  'repostedPostUri' | 'followedProjectUri' | 'followedDid'
>

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

/**
 * Each kind carries exactly its own target and no other kind's: reposts the
 * original post, project follows the project, account follows the DID, posts
 * nothing. A violation is a SQL projection bug, so it fails the request
 * instead of emitting a view the client cannot trust.
 */
const rowTarget = (
  kind: MaearthKind,
  { repost, project, did }: { repost: unknown; project: unknown; did: unknown },
): RowTarget => {
  if (
    kind === 'repost' &&
    isRecordUri(repost, POST_COLLECTION) &&
    project === null &&
    did === null
  )
    return { repostedPostUri: repost }
  if (
    kind === 'projectFollow' &&
    repost === null &&
    isRecordUri(project, PROJECT_COLLECTION) &&
    did === null
  )
    return { followedProjectUri: project }
  if (
    kind === 'accountFollow' &&
    repost === null &&
    project === null &&
    isValidDid(did)
  )
    return { followedDid: did }
  if (kind === 'post' && repost === null && project === null && did === null)
    return {}
  throw new Error(
    "MaEarth query row has a target that does not match its kind: repost needs a valid reposted_post_uri, projectFollow a valid followed_project_uri, accountFollow a valid followed_did, post none, and no kind may carry another kind's target; correct the SQL projection before serving requests.",
  )
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
    bind: ({ params, cursor, fetchLimit }) => [
      params.viewerDid,
      params.actorDid ?? null,
      params.kinds,
      cursor?.value ?? null,
      cursor?.uri ?? null,
      fetchLimit,
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
      const target = rowTarget(row.kind, {
        repost: row.reposted_post_uri,
        project: row.followed_project_uri,
        did: row.followed_did,
      })
      const metadata = {
        uri: row.uri,
        cid: row.cid,
        collection: row.collection,
        actorDid: row.actor_did,
        kind: row.kind,
        sortValue: row.sort_value,
      }
      if (mode === 'metadata') return metadata
      const view: MaearthFeedView = {
        $type: 'org.hypercerts.feed.defs#maearthFeedView',
        kind: row.kind,
        createdAt: row.sort_value,
        ...target,
      }
      return { ...metadata, sourceValue: view }
    },
  })

/** Projects same-statement merge metadata without identities, repost-target reads or hydration. */
export class MaearthFeedService {
  constructor(private readonly pages: FeedPageLoader) {}

  async getFeed(
    input: GetFeedSkeletonInput,
  ): Promise<GetHydratedFeedOutput<MaearthFeedView>> {
    const page = await this.pages.loadPage(input, 'with-source')
    const feed = page.rows.map((row) => {
      const parsed = maearthFeedView.schema.$parse(row.sourceValue)
      if (!isMaearthKind(parsed.kind)) {
        throw new Error(
          'MaEarth view contains an unsupported kind; correct the registered query projection before serving requests.',
        )
      }
      const view: MaearthFeedView = {
        $type: 'org.hypercerts.feed.defs#maearthFeedView',
        kind: parsed.kind,
        createdAt: parsed.createdAt,
        ...(parsed.repostedPostUri === undefined
          ? {}
          : { repostedPostUri: parsed.repostedPostUri }),
        ...(parsed.followedProjectUri === undefined
          ? {}
          : { followedProjectUri: parsed.followedProjectUri }),
        ...(parsed.followedDid === undefined
          ? {}
          : { followedDid: parsed.followedDid }),
      }
      return { subject: row.uri, view }
    })
    return {
      feed,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    }
  }
}
