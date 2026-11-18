import type { BlobRef } from '@atproto/lex'

import type { MaearthKind } from '../feed/maearth-types.js'
import type { FeedKind } from '../feed/types.js'

/** Current HappyView Certified-profile data for one requested DID. */
export interface ActorContext {
  readonly did: string
  readonly certifiedProfile?: unknown
}

/** Batch reader for current Certified-profile records. */
export interface IdentityReader {
  getByDids(dids: readonly string[]): Promise<ReadonlyMap<string, ActorContext>>
}

/** Protocol-native external image URI. */
export interface UriImageReference {
  readonly $type: 'org.hypercerts.defs#uri'
  readonly uri: string
}

/** Protocol-native Hypercerts small-image wrapper. */
export interface SmallImageReference {
  readonly $type: 'org.hypercerts.defs#smallImage'
  readonly image: BlobRef
}

/** Protocol-native Hypercerts large-image wrapper. */
export interface LargeImageReference {
  readonly $type: 'org.hypercerts.defs#largeImage'
  readonly image: BlobRef
}

/** Protocol-native Hypercerts attachment wrapper containing an image blob. */
export interface SmallBlobImageReference {
  readonly $type: 'org.hypercerts.defs#smallBlob'
  readonly blob: BlobRef
}

export type ActorImageReference = UriImageReference | SmallImageReference
export type CollectionImageReference = ActorImageReference | LargeImageReference
export type UpdateImageReference = UriImageReference | SmallBlobImageReference

/**
 * An account: the item's `author`, or an item `subject` that points at an
 * account. Certified-profile fields are set only by the Hypercerts feed.
 */
export interface ActorView {
  readonly did: string
  readonly displayName?: string
  readonly avatar?: ActorImageReference
}

/**
 * A reference to a record. `cid` is optional because a project follow's subject
 * carries none. Counts, when set, count `uri`.
 */
export interface RecordView {
  readonly uri: string
  readonly cid?: string
  readonly likeCount?: number
  readonly repostCount?: number
  readonly replyCount?: number
}

/** An item subject that references a record. */
export interface RecordSubject extends RecordView {
  readonly $type: 'org.hypercerts.feed.defs#recordView'
}

/** An item subject that references an account. */
export interface ActorSubject extends ActorView {
  readonly $type: 'org.hypercerts.feed.defs#actorView'
}

/** What an item's own record points at; mirrors that record's single `subject`. */
export type ItemSubject = RecordSubject | ActorSubject

/** First-render fields for an activity feed card. */
export interface ActivityFeedView {
  readonly $type: 'org.hypercerts.feed.defs#activityView'
  readonly title: string
  readonly shortDescription?: string
  readonly image?: ActorImageReference
  readonly startDate?: string
  readonly endDate?: string
  readonly locationCount: number
}

/** First-render fields shared by collection and project-with-cert cards. */
export interface CollectionFeedView {
  readonly $type: 'org.hypercerts.feed.defs#collectionView'
  readonly collectionType?: string
  readonly title: string
  readonly shortDescription?: string
  readonly image?: CollectionImageReference
  readonly itemCount: number
}

/** Lean first-render fields for an evaluation card. */
export interface EvaluationFeedView {
  readonly $type: 'org.hypercerts.feed.defs#evaluationView'
  readonly summary?: string
}

/** Lean first-render fields for a measurement card. */
export interface MeasurementFeedView {
  readonly $type: 'org.hypercerts.feed.defs#measurementView'
  readonly metric?: string
  readonly subjects?: readonly RecordView[]
}

/** First-render fields for an attachment/update card. */
export interface UpdateFeedView {
  readonly $type: 'org.hypercerts.feed.defs#updateView'
  readonly title?: string
  readonly shortDescription?: string
  readonly image?: UpdateImageReference
  readonly subjects?: readonly RecordView[]
}

/** Stable kind-specific card data built from one validated source record. */
export type ItemContent =
  | ActivityFeedView
  | CollectionFeedView
  | EvaluationFeedView
  | MeasurementFeedView
  | UpdateFeedView

/** Every kind either feed can return. */
export type ItemKind = FeedKind | MaearthKind

/**
 * One feed item, flat: the item's own record, its author, kind and sort time,
 * and optionally what it points at, its counts and its card content.
 */
export interface ItemView {
  /** AT-URI of the item's own record. */
  readonly uri: string
  /** CID of the item's own record. Optional on the wire; this service always sets it. */
  readonly cid: string
  /** The account that wrote the item's own record (the authority of `uri`). */
  readonly author: ActorView
  readonly kind: ItemKind
  /** The value the feed is ordered by and the cursor encodes. */
  readonly sortAt: string
  /** The record's own `createdAt`, unchanged; absent when unusable. */
  readonly createdAt?: string
  readonly subject?: ItemSubject
  /** Counts of `uri`; MaEarth update items (all three) and funding-receipt items (no replyCount). */
  readonly likeCount?: number
  readonly repostCount?: number
  readonly replyCount?: number
  /** Hypercerts card fields; never set by the MaEarth feed. */
  readonly content?: ItemContent
}

/** Public response body projected by a hydrated feed service. */
export interface GetHydratedFeedOutput {
  readonly feed: readonly ItemView[]
  readonly cursor?: string
}
