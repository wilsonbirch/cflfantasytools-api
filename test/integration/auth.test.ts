import { beforeAll, describe, expect, it } from 'vitest'
import { __setSecretForTest } from '~/lib/auth.server'
import { __setAppSecretForTest, signUnsubscribeToken } from '~/lib/signedLinks.server'
import { db } from '~/lib/db.server'
import { executeOperation } from './setup/yogaClient'

type Payload = {
    accessToken: string
    refreshToken: string
    account: { id: number; uuid: string; email: string; role: string }
}

const REGISTER = `mutation ($email: String!, $password: String!) {
    register(email: $email, password: $password) {
        accessToken refreshToken account { id uuid email role }
    }
}`
const LOGIN = `mutation ($email: String!, $password: String!) {
    login(email: $email, password: $password) {
        accessToken refreshToken account { id uuid email role }
    }
}`
const REFRESH = `mutation ($t: String!) { refresh(refreshToken: $t) { accessToken refreshToken account { uuid } } }`
const LOGOUT = `mutation ($t: String!) { logout(refreshToken: $t) }`
const ME = `{ me { email role } }`

beforeAll(() => {
    __setSecretForTest('integration-secret')
    __setAppSecretForTest('integration-app-secret')
})

async function register(email = 'Wilson@Example.test', password = 'correct horse') {
    const r = await executeOperation<{ register: Payload }>({
        query: REGISTER,
        variables: { email, password },
    })
    expect(r.errors).toBeUndefined()
    return r.data!.register
}

const code = (r: { errors?: { extensions?: Record<string, unknown> }[] }) =>
    r.errors?.[0]?.extensions?.code

describe('register', () => {
    it('creates an account, lower-cases the email and signs the caller in', async () => {
        const p = await register()
        expect(p.account.email).toBe('wilson@example.test')
        expect(p.account.role).toBe('USER')
        expect(p.accessToken).toBeTruthy()
        expect(p.refreshToken).toBeTruthy()

        const me = await executeOperation<{ me: { email: string } }>(
            { query: ME },
            { token: p.accessToken },
        )
        expect(me.data?.me.email).toBe('wilson@example.test')

        // Never the password, never the plain refresh token.
        const row = await db.account.findUniqueOrThrow({ where: { id: p.account.id } })
        expect(row.password).not.toContain('correct horse')
        const session = await db.session.findFirstOrThrow({ where: { accountId: row.id } })
        expect(session.tokenHash).not.toBe(p.refreshToken)
    })

    it('rejects a duplicate email, a bad email and a short password', async () => {
        await register()
        const dup = await executeOperation({
            query: REGISTER,
            variables: { email: 'wilson@example.test', password: 'correct horse' },
        })
        expect(code(dup)).toBe('BAD_USER_INPUT')
        expect(dup.errors?.[0].message).toMatch(/already exists/)
        const bad = await executeOperation({
            query: REGISTER,
            variables: { email: 'not-an-email', password: 'correct horse' },
        })
        expect(code(bad)).toBe('BAD_USER_INPUT')
        const short = await executeOperation({
            query: REGISTER,
            variables: { email: 'ok@example.test', password: 'short' },
        })
        expect(code(short)).toBe('BAD_USER_INPUT')
        expect(await db.account.count()).toBe(1)
    })
})

describe('login', () => {
    it('signs in with the right password, case-insensitive on email', async () => {
        await register()
        const r = await executeOperation<{ login: Payload }>({
            query: LOGIN,
            variables: { email: 'WILSON@example.test', password: 'correct horse' },
        })
        expect(r.errors).toBeUndefined()
        expect(r.data?.login.account.email).toBe('wilson@example.test')
    })

    it('fails identically for a wrong password and an unknown email', async () => {
        await register()
        const wrong = await executeOperation({
            query: LOGIN,
            variables: { email: 'wilson@example.test', password: 'wrong horse' },
        })
        const unknown = await executeOperation({
            query: LOGIN,
            variables: { email: 'nobody@example.test', password: 'wrong horse' },
        })
        expect(wrong.errors?.[0].message).toBe(unknown.errors?.[0].message)
        expect(code(wrong)).toBe('UNAUTHENTICATED')
        expect(code(unknown)).toBe('UNAUTHENTICATED')
        expect(wrong.data).toBeNull()
    })
})

describe('me', () => {
    it('is null when signed out', async () => {
        const r = await executeOperation<{ me: null }>({ query: ME })
        expect(r.errors).toBeUndefined()
        expect(r.data?.me).toBeNull()
    })
})

describe('refresh', () => {
    it('rotates: the new pair works and the old refresh token is spent', async () => {
        const first = await register()
        const r = await executeOperation<{ refresh: Payload }>({
            query: REFRESH,
            variables: { t: first.refreshToken },
        })
        expect(r.errors).toBeUndefined()
        const second = r.data!.refresh
        expect(second.refreshToken).not.toBe(first.refreshToken)
        expect(second.account.uuid).toBe(first.account.uuid)

        const me = await executeOperation<{ me: { email: string } }>(
            { query: ME },
            { token: second.accessToken },
        )
        expect(me.data?.me.email).toBe('wilson@example.test')
        expect(await db.session.count({ where: { revokedAt: null } })).toBe(1)
    })

    it('treats reuse of a spent token as theft and revokes the whole family', async () => {
        const first = await register()
        const r = await executeOperation<{ refresh: Payload }>({
            query: REFRESH,
            variables: { t: first.refreshToken },
        })
        const second = r.data!.refresh
        // Rotate once more so the family has depth to walk.
        const r2 = await executeOperation<{ refresh: Payload }>({
            query: REFRESH,
            variables: { t: second.refreshToken },
        })
        const third = r2.data!.refresh

        const reuse = await executeOperation({
            query: REFRESH,
            variables: { t: first.refreshToken },
        })
        expect(code(reuse)).toBe('UNAUTHENTICATED')

        // The live descendant is gone too.
        const after = await executeOperation({
            query: REFRESH,
            variables: { t: third.refreshToken },
        })
        expect(code(after)).toBe('UNAUTHENTICATED')
        expect(await db.session.count({ where: { revokedAt: null } })).toBe(0)
    })

    it('rejects an unknown or expired token', async () => {
        const first = await register()
        const garbage = await executeOperation({ query: REFRESH, variables: { t: 'nope' } })
        expect(code(garbage)).toBe('UNAUTHENTICATED')

        await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })
        const expired = await executeOperation({
            query: REFRESH,
            variables: { t: first.refreshToken },
        })
        expect(code(expired)).toBe('UNAUTHENTICATED')
    })
})

