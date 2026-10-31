import {
  COLLAB_TOKEN_AUDIENCE,
  collabTokenClaimsSchema,
  type CollabTokenClaims,
} from '@codesync/shared'
import jwt from 'jsonwebtoken'

export type TokenResult =
  | { ok: true; claims: CollabTokenClaims }
  | { ok: false; reason: 'expired' | 'invalid' }

export function verifyCollabToken(token: string | null, secret: string): TokenResult {
  if (!token) return { ok: false, reason: 'invalid' }
  try {
    // The algorithm is pinned so a forged header cannot select `none`.
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: COLLAB_TOKEN_AUDIENCE,
    })
    const claims = collabTokenClaimsSchema.safeParse(payload)
    return claims.success ? { ok: true, claims: claims.data } : { ok: false, reason: 'invalid' }
  } catch (error) {
    return { ok: false, reason: error instanceof jwt.TokenExpiredError ? 'expired' : 'invalid' }
  }
}
