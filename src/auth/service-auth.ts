import {
  LexServerAuthError,
  LexServerError,
  serviceAuth,
  type LexRouterAuth,
  type ServiceAuthCredentials,
  type ServiceAuthOptions,
} from '@atproto/lex-server'
import { createDidResolver } from '@atproto-labs/did-resolver'
import { safeFetchWrap } from '@atproto-labs/fetch-node'
import type { DidString } from '@atproto/syntax'

import type { Config } from '../config.js'

export type OptionalServiceAuth = LexRouterAuth<
  ServiceAuthCredentials | undefined
>

type OptionalServiceAuthOptions = Omit<ServiceAuthOptions, 'unique'>
const MAX_REPLAY_ENTRIES = 4_096
const MAX_REPLAY_ENTRIES_PER_ISSUER = 512
const authChallenge = {
  Bearer: { error: 'BadJwtLexiconMethod' },
} as const
const badJwtChallenge = {
  Bearer: { error: 'BadJwt' },
} as const
const replayChallenge = {
  Bearer: { error: 'NonceNotUnique' },
} as const
const textEncoder = new TextEncoder()

const expiredTokenError = (): LexServerAuthError =>
  new LexServerAuthError(
    'AuthenticationRequired',
    'JWT token expired',
    { Bearer: { error: 'JwtExpired' } },
  )

/**
 * Makes AT Protocol service authentication optional without treating malformed
 * credentials as anonymous requests. The built-in verifier handles signature,
 * audience, expiry, DID resolution, and key rotation. Verified tokens are
 * replay-protected in a bounded cache local to this auth instance and process.
 */
export const createOptionalServiceAuth = (
  options: OptionalServiceAuthOptions,
): OptionalServiceAuth => {
  // The upstream callback checks a non-canonical nonce before signature
  // verification. Keep it side-effect-free; canonical jti state is recorded
  // only after the built-in verifier and the exact endpoint check succeed.
  const verify = serviceAuth({ ...options, unique: async () => true })
  const replayEntriesByIssuer = new Map<string, Map<string, number>>()
  let replayEntryCount = 0
  let lastObservedWallMs = 0

  const removeReplayEntry = (
    issuerDid: string,
    jti: string,
    issuerEntries: Map<string, number>,
  ): void => {
    if (!issuerEntries.delete(jti)) return
    replayEntryCount -= 1
    if (issuerEntries.size === 0) {
      replayEntriesByIssuer.delete(issuerDid)
    }
  }

  const purgeExpiredIssuerEntries = (
    issuerDid: string,
    issuerEntries: Map<string, number>,
  ): void => {
    for (const [storedJti, expiry] of issuerEntries) {
      if (expiry <= lastObservedWallMs) {
        removeReplayEntry(issuerDid, storedJti, issuerEntries)
      }
    }
  }

  const purgeExpiredEntries = (): void => {
    for (const [issuerDid, issuerEntries] of replayEntriesByIssuer) {
      purgeExpiredIssuerEntries(issuerDid, issuerEntries)
    }
  }

  return async (context) => {
    if (context.request.headers.get('authorization') === null) {
      return undefined
    }

    const credentials = await verify(context)
    if (credentials.jwt.payload.lxm !== context.method.nsid) {
      throw new LexServerAuthError(
        'AuthenticationRequired',
        'JWT lexicon method is missing or does not match this endpoint; request a token with the exact endpoint NSID in lxm.',
        authChallenge,
      )
    }

    const payload = credentials.jwt.payload as typeof credentials.jwt.payload & {
      readonly jti?: unknown
    }
    const jti = payload.jti
    if (
      typeof jti !== 'string' ||
      jti.length === 0 ||
      textEncoder.encode(jti).byteLength > 256
    ) {
      throw new LexServerAuthError(
        'AuthenticationRequired',
        'JWT jti must be a non-empty string no longer than 256 UTF-8 bytes; request a token with a valid jti.',
        badJwtChallenge,
      )
    }

    lastObservedWallMs = Math.max(Date.now(), lastObservedWallMs)
    const expiresAt = (payload.exp + 1) * 1_000
    if (expiresAt <= lastObservedWallMs) {
      throw expiredTokenError()
    }

    const issuerDid = credentials.did
    let issuerEntries = replayEntriesByIssuer.get(issuerDid)
    const storedExpiry = issuerEntries?.get(jti)
    if (storedExpiry !== undefined) {
      if (storedExpiry > lastObservedWallMs) {
        throw new LexServerAuthError(
          'AuthenticationRequired',
          'Replay attack detected: token is not unique; request a fresh token.',
          replayChallenge,
        )
      }
      removeReplayEntry(issuerDid, jti, issuerEntries!)
      issuerEntries = replayEntriesByIssuer.get(issuerDid)
    }

    if (issuerEntries !== undefined && issuerEntries.size >= MAX_REPLAY_ENTRIES_PER_ISSUER) {
      purgeExpiredIssuerEntries(issuerDid, issuerEntries)
      issuerEntries = replayEntriesByIssuer.get(issuerDid)
    }
    if (
      issuerEntries !== undefined &&
      issuerEntries.size >= MAX_REPLAY_ENTRIES_PER_ISSUER
    ) {
      throw new LexServerError(503, {
        error: 'InternalError',
        message:
          'Authentication replay protection reached the per-issuer limit; retry later with a fresh token.',
      })
    }

    if (replayEntryCount >= MAX_REPLAY_ENTRIES) {
      purgeExpiredEntries()
    }
    if (replayEntryCount >= MAX_REPLAY_ENTRIES) {
      throw new LexServerError(503, {
        error: 'InternalError',
        message:
          'Authentication replay protection is temporarily at capacity; retry later with a fresh token.',
      })
    }

    issuerEntries ??= new Map<string, number>()
    replayEntriesByIssuer.set(issuerDid, issuerEntries)
    issuerEntries.set(jti, expiresAt)
    replayEntryCount += 1
    return credentials
  }
}

/** Builds the production auth verifier and its bounded DID resolver. */
export const createConfiguredServiceAuth = (
  config: Pick<
    Config,
    'serviceDid' | 'serviceAuthMaxAgeSeconds' | 'didResolutionTimeoutMs'
  >,
): OptionalServiceAuth => {
  const didResolver = createDidResolver({
    allowHttp: false,
    fetch: safeFetchWrap({
      responseMaxSize: 128 * 1024,
      ssrfProtection: true,
      allowHttp: false,
      allowCustomPort: false,
      allowIpHost: false,
      allowPrivateIps: false,
      timeout: config.didResolutionTimeoutMs,
      allowImplicitRedirect: false,
    }),
  })

  // lex-server currently rejects Proposal 0014 did#serviceId audiences.
  // Keep the bare-DID audience until upstream can accept both forms explicitly.
  return createOptionalServiceAuth({
    audience: config.serviceDid as DidString,
    maxAge: config.serviceAuthMaxAgeSeconds,
    didResolver,
  })
}

export type { ServiceAuthCredentials }
