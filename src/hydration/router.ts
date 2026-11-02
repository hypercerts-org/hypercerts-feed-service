import type { GetFeedSkeletonInput } from '../feed/types.js'
import type { HydratedFeedReader } from './service.js'

/**
 * Sends each feedId that owns its row kinds to its own hydrator. Every other
 * feedId reaches the default hydrator, whose registry rejects unregistered ids.
 */
export class HydratedFeedRouter implements HydratedFeedReader {
  constructor(
    private readonly fallback: HydratedFeedReader,
    private readonly byFeedId: ReadonlyMap<string, HydratedFeedReader>,
  ) {}

  getFeed(
    input: GetFeedSkeletonInput,
  ): ReturnType<HydratedFeedReader['getFeed']> {
    return (this.byFeedId.get(input.feedId) ?? this.fallback).getFeed(input)
  }
}
