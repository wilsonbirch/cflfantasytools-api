import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
    __setAppSecretForTest,
    signUnsubscribeToken,
    verifyUnsubscribeToken,
} from '~/lib/signedLinks.server'

const uuid = '11111111-1111-1111-1111-111111111111'

beforeAll(() => __setAppSecretForTest('test-app-secret'))

describe('unsubscribe tokens', () => {
    it('round-trips the account and club', () => {
        const token = signUnsubscribeToken(uuid, 'calgary-stampeders')
        expect(verifyUnsubscribeToken(token)).toEqual({
            accountUuid: uuid,
            teamSlug: 'calgary-stampeders',
        })
    })

    it('is URL-safe', () => {
        expect(encodeURIComponent(signUnsubscribeToken(uuid, 'bc-lions'))).toBe(
            signUnsubscribeToken(uuid, 'bc-lions'),
        )
    })

    it('rejects an edited club, account or signature', () => {
        const [a, , sig] = signUnsubscribeToken(uuid, 'bc-lions').split('.')
        expect(verifyUnsubscribeToken(`${a}.calgary-stampeders.${sig}`)).toBeNull()
        expect(verifyUnsubscribeToken(`${uuid.replace('1', '2')}.bc-lions.${sig}`)).toBeNull()
        expect(verifyUnsubscribeToken(`${a}.bc-lions.${sig.slice(1)}x`)).toBeNull()
    })

    it('rejects malformed tokens without throwing', () => {
        expect(verifyUnsubscribeToken('')).toBeNull()
        expect(verifyUnsubscribeToken('a.b')).toBeNull()
        expect(verifyUnsubscribeToken('a.b.c.d')).toBeNull()
    })

    it('fails loudly without APP_SECRET rather than signing with a default', async () => {
        vi.resetModules()
        const original = process.env.APP_SECRET
        delete process.env.APP_SECRET
        try {
            const fresh = await import('~/lib/signedLinks.server')
            expect(() => fresh.signUnsubscribeToken(uuid, 'bc-lions')).toThrow(/APP_SECRET/)
        } finally {
            if (original !== undefined) process.env.APP_SECRET = original
        }
    })

    it('reads the secret from the environment when one is configured', async () => {
        vi.resetModules()
        const original = process.env.APP_SECRET
        process.env.APP_SECRET = 'from-env'
        try {
            const fresh = await import('~/lib/signedLinks.server')
            const token = fresh.signUnsubscribeToken(uuid, 'bc-lions')
            expect(fresh.verifyUnsubscribeToken(token)?.teamSlug).toBe('bc-lions')
        } finally {
            if (original === undefined) delete process.env.APP_SECRET
            else process.env.APP_SECRET = original
        }
    })
})
