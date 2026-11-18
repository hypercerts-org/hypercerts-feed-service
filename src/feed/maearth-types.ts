/** Experimental Following algorithm; gifts, discovery and privacy remain in MaEarth. */
export const MAEARTH_FEED_ID = 'org.hypercerts.feed.defs#maearthFeed' as const
export const MAEARTH_FEED_PARAMS_TYPE =
  'org.hypercerts.feed.defs#maearthFeedParams' as const

export const MAEARTH_KINDS = [
  'post',
  'projectFollow',
  'accountFollow',
  'repost',
] as const
export type MaearthKind = (typeof MAEARTH_KINDS)[number]

export interface MaearthFeedParams {
  readonly $type: typeof MAEARTH_FEED_PARAMS_TYPE
  readonly viewerDid?: string
  /** Narrows the viewer's Following scope; does not select a public profile feed. */
  readonly actorDid?: string
  readonly kinds?: readonly string[]
}

/** Merge metadata and engagement counts: MaEarth owns content hydration and visibility filtering. */
export interface MaearthFeedView {
  readonly $type: 'org.hypercerts.feed.defs#maearthFeedView'
  readonly kind: MaearthKind
  readonly createdAt: string
  /** CID of the item's own record (the entry's subject). */
  readonly cid?: string
  /** The item record's author: the subject URI's authority. */
  readonly actorDid?: string
  readonly repostedPostUri?: string
  /** The followed project's collection URI; present only for `projectFollow`. */
  readonly followedProjectUri?: string
  /** The followed account; present only for `accountFollow`. */
  readonly followedDid?: string
  /**
   * Counts of the item's post (a repost item counts its original post); present,
   * possibly 0, on `post` and `repost` items and absent on follows.
   */
  readonly likeCount?: number
  readonly repostCount?: number
  readonly replyCount?: number
}

export const isMaearthKind = (kind: string): kind is MaearthKind =>
  (MAEARTH_KINDS as readonly string[]).includes(kind)
