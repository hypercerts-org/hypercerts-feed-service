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

/** Merge metadata only: MaEarth owns content hydration and visibility filtering. */
export interface MaearthFeedView {
  readonly $type: 'org.hypercerts.feed.defs#maearthFeedView'
  readonly kind: MaearthKind
  readonly createdAt: string
  readonly repostedPostUri?: string
  /** The followed project's collection URI; present only for `projectFollow`. */
  readonly followedProjectUri?: string
  /** The followed account; present only for `accountFollow`. */
  readonly followedDid?: string
}

export const isMaearthKind = (kind: string): kind is MaearthKind =>
  MAEARTH_KINDS.some((candidate) => candidate === kind)
