/** Experimental Following algorithm; gifts, discovery and privacy remain in MaEarth. */
export const MAEARTH_FEED_ID = 'org.hypercerts.feed.defs#maearthFeed' as const
export const MAEARTH_FEED_PARAMS_TYPE =
  'org.hypercerts.feed.defs#maearthFeedParams' as const

/**
 * Item kinds of the MaEarth feed. `update` is a post: an attachment with contentType `update`.
 * `funding-receipt` is an `org.hypercerts.funding.receipt` record.
 */
export const MAEARTH_KINDS = [
  'update',
  'repost',
  'project-follow',
  'account-follow',
  'funding-receipt',
] as const
export type MaearthKind = (typeof MAEARTH_KINDS)[number]

export interface MaearthFeedParams {
  readonly $type: typeof MAEARTH_FEED_PARAMS_TYPE
  readonly viewerDid?: string
  /** Narrows the viewer's Following scope; does not select a public profile feed. */
  readonly actorDid?: string
  readonly kinds?: readonly string[]
}

export const isMaearthKind = (kind: string): kind is MaearthKind =>
  (MAEARTH_KINDS as readonly string[]).includes(kind)
