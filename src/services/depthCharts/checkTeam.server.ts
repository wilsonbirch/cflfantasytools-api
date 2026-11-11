import { db } from '~/lib/db.server'
import { isPermanentError } from '~/lib/jobErrors.server'
import { logger } from '~/lib/logger.server'
import { weeksForNewCharts } from './chartWeek.server'
import { archiveChartFiles } from './archiveFiles.server'
import { diffSnapshot } from './diffSnapshot.server'
import { parseChartPositions } from './parsePositions.server'
import {
    extract,
    isStrategy,
    type ArticleListConfig,
    type DepthChartItem,
} from './scrape/extractors'
import { fetchPage } from './scrape/fetchPage.server'
import { resolveArticlePdfs } from './scrape/resolveArticles.server'

const fileName = 'services/depthCharts/checkTeam'

export type CheckResult = {
    teamId: number
    status: 'OK' | 'FAILED' | 'REJECTED'
    itemCount: number
    addedCount: number
    /** Charts whose PDF changed under an unchanged href. */
    revisedCount: number
    error?: string
    /**
     * On FAILED: retrying cannot help (the page answered 4xx, or the source
     * is misconfigured), so the job should fail without the retry ladder.
     */
    permanent?: boolean
}

const asItems = (value: unknown): DepthChartItem[] | null =>
    Array.isArray(value) ? (value as DepthChartItem[]) : null

// A club posts one or two charts a week. More than this many new charts in a
// single scrape is not news — it is a backfill: a club re-hosting its PDFs on
// a new site (every URL changes), or a scraper fixed after an outage catching
// up on the weeks it missed. Both happened together in November 2026. The
// charts are still recorded and archived; subscribers are just not emailed
// about a burst of stale ones.
export const BACKFILL_THRESHOLD = 3

export const BROWSER_REMOVED =
    'browser scraping was removed, but this source still has requiresBrowser set: ' +
    'clear it (scripts/syncTeamSourceConfig.ts or updateTeamSource) and check the ' +
    'page is server-rendered'

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
    const fail = async (
        error: string,
        status: 'FAILED' | 'REJECTED' = 'FAILED',
        permanent = false,
    ): Promise<CheckResult> => {
        await db.scrapeRun.update({
            where: { id: run.id },
            data: { status, error, finishedAt: new Date() },
        })
        logger.warn(
            fileName,
            `team ${teamId}: ${status}${permanent ? ' (permanent)' : ''} — ${error}`,
        )
        return { teamId, status, itemCount: 0, addedCount: 0, revisedCount: 0, error, permanent }
    }

    // Configuration problems: the same row gives the same answer on every retry.
    const source = await db.teamSource.findFirst({ where: { teamId, kind: 'depth-chart' } })
    if (!source) return fail('no depth-chart source configured', 'FAILED', true)
    if (!source.enabled) return fail('source disabled', 'FAILED', true)
    if (!isStrategy(source.strategy)) {
        return fail(`unknown strategy "${source.strategy}"`, 'FAILED', true)
    }
    // The column outlives the feature until a later migration drops it. A row
    // still flagged was configured for a client-rendered page; scraping it with
    // a plain fetch would quietly read the wrong markup, so refuse instead.
    // Permanent like the other config failures: no retry clears the flag.
    if (source.requiresBrowser) return fail(BROWSER_REMOVED, 'FAILED', true)

    const list = await db.depthChartList.findUnique({ where: { teamId_year: { teamId, year } } })
    const previous = list ? asItems(list.value) : null

    let items: DepthChartItem[]
    try {
        const doc = await fetchPage(source.url, fetchImpl)
        items = extract(doc, source.strategy, source.config, new URL(source.url).origin)
        if (source.strategy === 'articleList') {
            items = await resolveArticlePdfs(
                items,
                previous,
                source.config as unknown as ArticleListConfig,
                fetchImpl,
            )
        }
    } catch (err) {
        // A 4xx on the listing page (lib/jobErrors) is permanent; a timeout,
        // network error or 5xx is not.
        return fail(
            err instanceof Error ? err.message : String(err),
            'FAILED',
            isPermanentError(err),
        )
    }

    const verdict = diffSnapshot(previous, items)

    if (verdict.kind === 'rejected') {
        // Deliberately do NOT overwrite the snapshot: a bad scrape must not
        // become the new baseline, or the next run would read as a mass posting.
        return fail(verdict.reason, 'REJECTED')
    }

    const added = verdict.kind === 'first-snapshot' ? [] : verdict.diff.added

    // Each chart's week is read from what the club printed — the game's date,
    // matched to the schedule (chartWeek.ts has the precedence). The week it
    // was first SEEN is only the fallback for a chart that says nothing: a
    // chart found late, as in the November 2026 backfill, belongs to its game,
    // not to the week the scraper caught up.
    const weeks = await weeksForNewCharts(teamId, year, added)

    await db.$transaction(async (tx) => {
        const saved = await tx.depthChartList.upsert({
            where: { teamId_year: { teamId, year } },
            update: { value: items },
            create: { teamId, year, value: items },
        })
        for (const [i, item] of added.entries()) {
            const { season, week } = weeks[i]
            await tx.depthChart.create({
                data: {
                    teamId,
                    depthChartListId: saved.id,
                    title: item.title,
                    value: item.href,
                    year,
                    season,
                    week,
                },
            })
        }
    })

    // After the snapshot is safely stored: archive the PDFs of anything new and
    // re-check the newest few for an in-place replacement. Its own failures are
    // logged inside and never fail the scrape.
    const files = await archiveChartFiles(teamId, year, fetchImpl)
    // ...and read the receiver alignment off anything newly archived. Status is
    // recorded per chart; a club whose layout cannot be read is UNSUPPORTED.
    const positions = await parseChartPositions(teamId, year)

    await db.scrapeRun.update({
        where: { id: run.id },
        data: {
            status: 'OK',
            itemCount: items.length,
            addedCount: added.length,
            revisedCount: files.revised,
            finishedAt: new Date(),
        },
    })

    // Something a subscriber cares about happened: fan the alert out as its own
    // job so a Resend outage retries without re-scraping, keyed by this run so
    // a retry cannot double-send. A first snapshot is a backfill, not news, and
    // so is a burst of more than BACKFILL_THRESHOLD charts at once.
    const backfill = added.length > BACKFILL_THRESHOLD
    if (backfill) {
        logger.info(
            fileName,
            `team ${teamId}: ${added.length} new charts at once — treated as a backfill, no alert`,
        )
    }
    // A re-hosted chart was merged into its original during archiving; it is
    // not a posting, so it does not count toward an alert.
    const fresh = Math.max(0, added.length - files.rehosted)
    if (verdict.kind !== 'first-snapshot' && !backfill && (fresh > 0 || files.revised > 0)) {
        const { jobEnqueue } = await import('~/dao/job.server')
        await jobEnqueue('chart-alert', {
            teamId,
            scrapeRunId: run.id,
            added: fresh,
            revised: files.revised,
        })
    }

    logger.info(
        fileName,
        `team ${teamId}: ${verdict.kind}, ${items.length} items, ${added.length} new, ` +
            `${files.archived} archived, ${files.rehosted} re-hosted, ${files.revised} revised, ` +
            `${files.failed} fetch failures, ` +
            `${positions.ok}/${positions.parsed} charts parsed`,
    )
    return {
        teamId,
        status: 'OK',
        itemCount: items.length,
        addedCount: added.length,
        revisedCount: files.revised,
    }
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
