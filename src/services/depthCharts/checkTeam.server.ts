import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import { getDepthChartInfo } from './season.server'
import { diffSnapshot } from './diffSnapshot.server'
import { extract, isStrategy, type DepthChartItem } from './scrape/extractors'
import { fetchPage } from './scrape/fetchPage.server'

const fileName = 'services/depthCharts/checkTeam'

export type CheckResult = {
    teamId: number
    status: 'OK' | 'FAILED' | 'REJECTED'
    itemCount: number
    addedCount: number
    error?: string
}

const asItems = (value: unknown): DepthChartItem[] | null =>
    Array.isArray(value) ? (value as DepthChartItem[]) : null

/**
 * Scrape one club, diff against its last snapshot, and persist what changed.
 *
 * Every attempt writes a ScrapeRun. That row is what makes a club redesigning
 * its site a visible event rather than a chart feed that quietly stops updating
 * — the failure mode nobody notices until they go looking.
 */
export async function checkTeam(
    teamId: number,
    year: number,
    fetchImpl: typeof fetch = fetch,
): Promise<CheckResult> {
    const run = await db.scrapeRun.create({ data: { teamId, status: 'FAILED' } })
    const fail = async (error: string, status: 'FAILED' | 'REJECTED' = 'FAILED') => {
        await db.scrapeRun.update({
            where: { id: run.id },
            data: { status, error, finishedAt: new Date() },
        })
        logger.warn(fileName, `team ${teamId}: ${status} — ${error}`)
        return { teamId, status, itemCount: 0, addedCount: 0, error }
    }

    const source = await db.teamSource.findFirst({ where: { teamId, kind: 'depth-chart' } })
    if (!source) return fail('no depth-chart source configured')
    if (!source.enabled) return fail('source disabled')
    if (!isStrategy(source.strategy)) return fail(`unknown strategy "${source.strategy}"`)

    let items: DepthChartItem[]
    try {
        const doc = await fetchPage(source.url, source.requiresBrowser, fetchImpl)
        items = extract(doc, source.strategy, source.config, new URL(source.url).origin)
    } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
    }

    const list = await db.depthChartList.findUnique({ where: { teamId_year: { teamId, year } } })
    const verdict = diffSnapshot(list ? asItems(list.value) : null, items)

    if (verdict.kind === 'rejected') {
        // Deliberately do NOT overwrite the snapshot: a bad scrape must not
        // become the new baseline, or the next run would read as a mass posting.
        return fail(verdict.reason, 'REJECTED')
    }

    const info = getDepthChartInfo(new Date())
    const added = verdict.kind === 'first-snapshot' ? [] : verdict.diff.added

    await db.$transaction(async (tx) => {
        const saved = await tx.depthChartList.upsert({
            where: { teamId_year: { teamId, year } },
            update: { value: items },
            create: { teamId, year, value: items },
        })
        for (const item of added) {
            await tx.depthChart.create({
                data: {
                    teamId,
                    depthChartListId: saved.id,
                    title: item.title,
                    value: item.href,
                    year,
                    season: info.season,
                    week: info.week,
                },
            })
        }
    })

    await db.scrapeRun.update({
        where: { id: run.id },
        data: {
            status: 'OK',
            itemCount: items.length,
            addedCount: added.length,
            finishedAt: new Date(),
        },
    })

    logger.info(
        fileName,
        `team ${teamId}: ${verdict.kind}, ${items.length} items, ${added.length} new`,
    )
    return { teamId, status: 'OK', itemCount: items.length, addedCount: added.length }
}

/** Fan out one job per enabled club so a single failing site cannot block the rest. */
export async function sweepAllTeams(year: number): Promise<number> {
    const sources = await db.teamSource.findMany({
        where: { kind: 'depth-chart', enabled: true },
        select: { teamId: true },
    })
    const { jobEnqueue } = await import('~/dao/job.server')
    for (const s of sources) await jobEnqueue('depth-chart-team', { teamId: s.teamId, year })
    logger.info(fileName, `enqueued ${sources.length} per-team depth chart checks`)
    return sources.length
}
