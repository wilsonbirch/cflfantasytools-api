import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import { __setAppSecretForTest, signUnsubscribeToken } from '~/lib/signedLinks.server'

// GET /unsubscribe is the link that lands in inboxes, so it is tested over the
// real http server, not by calling the handler.

let close: (() => Promise<void>) | null = null
let base = ''

afterAll(async () => {
    await close?.()
})

async function boot(): Promise<void> {
    if (close) return
    const { server } = await import('~/app')
    server.listen(0)
    await once(server, 'listening')
    close = () => new Promise((resolve) => server.close(() => resolve()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeEach(async () => {
    __setAppSecretForTest('test-secret')
    await boot()
})

describe('GET /unsubscribe', () => {
    it('disables the subscription from a signed link, without a session', async () => {
        const team = await db.team.create({
            data: { slug: 'calgary-stampeders', abbreviation: 'CGY', name: 'Calgary Stampeders' },
        })
        const account = await db.account.create({
            data: { email: 'a@example.com', password: 'x', uuid: 'uuid-1' },
        })
        await db.notificationSubscription.create({
            data: { accountId: account.id, teamId: team.id, enabled: true },
        })

        const token = signUnsubscribeToken('uuid-1', 'calgary-stampeders')
        const res = await fetch(`${base}/unsubscribe?token=${token}`)
        expect(res.status).toBe(200)
        expect(await res.text()).toContain('You are unsubscribed')

        const sub = await db.notificationSubscription.findFirstOrThrow({
            where: { accountId: account.id },
        })
        expect(sub.enabled).toBe(false)

        // RFC 8058 one-click: mail clients POST the same URL.
        const post = await fetch(`${base}/unsubscribe?token=${token}`, { method: 'POST' })
        expect(post.status).toBe(200)
    })

    it('rejects a tampered token', async () => {
        const res = await fetch(`${base}/unsubscribe?token=uuid-1.calgary-stampeders.forged`)
        expect(res.status).toBe(400)
        expect(await res.text()).toContain('did not work')
    })

    it('rejects a missing token', async () => {
        const res = await fetch(`${base}/unsubscribe`)
        // No query string at all does not match the route... but with one it must 400.
        const withQuery = await fetch(`${base}/unsubscribe?token=`)
        expect([400, 404]).toContain(res.status)
        expect(withQuery.status).toBe(400)
    })
})
