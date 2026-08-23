import { createHash } from 'node:crypto'
import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'

const fileName = 'services/depthCharts/archiveFiles'

// How often an already-archived chart is re-fetched to see whether the club
// replaced the file under the same href, and how many of a club's newest
// charts get that treatment. A replacement happens to THIS week's chart, not
// to one from June, so re-checking the newest few every six hours catches it
// while keeping the per-club cost to a handful of requests a day.
export const RECHECK_AFTER_MS = 6 * 60 * 60 * 1000
export const RECHECK_NEWEST = 3

// A chart PDF is a few hundred KB; the largest seen is under 1MB. Anything
// bigger is not a chart, and must not be stored.
const MAX_BYTES = 10 * 1024 * 1024

const USER_AGENT = 'Mozilla/5.0 (compatible; cflfantasytools/1.0; +https://cflfantasytools.ca)'

export type ArchiveSummary = {
    fetched: number
    /** Charts archived for the first time. */
    archived: number
    /** Charts whose bytes changed under an unchanged href. */
    revised: number
    failed: number
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

async function fetchPdf(
    url: string,
    fetchImpl: typeof fetch,
): Promise<{ bytes: Buffer; contentType: string }> {
    const res = await fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/pdf,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0) throw new Error('empty body')
    if (bytes.length > MAX_BYTES) throw new Error(`body too large (${bytes.length} bytes)`)
    const contentType = (res.headers.get('content-type') ?? 'application/pdf').split(';')[0].trim()
    return { bytes, contentType }
}

/**
 * Fetch and archive the PDFs of a club's charts for one season.
 *
 * Every chart without an archived copy is fetched; the newest RECHECK_NEWEST
 * charts are re-fetched once their last check is older than RECHECK_AFTER_MS.
 * A fetch that returns different bytes from the newest archived copy is stored
 * as a NEW version — the silent in-place replacement that href-based change
 * detection could never see. Identical bytes only bump `checkedAt`.
 *
 * A failed fetch is logged and skipped, never thrown: the club's site being slow
 * to serve a PDF must not fail the scrape that just recorded the chart. With no
 * file row written the chart is simply "new" again on the next sweep.
 */
export async function archiveChartFiles(
    teamId: number,
    year: number,
    fetchImpl: typeof fetch = fetch,
    now = new Date(),
): Promise<ArchiveSummary> {
    const summary: ArchiveSummary = { fetched: 0, archived: 0, revised: 0, failed: 0 }

    const charts = await db.depthChart.findMany({
        where: { teamId, year },
        select: {
            id: true,
            value: true,
            files: {
                select: { id: true, sha256: true, checkedAt: true },
                orderBy: { fetchedAt: 'desc' },
                take: 1,
            },
        },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    })

    const due = charts.filter((c, i) => {
        const latest = c.files[0]
        if (!latest) return true
        return i < RECHECK_NEWEST && now.getTime() - latest.checkedAt.getTime() >= RECHECK_AFTER_MS
    })

    for (const chart of due) {
        const latest = chart.files[0]
        let fetched: Awaited<ReturnType<typeof fetchPdf>>
        try {
            fetched = await fetchPdf(chart.value, fetchImpl)
        } catch (err) {
            summary.failed += 1
            logger.warn(
                fileName,
                `chart ${chart.id}: fetch failed — ${err instanceof Error ? err.message : String(err)}`,
            )
            continue
        }
        summary.fetched += 1
        const hash = sha256(fetched.bytes)

        if (latest && latest.sha256 === hash) {
            await db.depthChartFile.update({ where: { id: latest.id }, data: { checkedAt: now } })
            continue
        }

        // Same bytes seen before under this chart (a club flipping back to an
        // earlier file) is not a new version either; it is that version, checked.
        const known = await db.depthChartFile.findUnique({
            where: { depthChartId_sha256: { depthChartId: chart.id, sha256: hash } },
            select: { id: true },
        })
        if (known) {
            await db.depthChartFile.update({ where: { id: known.id }, data: { checkedAt: now } })
            continue
        }

        await db.depthChartFile.create({
            data: {
                depthChartId: chart.id,
                sha256: hash,
                bytes: new Uint8Array(fetched.bytes),
                size: fetched.bytes.length,
                contentType: fetched.contentType,
                fetchedAt: now,
                checkedAt: now,
            },
        })
        if (latest) {
            summary.revised += 1
            // The chart changed, even though its link did not: bump it so the
            // list re-sorts and anything watching updatedAt sees the revision.
            await db.depthChart.update({ where: { id: chart.id }, data: { publishedAt: now } })
            logger.info(fileName, `chart ${chart.id}: replaced in place (${hash.slice(0, 12)})`)
        } else {
            summary.archived += 1
        }
    }

    return summary
}
