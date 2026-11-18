import { isDatetimeString } from '@atproto/syntax'

import type { FeedPageLoader, InternalSourceFeedRow } from '../feed/registry.js'
import { FEED_KINDS, type GetFeedSkeletonInput } from '../feed/types.js'
import type {
  ActorContext,
  ActorView,
  GetHydratedFeedOutput,
  IdentityReader,
  ItemView,
} from './types.js'
import {
  getEndorsedActorDid,
  validateCertifiedProfile,
  validateFeedRecord,
  type ValidatedFeedRecord,
} from './validation.js'
import { itemView } from '../lexicons/org/hypercerts/feed/defs.js'
import {
  buildActorView,
  buildEndorsedSubject,
  buildItemContent,
  buildRecordSubject,
} from './views.js'

const identityInvariantError = (): Error =>
  new Error(
    'Hydrated feed identity invariant failed: the identity batch omitted or mismatched a context for a requested DID; verify IdentityReader returns one exact context per requested DID before serving hydrated pages.',
  )

const unsupportedKindError = (kind: string): Error =>
  new Error(
    `Hydrated Hypercerts feed invariant failed: a selected row has kind ${JSON.stringify(kind)}, which this hydrator does not serve; route every registered feedId to the hydrator that owns its row kinds before serving requests.`,
  )

const requireActorView = (
  did: string,
  contexts: ReadonlyMap<string, ActorContext>,
): ActorView => {
  const context = contexts.get(did)
  if (context?.did !== did) {
    throw identityInvariantError()
  }

  return buildActorView(did, validateCertifiedProfile(context.certifiedProfile))
}

/** Every item field that needs no identity lookup. */
type IdentityFreeItem = Omit<ItemView, 'author'>

interface ValidatedFeedRow {
  readonly row: InternalSourceFeedRow
  readonly record: ValidatedFeedRecord
  readonly endorsedDid: string | undefined
  readonly item: IdentityFreeItem
}

/**
 * The record's own `createdAt` is omitted when the output format rejects it:
 * the record validator accepts lenient values such as one without a zone.
 */
const buildIdentityFreeItem = (
  row: InternalSourceFeedRow,
  record: ValidatedFeedRecord,
): IdentityFreeItem => {
  const createdAt = record.value.createdAt
  const subject = buildRecordSubject(record)
  const content = buildItemContent(record)
  return {
    uri: row.uri,
    cid: row.cid,
    kind: record.kind,
    sortAt: row.sortValue,
    ...(isDatetimeString(createdAt) ? { createdAt } : {}),
    ...(subject === undefined ? {} : { subject }),
    ...(content === undefined ? {} : { content }),
  }
}

interface ValidatedFeedBatch {
  readonly rows: readonly ValidatedFeedRow[]
  readonly requestedDids: ReadonlySet<string>
}

const collectValidatedFeedRows = (
  rows: readonly InternalSourceFeedRow[],
): ValidatedFeedBatch => {
  const validatedRows: ValidatedFeedRow[] = []
  const requestedDids = new Set<string>()

  for (const row of rows) {
    const kind = FEED_KINDS.find((candidate) => candidate === row.kind)
    if (kind === undefined) throw unsupportedKindError(row.kind)
    const record = validateFeedRecord(kind, row.collection, row.sourceValue)
    if (record === undefined) continue

    // The record validator accepts values the output format rejects (a zone-less
    // startDate, a `..` record key in a reference). One such value would fail the
    // whole page, so a record whose item does not match the Lexicon is an invalid
    // source. Identity is not known yet, so the author is the row's DID alone.
    const item = buildIdentityFreeItem(row, record)
    if (!itemView.schema.$matches({ ...item, author: { did: row.actorDid } })) {
      continue
    }

    const endorsedDid = getEndorsedActorDid(record)
    validatedRows.push({ row, record, endorsedDid, item })
    requestedDids.add(row.actorDid)
    if (endorsedDid !== undefined) requestedDids.add(endorsedDid)
  }

  return { rows: validatedRows, requestedDids }
}

const buildItems = (
  validatedRows: readonly ValidatedFeedRow[],
  views: ReadonlyMap<string, ActorView>,
): ItemView[] =>
  validatedRows.map(({ row, record, endorsedDid, item }) => {
    const author = views.get(row.actorDid)
    if (author?.did !== row.actorDid) {
      throw identityInvariantError()
    }
    const endorsedActor =
      endorsedDid === undefined ? undefined : views.get(endorsedDid)
    const subject = buildEndorsedSubject(record, {
      ...(endorsedActor === undefined ? {} : { endorsedActor }),
    })

    return { ...item, author, ...(subject === undefined ? {} : { subject }) }
  })

const buildOutput = (
  feed: readonly ItemView[],
  cursor: string | undefined,
): GetHydratedFeedOutput => ({
  feed,
  ...(cursor === undefined ? {} : { cursor }),
})

/** Application seam consumed by the hydrated XRPC transport. */
export interface HydratedFeedReader {
  getFeed(input: GetFeedSkeletonInput): Promise<GetHydratedFeedOutput>
}

/** Coordinates one same-statement source page and one bounded identity batch. */
export class HydratedFeedService implements HydratedFeedReader {
  constructor(
    private readonly pages: FeedPageLoader,
    private readonly identities: IdentityReader,
  ) {}

  /** Builds one ordered, flat hydrated feed page. */
  async getFeed(input: GetFeedSkeletonInput): Promise<GetHydratedFeedOutput> {
    const page = await this.pages.loadPage(input, 'with-source')
    const batch = collectValidatedFeedRows(page.rows)

    if (batch.rows.length === 0) {
      return buildOutput([], page.cursor)
    }

    const views = await this.loadActorViews(batch.requestedDids)
    return buildOutput(buildItems(batch.rows, views), page.cursor)
  }

  private async loadActorViews(
    requestedDids: ReadonlySet<string>,
  ): Promise<ReadonlyMap<string, ActorView>> {
    const contexts = await this.identities.getByDids([...requestedDids])
    const views = new Map<string, ActorView>()

    for (const did of requestedDids) {
      views.set(did, requireActorView(did, contexts))
    }

    return views
  }
}
