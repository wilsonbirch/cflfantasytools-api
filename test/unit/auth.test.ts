import { beforeAll, describe, expect, it, vi } from 'vitest'
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

describe('configuration', () => {
    it('fails loudly when AUTH_JWT_SECRET is unset rather than signing with a default', async () => {
        // A fresh module instance, so the cached secret from beforeAll is gone.
        vi.resetModules()
        const original = process.env.AUTH_JWT_SECRET
        delete process.env.AUTH_JWT_SECRET
        try {
            const fresh = await import('~/lib/auth.server')
            await expect(fresh.signAccessToken(claims)).rejects.toThrow(/AUTH_JWT_SECRET/)
        } finally {
            if (original !== undefined) process.env.AUTH_JWT_SECRET = original
        }
    })
    it('reads the secret from the environment when one is configured', async () => {
        // The other tests inject via __setSecretForTest, which bypasses the env
        // read entirely — this is the path production actually takes.
        vi.resetModules()
        const original = process.env.AUTH_JWT_SECRET
        process.env.AUTH_JWT_SECRET = 'secret-from-the-environment'
        try {
            const fresh = await import('~/lib/auth.server')
            const token = await fresh.signAccessToken(claims)
            expect((await fresh.verifyAccessToken(token)).sub).toBe(claims.accountUuid)
        } finally {
            if (original === undefined) delete process.env.AUTH_JWT_SECRET
            else process.env.AUTH_JWT_SECRET = original
        }
    })
})
