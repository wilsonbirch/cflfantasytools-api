import { describe, expect, it } from 'vitest'
import { requireAdmin, requireAuth } from '~/lib/guards.server'
import type { GraphQLContext } from '~/context'
import type { Account } from '~/generated/prisma/client'

const account = (role: 'USER' | 'ADMIN'): Account =>
    ({
        id: 1,
        uuid: 'a-uuid',
        email: 'wilson@example.test',
        password: 'hash',
        role,
        createdAt: new Date(),
        updatedAt: new Date(),
    }) as Account

const ctx = (role?: 'USER' | 'ADMIN'): GraphQLContext => ({
    auth: role ? { account: account(role), sessionUuid: 's-uuid' } : null,
    origin: 'http://test.local',
})

// This is the ONLY security boundary — web's /admin redirect and native's
// hidden tab are UX. In 3DF the equivalent check did not exist at all, which is
// how /api/unsubscribe let anyone edit anyone's preferences.
describe('requireAuth', () => {
    it('returns the auth context for a signed-in account', () => {
        expect(requireAuth(ctx('USER')).account.email).toBe('wilson@example.test')
    })

    it('rejects an anonymous request with UNAUTHENTICATED', () => {
        expect(() => requireAuth(ctx())).toThrowError(/signed in/i)
        try {
            requireAuth(ctx())
        } catch (err) {
            expect((err as { extensions: { code: string } }).extensions.code).toBe(
                'UNAUTHENTICATED',
            )
        }
    })
})

describe('requireAdmin', () => {
    it('allows an admin', () => {
        expect(requireAdmin(ctx('ADMIN')).account.role).toBe('ADMIN')
    })

    it('rejects a signed-in non-admin with FORBIDDEN', () => {
        expect(() => requireAdmin(ctx('USER'))).toThrowError(/admin/i)
        try {
            requireAdmin(ctx('USER'))
        } catch (err) {
            expect((err as { extensions: { code: string } }).extensions.code).toBe('FORBIDDEN')
        }
    })

    it('rejects an anonymous request before ever looking at the role', () => {
        expect(() => requireAdmin(ctx())).toThrowError(/signed in/i)
    })
})