describe('logout', () => {
    it('revokes the session and is idempotent', async () => {
        const p = await register()
        const out = await executeOperation<{ logout: boolean }>({
            query: LOGOUT,
            variables: { t: p.refreshToken },
        })
        expect(out.data?.logout).toBe(true)
        const again = await executeOperation<{ logout: boolean }>({
            query: LOGOUT,
            variables: { t: p.refreshToken },
        })
        expect(again.data?.logout).toBe(true)
        const r = await executeOperation({ query: REFRESH, variables: { t: p.refreshToken } })
        expect(code(r)).toBe('UNAUTHENTICATED')
    })
})

describe('subscriptions', () => {
    const seedTeams = () =>
        db.team.createMany({
            data: [
                { slug: 'calgary', abbreviation: 'CGY', name: 'Calgary' },
                { slug: 'bc', abbreviation: 'BC', name: 'BC' },
            ],
        })

    it('requires a session', async () => {
        const q = await executeOperation({ query: '{ mySubscriptions { id } }' })
        expect(code(q)).toBe('UNAUTHENTICATED')
        const m = await executeOperation({
            query: 'mutation { subscribe(teamSlug: "calgary") { id } }',
        })
        expect(code(m)).toBe('UNAUTHENTICATED')
    })

    it('subscribes, lists and unsubscribes per club for the signed-in account only', async () => {
        await seedTeams()
        const a = await register('a@example.test')
        const b = await register('b@example.test')

        const sub = await executeOperation<{
            subscribe: { enabled: boolean; team: { slug: string } }
        }>(
            { query: 'mutation { subscribe(teamSlug: "calgary") { enabled team { slug } } }' },
            { token: a.accessToken },
        )
        expect(sub.errors).toBeUndefined()
        expect(sub.data?.subscribe).toEqual({ enabled: true, team: { slug: 'calgary' } })
        await executeOperation(
            { query: 'mutation { subscribe(teamSlug: "bc") { id } }' },
            { token: a.accessToken },
        )

        const mine = await executeOperation<{
            mySubscriptions: { team: { slug: string }; enabled: boolean }[]
        }>({ query: '{ mySubscriptions { team { slug } enabled } }' }, { token: a.accessToken })
        expect(mine.data?.mySubscriptions.map((s) => s.team.slug)).toEqual(['bc', 'calgary'])

        const theirs = await executeOperation<{ mySubscriptions: unknown[] }>(
            { query: '{ mySubscriptions { id } }' },
            { token: b.accessToken },
        )
        expect(theirs.data?.mySubscriptions).toEqual([])

        const un = await executeOperation<{ unsubscribe: { enabled: boolean } }>(
            { query: 'mutation { unsubscribe(teamSlug: "calgary") { enabled } }' },
            { token: a.accessToken },
        )
        expect(un.data?.unsubscribe.enabled).toBe(false)
        // Subscribing again flips the same row back rather than adding one.
        await executeOperation(
            { query: 'mutation { subscribe(teamSlug: "calgary") { id } }' },
            { token: a.accessToken },
        )
        expect(await db.notificationSubscription.count()).toBe(2)
    })

    it('rejects an unknown club', async () => {
        const a = await register()
        const r = await executeOperation(
            { query: 'mutation { subscribe(teamSlug: "nope") { id } }' },
            { token: a.accessToken },
        )
        expect(code(r)).toBe('NOT_FOUND')
    })

    it('honours a signed unsubscribe link without a session, once', async () => {
        await seedTeams()
        const a = await register()
        await executeOperation(
            { query: 'mutation { subscribe(teamSlug: "calgary") { id } }' },
            { token: a.accessToken },
        )
        const token = signUnsubscribeToken(a.account.uuid, 'calgary')
        const q = `mutation ($t: String!) { unsubscribeWithToken(token: $t) }`

        const first = await executeOperation<{ unsubscribeWithToken: boolean }>({
            query: q,
            variables: { t: token },
        })
        expect(first.errors).toBeUndefined()
        expect(first.data?.unsubscribeWithToken).toBe(true)
        const row = await db.notificationSubscription.findFirstOrThrow()
        expect(row.enabled).toBe(false)

        const second = await executeOperation<{ unsubscribeWithToken: boolean }>({
            query: q,
            variables: { t: token },
        })
        expect(second.data?.unsubscribeWithToken).toBe(false)

        const forged = await executeOperation({
            query: q,
            variables: { t: token.replace('calgary', 'bc') },
        })
        expect(code(forged)).toBe('BAD_USER_INPUT')
    })
})
