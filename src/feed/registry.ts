import type { MaearthKind } from './maearth-types.js'
import { FeedError, FeedErrorCode } from './errors.js'
import type { FeedKind, FeedParams, GetFeedSkeletonInput } from './types.js'

export type FeedPageMode = 'metadata' | 'with-source'

/** Pagination controls shared by every registered feed. */
export interface FeedPagination {
  readonly limit?: number
  readonly cursor?: string
}

export interface InternalFeedRow {
  readonly uri: string
  readonly cid: string
  readonly collection: string
  readonly actorDid: string
  readonly kind: FeedKind | MaearthKind
  readonly sortValue: string
}

export interface InternalSourceFeedRow extends InternalFeedRow {
  readonly sourceValue: unknown
}

export interface InternalFeedPage<Row extends InternalFeedRow> {
  readonly rows: readonly Row[]
  readonly cursor?: string
}

export interface FeedPageLoader {
  loadPage(
    input: GetFeedSkeletonInput,
    mode: 'metadata',
  ): Promise<InternalFeedPage<InternalFeedRow>>
  loadPage(
    input: GetFeedSkeletonInput,
    mode: 'with-source',
  ): Promise<InternalFeedPage<InternalSourceFeedRow>>
}

export interface RegisteredFeed {
  readonly id: string
  /** Required params discriminator, or undefined when the feed accepts no params. */
  readonly paramsType: string | undefined

  loadPage(
    params: FeedParams | undefined,
    pagination: FeedPagination,
    mode: 'metadata',
  ): Promise<InternalFeedPage<InternalFeedRow>>
  loadPage(
    params: FeedParams | undefined,
    pagination: FeedPagination,
    mode: 'with-source',
  ): Promise<InternalFeedPage<InternalSourceFeedRow>>
}

export class FeedRegistry implements FeedPageLoader {
  readonly #feeds = new Map<string, RegisteredFeed>()

  constructor(feeds: readonly RegisteredFeed[]) {
    for (const feed of feeds) {
      if (this.#feeds.has(feed.id)) {
        throw new Error(
          `Feed registry contains duplicate feedId ${JSON.stringify(feed.id)}; register each feed identifier exactly once.`,
        )
      }
      this.#feeds.set(feed.id, feed)
    }
  }

  loadPage(
    input: GetFeedSkeletonInput,
    mode: 'metadata',
  ): Promise<InternalFeedPage<InternalFeedRow>>
  loadPage(
    input: GetFeedSkeletonInput,
    mode: 'with-source',
  ): Promise<InternalFeedPage<InternalSourceFeedRow>>
  async loadPage(
    input: GetFeedSkeletonInput,
    mode: FeedPageMode,
  ): Promise<InternalFeedPage<InternalFeedRow | InternalSourceFeedRow>> {
    const feed = this.#feeds.get(input.feedId)
    if (feed === undefined) {
      throw new FeedError(
        FeedErrorCode.UnsupportedFeed,
        `feedId ${JSON.stringify(input.feedId)} is not registered by this service; use a supported feed identifier and retry.`,
      )
    }
    if (feed.paramsType === undefined) {
      if (input.params !== undefined) {
        throw new FeedError(
          FeedErrorCode.InvalidRequest,
          `feedId ${JSON.stringify(input.feedId)} does not accept algorithm-specific params; omit params and retry.`,
        )
      }
    } else if (input.params === undefined) {
      throw new FeedError(
        FeedErrorCode.InvalidRequest,
        `feedId ${JSON.stringify(input.feedId)} requires params with $type ${JSON.stringify(feed.paramsType)}; provide those params and retry.`,
      )
    } else if (input.params.$type !== feed.paramsType) {
      throw new FeedError(
        FeedErrorCode.InvalidRequest,
        `params.$type ${JSON.stringify(input.params.$type)} does not match feedId ${JSON.stringify(input.feedId)}; use ${JSON.stringify(feed.paramsType)} and retry.`,
      )
    }

    const pagination: FeedPagination = {
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }
    return mode === 'metadata'
      ? feed.loadPage(input.params, pagination, 'metadata')
      : feed.loadPage(input.params, pagination, 'with-source')
  }
}
