import type {
  ActivityFeedView,
  ActorImageReference,
  ActorView,
  CollectionFeedView,
  CollectionImageReference,
  EvaluationFeedView,
  ItemContent,
  ItemSubject,
  LargeImageReference,
  MeasurementFeedView,
  RecordView,
  SmallBlobImageReference,
  UpdateFeedView,
  UriImageReference,
} from './types.js'
import {
  getEndorsedActorDid,
  isMeaningfulCertifiedProfile,
  toProtocolBlobRef,
  type ValidatedCertifiedProfile,
  type ValidatedFeedRecord,
} from './validation.js'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const uriImageReference = (value: unknown): UriImageReference | undefined =>
  isObject(value) &&
  value.$type === 'org.hypercerts.defs#uri' &&
  typeof value.uri === 'string'
    ? { $type: 'org.hypercerts.defs#uri', uri: value.uri }
    : undefined

const smallImageReference = (
  value: unknown,
): ActorImageReference | undefined => {
  const uri = uriImageReference(value)
  if (uri !== undefined) return uri
  if (!isObject(value) || value.$type !== 'org.hypercerts.defs#smallImage') {
    return undefined
  }
  const image = toProtocolBlobRef(value.image)
  return image === undefined
    ? undefined
    : { $type: 'org.hypercerts.defs#smallImage', image }
}

const largeImageReference = (
  value: unknown,
): UriImageReference | LargeImageReference | undefined => {
  const uri = uriImageReference(value)
  if (uri !== undefined) return uri
  if (!isObject(value) || value.$type !== 'org.hypercerts.defs#largeImage') {
    return undefined
  }
  const image = toProtocolBlobRef(value.image)
  return image === undefined
    ? undefined
    : { $type: 'org.hypercerts.defs#largeImage', image }
}

const smallBlobImageReference = (
  value: unknown,
): SmallBlobImageReference | undefined => {
  if (!isObject(value) || value.$type !== 'org.hypercerts.defs#smallBlob') {
    return undefined
  }
  const blob = toProtocolBlobRef(value.blob)
  return blob === undefined
    ? undefined
    : { $type: 'org.hypercerts.defs#smallBlob', blob }
}

/** Uses a meaningful Certified profile, otherwise returns a DID-only identity. */
export const buildActorView = (
  did: string,
  certifiedProfile: ValidatedCertifiedProfile | undefined,
): ActorView => {
  if (certifiedProfile && isMeaningfulCertifiedProfile(certifiedProfile)) {
    const avatar = smallImageReference(certifiedProfile.avatar)
    return {
      did,
      ...(certifiedProfile.displayName === undefined
        ? {}
        : { displayName: certifiedProfile.displayName }),
      ...(avatar === undefined ? {} : { avatar }),
    }
  }

  return { did }
}

export interface FeedViewContext {
  readonly endorsedActor?: ActorView
}

const recordReference = (target: {
  readonly uri: string
  readonly cid: string
}): RecordView => ({ uri: target.uri, cid: target.cid })

const endorsementSubjectInvariantError = (): Error =>
  new Error(
    'Endorsement subject failed because the endorsed account could not be matched to its discovered identity; verify endorsement DID discovery and identity mapping before serving hydrated pages.',
  )

type FeedRecordValue<Collection extends ValidatedFeedRecord['collection']> =
  Extract<ValidatedFeedRecord, { readonly collection: Collection }>['value']

const buildActivityView = (
  value: FeedRecordValue<'org.hypercerts.claim.activity'>,
): ActivityFeedView => {
  const image = smallImageReference(value.image)
  return {
    $type: 'org.hypercerts.feed.defs#activityView',
    title: value.title,
    shortDescription: value.shortDescription,
    ...(image === undefined ? {} : { image }),
    ...(value.startDate === undefined ? {} : { startDate: value.startDate }),
    ...(value.endDate === undefined ? {} : { endDate: value.endDate }),
    locationCount: value.locations?.length ?? 0,
  }
}

const buildCollectionView = (
  value: FeedRecordValue<'org.hypercerts.collection'>,
): CollectionFeedView => {
  const image: CollectionImageReference | undefined =
    smallImageReference(value.avatar) ?? largeImageReference(value.banner)
  return {
    $type: 'org.hypercerts.feed.defs#collectionView',
    ...(value.type === undefined ? {} : { collectionType: value.type }),
    title: value.title,
    ...(value.shortDescription === undefined
      ? {}
      : { shortDescription: value.shortDescription }),
    ...(image === undefined ? {} : { image }),
    itemCount: value.items?.length ?? 0,
  }
}

const buildEvaluationView = (
  value: FeedRecordValue<'org.hypercerts.context.evaluation'>,
): EvaluationFeedView => ({
  $type: 'org.hypercerts.feed.defs#evaluationView',
  summary: value.summary,
})

const buildMeasurementView = (
  value: FeedRecordValue<'org.hypercerts.context.measurement'>,
): MeasurementFeedView => ({
  $type: 'org.hypercerts.feed.defs#measurementView',
  metric: value.metric,
  ...(value.subjects === undefined
    ? {}
    : { subjects: value.subjects.map(recordReference) }),
})

const buildUpdateView = (
  value: FeedRecordValue<'org.hypercerts.context.attachment'>,
): UpdateFeedView => {
  const imageBlob: unknown = value.content?.find(
    (entry) =>
      isObject(entry) &&
      entry.$type === 'org.hypercerts.defs#smallBlob' &&
      isObject(entry.blob) &&
      typeof entry.blob.mimeType === 'string' &&
      entry.blob.mimeType.startsWith('image/'),
  )
  const image = smallBlobImageReference(imageBlob)
  return {
    $type: 'org.hypercerts.feed.defs#updateView',
    title: value.title,
    ...(value.shortDescription === undefined
      ? {}
      : { shortDescription: value.shortDescription }),
    ...(image === undefined ? {} : { image }),
    ...(value.subjects === undefined
      ? {}
      : { subjects: value.subjects.map(recordReference) }),
  }
}

/**
 * Builds the Hypercerts card fields for one record without performing hydration
 * or other I/O. An endorsement has none: its account is the item's subject.
 */
export const buildItemContent = (
  record: ValidatedFeedRecord,
): ItemContent | undefined => {
  switch (record.kind) {
    case 'cert':
      return buildActivityView(record.value)
    case 'collection':
    case 'project-with-cert':
      return buildCollectionView(record.value)
    case 'endorsement':
      return undefined
    case 'evaluation':
      return buildEvaluationView(record.value)
    case 'measurement':
      return buildMeasurementView(record.value)
    case 'update':
      return buildUpdateView(record.value)
  }
}

/**
 * Builds what the record's own single `subject` points at: the evaluated record
 * for an evaluation, the hydrated endorsed account for an endorsement. Other
 * kinds have no single subject field (measurements and updates list theirs in
 * content).
 */
export const buildItemSubject = (
  record: ValidatedFeedRecord,
  context: FeedViewContext = {},
): ItemSubject | undefined => {
  switch (record.kind) {
    case 'evaluation':
      return record.value.subject === undefined
        ? undefined
        : {
            $type: 'org.hypercerts.feed.defs#recordView',
            ...recordReference(record.value.subject),
          }
    case 'endorsement': {
      const subjectDid = getEndorsedActorDid(record)
      if (
        subjectDid === undefined ||
        context.endorsedActor?.did !== subjectDid
      ) {
        throw endorsementSubjectInvariantError()
      }
      return {
        $type: 'org.hypercerts.feed.defs#actorView',
        ...context.endorsedActor,
      }
    }
    default:
      return undefined
  }
}
