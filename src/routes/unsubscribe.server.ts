import type { ServerResponse } from 'node:http'
import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import { verifyUnsubscribeToken } from '~/lib/signedLinks.server'

const fileName = 'routes/unsubscribe'

// GET /unsubscribe?token=... — the one-click link in notification emails.
//
// Served by the api rather than the web app because no web app is deployed
// yet; a link in a sent email has to work forever, so it points at the one
// origin that exists. Also the target of the List-Unsubscribe-Post one-click
// header, which is why POST is accepted too.

const PATH = /^\/unsubscribe\?/

export const matchUnsubscribe = (url: string): string | null => {
    if (!PATH.test(url)) return null
    return new URL(url, 'http://x').searchParams.get('token')
}

const page = (title: string, body: string): string =>
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>${title}</title>` +
    `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
    `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p>`

export async function handleUnsubscribe(token: string | null, res: ServerResponse): Promise<void> {
    try {
        const claims = token ? verifyUnsubscribeToken(token) : null
        if (!claims) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
            res.end(
                page('That link did not work', 'The unsubscribe link is invalid or incomplete.'),
            )
            return
        }
        const { count } = await db.notificationSubscription.updateMany({
            where: {
                Account: { uuid: claims.accountUuid },
                Team: { slug: claims.teamSlug },
                enabled: true,
            },
            data: { enabled: false },
        })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
            page(
                count > 0 ? 'You are unsubscribed' : 'Already unsubscribed',
                'You will no longer receive depth-chart alerts for this club.',
            ),
        )
    } catch (err) {
        logger.error(fileName, err instanceof Error ? err.message : String(err))
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
        res.end(page('Something went wrong', 'Please try the link again.'))
    }
}
