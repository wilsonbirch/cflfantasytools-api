import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import { __setAppSecretForTest, signUnsubscribeToken } from '~/lib/signedLinks.server'
import { sendChartAlert } from '~/services/email/chartAlert.server'

// The Resend API is never hit: fetch is injected, and what the service sends
// over it is exactly what these tests assert on.

let teamId: number

beforeEach(async () => {
    process.env.RESEND_API_KEY = 'test-key'
    process.env.RESEND_FROM_EMAIL = 'CFL Fantasy Tools <alerts@alerts.example.com>'
    __setAppSecretForTest('test-secret')
    const team = await db.team.create({
        data: { slug: 'calgary-stampeders', abbreviation: 'CGY', name: 'Calgary Stampeders' },
    })
    teamId = team.id
    let n = 0
    for (const email of ['a@example.com', 'b@example.com']) {
        const account = await db.account.create({
            data: { email, password: 'x', uuid: `uuid-${(n += 1)}` },
        })
        await db.notificationSubscription.create({
            data: { accountId: account.id, teamId, enabled: true },
        })
    }
    // A disabled subscriber must never be emailed.
    const off = await db.account.create({
        data: { email: 'off@example.com', password: 'x', uuid: 'uuid-off' },
    })
    await db.notificationSubscription.create({
        data: { accountId: off.id, teamId, enabled: false },
    })
})

afterEach(() => {
    delete process.env.RESEND_API_KEY
    delete process.env.RESEND_FROM_EMAIL
})

type Sent = { url: string; headers: Record<string, string>; body: unknown[] }

const capture = (sent: Sent[], status = 200) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as unknown[]
        sent.push({
            url: String(input),
            headers: (init?.headers ?? {}) as Record<string, string>,
            body,
        })
        return status === 200
            ? new Response(
                  JSON.stringify({ data: body.map((_, i) => ({ id: `re_${sent.length}_${i}` })) }),
                  { status: 200 },
              )
            : new Response('{"message":"nope"}', { status })
    }) as unknown as typeof fetch

describe('sendChartAlert', () => {
    it('emails every enabled subscriber once and records the Resend ids', async () => {
        const sent: Sent[] = []
        const summary = await sendChartAlert(teamId, 101, 1, 0, capture(sent))
        expect(summary).toMatchObject({ skipped: false, queued: 2, sent: 2, failed: 0 })

        expect(sent).toHaveLength(1)
        const emails = sent[0].body as {
            to: string
            subject: string
            text: string
            headers?: Record<string, string>
        }[]
        expect(emails.map((e) => e.to).sort()).toEqual(['a@example.com', 'b@example.com'])
        expect(emails[0].subject).toBe('Calgary Stampeders posted a new depth chart')
        expect(sent[0].headers['idempotency-key']).toMatch(/^chart-alert:\d+:101:/)

        // The unsubscribe link is the signed token, present in text and header.
        const a = emails.find((e) => e.to === 'a@example.com')!
        expect(a.text).toContain(
            `/unsubscribe?token=${signUnsubscribeToken('uuid-1', 'calgary-stampeders')}`,
        )
        expect(a.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')

        const rows = await db.emailDelivery.findMany({ orderBy: { id: 'asc' } })
        expect(rows).toHaveLength(2)
        expect(rows.every((r) => r.status === 'SENT' && r.resendId)).toBe(true)
    })

    it('is idempotent: a retried job sends nothing new', async () => {
        const sent: Sent[] = []
        await sendChartAlert(teamId, 101, 1, 0, capture(sent))
        const second = await sendChartAlert(teamId, 101, 1, 0, capture(sent))
        expect(second).toMatchObject({ queued: 0, sent: 0 })
        expect(sent).toHaveLength(1)
        expect(await db.emailDelivery.count()).toBe(2)
    })

    it('records a failed batch as FAILED with the error, and does not retry it', async () => {
        const sent: Sent[] = []
        const summary = await sendChartAlert(teamId, 101, 0, 1, capture(sent, 500))
        expect(summary).toMatchObject({ sent: 0, failed: 2 })
        const rows = await db.emailDelivery.findMany()
        expect(rows.every((r) => r.status === 'FAILED' && r.error?.includes('500'))).toBe(true)

        // FAILED is terminal for the batch: a retry re-queues nothing.
        const retry = await sendChartAlert(teamId, 101, 0, 1, capture(sent))
        expect(retry).toMatchObject({ queued: 0, sent: 0 })
    })

    it('skips entirely when sending is not configured', async () => {
        delete process.env.RESEND_API_KEY
        const summary = await sendChartAlert(teamId, 101, 1, 0, capture([]))
        expect(summary.skipped).toBe(true)
        expect(await db.emailDelivery.count()).toBe(0)
    })
})
