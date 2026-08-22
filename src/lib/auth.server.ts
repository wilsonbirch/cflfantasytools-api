import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { jwtVerify, SignJWT, type JWTPayload } from 'jose'
import type { Role } from '~/generated/prisma/client'

// nmh verifies Supabase-issued tokens. Here the api mints its own: 3DF's
// bcrypt hashes migrate verbatim and keep working, and there is no second
// identity store to operate for what is email + password only.
//
// HS256 is correct while this api is the only verifier. If a second service
// ever needs to verify offline, switch to EdDSA + a JWKS route — this file and
// context.ts are the only places that change.

const ISSUER = 'cflfantasytools'
const AUDIENCE = 'cflfantasytools'
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000

export const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000

export type AccessTokenClaims = JWTPayload & {
    // Account.uuid, never the surrogate integer id.
    sub: string
    role: Role
    // Session.uuid — lets a token be traced to (and revoked with) its family.
    sid: string
}

let _secret: Uint8Array | undefined

function secret(): Uint8Array {
    if (!_secret) {
        const raw = process.env.AUTH_JWT_SECRET
        if (!raw) throw new Error('AUTH_JWT_SECRET is not set; cannot sign or verify tokens')
        _secret = new TextEncoder().encode(raw)
    }
    return _secret
}

// Test seam mirroring db.server's __setTestPrisma, so the suite can mint and
// verify tokens without a real environment.
export const __setSecretForTest = (raw: string): void => {
    _secret = new TextEncoder().encode(raw)
}

export async function signAccessToken(claims: {
    accountUuid: string
    role: Role
    sessionUuid: string
}): Promise<string> {
    return new SignJWT({ role: claims.role, sid: claims.sessionUuid })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.accountUuid)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${ACCESS_TOKEN_TTL_MS / 1000}s`)
        .sign(secret())
}

/**
 * Verify an access token and return its claims. Throws on a bad signature,
 * issuer, audience or expiry — callers treat any throw as "anonymous".
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const { payload } = await jwtVerify(token, secret(), {
        issuer: ISSUER,
        audience: AUDIENCE,
    })
    if (typeof payload.sub !== 'string') throw new Error('token is missing sub')
    if (typeof payload.sid !== 'string') throw new Error('token is missing sid')
    return payload as AccessTokenClaims
}

// Refresh tokens are opaque, not JWTs: they are looked up, so they carry no
// claims worth signing, and an opaque value cannot be replayed as an access token.
export const generateRefreshToken = (): string => randomBytes(32).toString('base64url')

// Only the digest is ever stored. A leaked database therefore yields no usable
// refresh tokens.
export const hashRefreshToken = (token: string): string =>
    createHash('sha256').update(token).digest('hex')

export const refreshTokensMatch = (given: string, storedHash: string): boolean => {
    const a = Buffer.from(hashRefreshToken(given), 'hex')
    const b = Buffer.from(storedHash, 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
}
