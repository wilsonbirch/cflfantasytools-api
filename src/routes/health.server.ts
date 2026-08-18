import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * GET /health — the Fly http_service check target.
 *
 * Deliberately does NOT touch the database. A health check is asking "should
 * traffic reach this machine"; a transient DB blip should not take the web
 * process out of rotation and turn a slow query into an outage. The GraphQL
 * `isUp` field is the DB-reachability probe, and boot-smoke asserts that one.
 */
export function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
}
