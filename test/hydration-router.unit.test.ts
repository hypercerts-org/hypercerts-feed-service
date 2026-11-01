import { describe, expect, it } from 'vitest'

import type { GetFeedSkeletonInput } from '../src/feed/types.js'
import { HydratedFeedRouter } from '../src/hydration/router.js'
import type { HydratedFeedReader } from '../src/hydration/service.js'
import type { GetHydratedFeedOutput } from '../src/hydration/types.js'

class RecordingReader implements HydratedFeedReader {
  readonly calls: string[] = []

  constructor(private readonly name: string) {}

  getFeed(input: GetFeedSkeletonInput): Promise<GetHydratedFeedOutput> {
    this.calls.push(input.feedId)
    return Promise.resolve({ feed: [], cursor: this.name })
  }
}

describe('HydratedFeedRouter', () => {
  it('sends a registered feedId to its own hydrator and everything else to the default', async () => {
    const fallback = new RecordingReader('default')
    const owned = new RecordingReader('owned')
    const router = new HydratedFeedRouter(
      fallback,
      new Map([['org.example.feed#owned', owned]]),
    )

    await expect(
      router.getFeed({ feedId: 'org.example.feed#owned' }),
    ).resolves.toEqual({ feed: [], cursor: 'owned' })
    await expect(
      router.getFeed({ feedId: 'org.example.feed#other' }),
    ).resolves.toEqual({ feed: [], cursor: 'default' })
    expect(owned.calls).toEqual(['org.example.feed#owned'])
    expect(fallback.calls).toEqual(['org.example.feed#other'])
  })
})
