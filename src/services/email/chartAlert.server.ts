// The depth-chart change alert: one email to each enabled subscriber of a club
// when a sweep finds a new chart (or a silent in-place replacement).
//
// Idempotent by design at two layers. The batchKey (chart-alert:{teamId}:
// {scrapeRunId}) keys the fan-out: EmailDelivery rows are created once per
// recipient under it, and a retried job resumes the QUEUED remainder instead
// of re-sending what already went. Each Resend request then carries an
// idempotency key derived from the batchKey and the recipients in it, so even
// a crash between "Resend accepted" and "rows updated" cannot double-send.

import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import { signUnsubscribeToken } from '~/lib/signedLinks.server'
import { BATCH_SIZE, emailEnabled, sendBatch, type OutboundEmail } from './resend.server'

const fileName = 'services/email/chartAlert'

/** Public base for links in emails; the api serves /unsubscribe itself. */
const publicUrl = (): string =>
    (process.env.PUBLIC_API_URL ?? 'https://cflfantasytools-api.fly.dev').replace(/\/$/, '')

export type ChartAlertSummary = {
    skipped: boolean
    queued: number
    sent: number
    failed: number
}

export async function sendChartAlert(
    teamId: number,
    scrapeRunId: number,
    added: number,
    revised: number,
    fetchImpl: typeof fetch = fetch,
): Promise<ChartAlertSummary> {
    if (!emailEnabled()) {
        logger.warn(fileName, 'RESEND_API_KEY/RESEND_FROM_EMAIL not set — alert skipped')
        return { skipped: true, queued: 0, sent: 0, failed: 0 }
    }

    const team = await db.team.findUniqueOrThrow({
        where: { id: teamId },
        select: { name: true, slug: true },
    })
    const subs = await db.notificationSubscription.findMany({
        where: { teamId, enabled: true },
        select: { Account: { select: { id: true, uuid: true, email: true } } },
    })

    const batchKey = `chart-alert:${teamId}:${scrapeRunId}`
    // Resume-safe fan-out: only recipients without a row under this batchKey
    // get one. A second run of the same job creates nothing new.
    const existing = await db.emailDelivery.findMany({
        where: { batchKey },
        select: { toEmail: true },
    })
    const have = new Set(existing.map((e) => e.toEmail))
    const fresh = subs.filter((s) => !have.has(s.Account.email))
    if (fresh.length > 0) {
        await db.emailDelivery.createMany({
            data: fresh.map((s) => ({
                accountId: s.Account.id,
                kind: 'chart-alert',
                toEmail: s.Account.email,
                batchKey,
            })),
        })
    }

    const accountByEmail = new Map(subs.map((s) => [s.Account.email, s.Account]))
    const queued = await db.emailDelivery.findMany({
        where: { batchKey, status: 'QUEUED' },
        orderBy: { id: 'asc' },
        select: { id: true, toEmail: true },
    })

    const what =
        added > 0 && revised > 0
            ? `posted ${added} new depth chart(s) and replaced ${revised}`
            : added > 0
              ? `posted ${added === 1 ? 'a new depth chart' : `${added} new depth charts`}`
              : `replaced ${revised === 1 ? 'a depth chart' : `${revised} depth charts`} in place`
    const subject = `${team.name} ${added > 0 ? 'posted a new depth chart' : 'updated a depth chart'}`

    const summary: ChartAlertSummary = { skipped: false, queued: queued.length, sent: 0, failed: 0 }
    for (let i = 0; i < queued.length; i += BATCH_SIZE) {
        const chunk = queued.slice(i, i + BATCH_SIZE)
        const emails: OutboundEmail[] = chunk.map((row) => {
            const account = accountByEmail.get(row.toEmail)
            const unsubscribe = account
                ? `${publicUrl()}/unsubscribe?token=${signUnsubscribeToken(account.uuid, team.slug)}`
                : null
            return {
                to: row.toEmail,
                subject,
                text:
                    `${team.name} ${what}.\n\n` +
                    `You are receiving this because you subscribed to ${team.name} ` +
                    `depth-chart alerts on CFL Fantasy Tools.` +
                    (unsubscribe ? `\nUnsubscribe: ${unsubscribe}` : ''),
                ...(unsubscribe
                    ? {
                          headers: {
                              'List-Unsubscribe': `<${unsubscribe}>`,
                              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                          },
                      }
                    : {}),
            }
        })
        // Keyed by the chunk's own delivery ids: stable across retries even if
        // an earlier chunk's membership shifted the offsets.
        const idempotencyKey = `${batchKey}:${chunk[0].id}-${chunk[chunk.length - 1].id}`
        try {
            const ids = await sendBatch(emails, idempotencyKey, fetchImpl)
            await Promise.all(
                chunk.map((row, j) =>
                    db.emailDelivery.update({
                        where: { id: row.id },
                        data: { status: 'SENT', resendId: ids[j] || null },
                    }),
                ),
            )
            summary.sent += chunk.length
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err)
            await db.emailDelivery.updateMany({
                where: { id: { in: chunk.map((r) => r.id) } },
                data: { status: 'FAILED', error },
            })
            summary.failed += chunk.length
            logger.warn(fileName, `${batchKey}: chunk failed — ${error}`)
        }
    }

    logger.info(
        fileName,
        `${batchKey}: ${summary.sent} sent, ${summary.failed} failed of ${summary.queued} queued`,
    )
    return summary
}
