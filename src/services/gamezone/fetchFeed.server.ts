import { createHash } from 'node:crypto'
import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import { FEED_SCHEMAS, feedUrl, type FeedSource } from './feeds'

const fileName = 'services/gamezone/fetchFeed'

export type FeedFetchResult<T> =
    | { status: 'OK'; items: T[]; sha256: string }
    // The payload is byte-identical to the last successful pull; most syncs land
    // here, which is what makes an hourly cadence cheap.
    | { status: 'UNCHANGED'; sha256: string }
    // Reached the feed but it did not match the expected shape. Callers must
    // leave existing rows alone — a malformed feed is not evidence of change.
    | { status: 'INVALID'; error: string; sha256: string }
    | { status: 'FETCH_FAILED'; error: string }

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

async function lastGoodHash(source: FeedSource): Promise<string | null> {
    const row = await db.feedSnapshot.findFirst({
        where: { source, status: 'OK' },
        orderBy: { fetchedAt: 'desc' },
        select: { sha256: true },
    })
    return row?.sha256 ?? null
}

/**
 * Fetch one feed, validate it, and record the attempt.
 *
 * Every outcome writes a FeedSnapshot, so "the feed went away three days ago"
 * is answerable from the database rather than from logs that have rotated.
 */
export async function fetchFeed<S extends FeedSource>(
    source: S,
    fetchImpl: typeof fetch = fetch,
): Promise<FeedFetchResult<unknown>> {
    let body: string
    try {
        const res = await fetchImpl(feedUrl(source), {
            headers: { 'accept-encoding': 'gzip', accept: 'application/json' },
            signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        body = await res.text()
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        logger.warn(fileName, `${source}: fetch failed — ${error}`)
        await db.feedSnapshot.create({
            data: { source, sha256: '', status: 'FETCH_FAILED', error },
        })
        return { status: 'FETCH_FAILED', error }
    }

    const sha256 = sha(body)
    if (sha256 === (await lastGoodHash(source))) {
        await db.feedSnapshot.create({ data: { source, sha256, status: 'UNCHANGED' } })
        return { status: 'UNCHANGED', sha256 }
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(body)
    } catch (err) {
        const error = `not JSON: ${err instanceof Error ? err.message : String(err)}`
        await db.feedSnapshot.create({ data: { source, sha256, status: 'INVALID', error } })
        return { status: 'INVALID', error, sha256 }
    }

    const result = FEED_SCHEMAS[source].safeParse(parsed)
    if (!result.success) {
        // Keep the payload: diagnosing an upstream shape change after the fact is
        // the whole reason this table stores one.
        const error = result.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')
        logger.error(fileName, `${source}: shape changed — ${error}`)
        await db.feedSnapshot.create({
            data: { source, sha256, status: 'INVALID', error, payload: parsed as object },
        })
        return { status: 'INVALID', error, sha256 }
    }

    const items = result.data as unknown[]
    await db.feedSnapshot.create({
        data: { source, sha256, status: 'OK', itemCount: items.length },
    })
    logger.info(fileName, `${source}: ${items.length} items, changed`)
    return { status: 'OK', items, sha256 }
}
