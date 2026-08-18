import { beforeAll, describe, expect, it } from 'vitest'
import {
    __setSecretForTest,
    generateRefreshToken,
    hashRefreshToken,
    refreshTokensMatch,
    signAccessToken,
    verifyAccessToken,
} from '~/lib/auth.server'

beforeAll(() => {
    __setSecretForTest('test-secret-not-used-anywhere-real')
})

const claims = {
    accountUuid: '11111111-1111-1111-1111-111111111111',
    role: 'USER' as const,
    sessionUuid: '22222222-2222-2222-2222-222222222222',
}

describe('access tokens', () => {
    it('round-trips the claims a resolver needs', async () => {
        const token = await signAccessToken(claims)
        const decoded = await verifyAccessToken(token)
        expect(decoded.sub).toBe(claims.accountUuid)
        expect(decoded.role).toBe('USER')
        expect(decoded.sid).toBe(claims.sessionUuid)
    })

    it('rejects a tampered payload', async () => {
        const token = await signAccessToken(claims)
        const [header, payload, sig] = token.split('.')
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString())
        decoded.role = 'ADMIN'
        const forged = Buffer.from(JSON.stringify(decoded)).toString('base64url')
        await expect(verifyAccessToken(`${header}.${forged}.${sig}`)).rejects.toThrow()
    })

    it('rejects a token signed with a different secret', async () => {
        const token = await signAccessToken(claims)
        __setSecretForTest('a-completely-different-secret')
        await expect(verifyAccessToken(token)).rejects.toThrow()
        __setSecretForTest('test-secret-not-used-anywhere-real')
    })

    it('rejects garbage', async () => {
        await expect(verifyAccessToken('not-a-jwt')).rejects.toThrow()
    })
})

describe('refresh tokens', () => {
    it('generates distinct opaque tokens', () => {
        const a = generateRefreshToken()
        const b = generateRefreshToken()
        expect(a).not.toBe(b)
        // 32 random bytes, base64url — no padding, comfortably long.
        expect(a.length).toBeGreaterThanOrEqual(42)
    })

    it('never stores the token itself', () => {
        const token = generateRefreshToken()
        const stored = hashRefreshToken(token)
        expect(stored).not.toContain(token)
        expect(stored).toMatch(/^[0-9a-f]{64}$/)
    })

    it('matches a token against its stored hash', () => {
        const token = generateRefreshToken()
        expect(refreshTokensMatch(token, hashRefreshToken(token))).toBe(true)
    })

    it('rejects a different token', () => {
        expect(
            refreshTokensMatch(generateRefreshToken(), hashRefreshToken(generateRefreshToken())),
        ).toBe(false)
    })
})
