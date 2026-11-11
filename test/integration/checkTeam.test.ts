import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import {
    BACKFILL_THRESHOLD,
    checkTeam,
    sweepAllTeams,
} from '~/services/depthCharts/checkTeam.server'

const CGY = readFileSync('test/fixtures/depth-charts/calgary-stampeders.html', 'utf8')

const serve = (html: string, status = 200) =>
    (async () => new Response(html, { status })) as unknown as typeof fetch

async function seedTeam(overrides: Record<string, unknown> = {}) {
    const team = await db.team.create({
        data: { slug: 'calgary-stampeders', abbreviation: 'CGY', name: 'Calgary Stampeders' },
    })
    await db.teamSource.create({
        data: {
            teamId: team.id,
            kind: 'depth-chart',
            url: 'https://www.stampeders.com/game-notes/',
            strategy: 'tableRowCells',
            config: { titleCells: [0, 1, 2], linkCell: 4, minCells: 5 },
            ...overrides,
        },
    })
    return team
}

/** Forget the last n items of the stored snapshot, so the next scrape sees them as new. */
async function dropFromSnapshot(n: number) {
    const list = await db.depthChartList.findFirstOrThrow()
    const items = list.value as { title: string; href: string }[]
    await db.depthChartList.update({ where: { id: list.id }, data: { value: items.slice(0, -n) } })
}

describe('checkTeam', () => {
    it('records the first snapshot without creating chart rows', async () => {
        const team = await seedTeam()
        const r = await checkTeam(team.id, 2026, serve(CGY))

        expect(r.status).toBe('OK')
        expect(r.itemCount).toBeGreaterThan(3)
        // Silent first run — otherwise every subscriber hears about every chart
        // already on the page.
        expect(r.addedCount).toBe(0)
        expect(await db.depthChart.count()).toBe(0)
        expect(await db.depthChartList.count()).toBe(1)
    })

    it('creates a chart row for something genuinely new', async () => {
        const team = await seedTeam()
        await checkTeam(team.id, 2026, serve(CGY))

        // Drop one item from the stored snapshot so the next scrape sees it as new.
        const list = await db.depthChartList.findFirstOrThrow()
        const items = list.value as { title: string; href: string }[]
        await db.depthChartList.update({
            where: { id: list.id },
            data: { value: items.slice(0, -1) },
        })

        const r = await checkTeam(team.id, 2026, serve(CGY))
        expect(r.addedCount).toBe(1)
        const chart = await db.depthChart.findFirstOrThrow()
        expect(chart.value).toBe(items.at(-1)?.href)
    })

    it('alerts subscribers about a single genuinely new chart', async () => {
        const team = await seedTeam()
        await checkTeam(team.id, 2026, serve(CGY))
        await dropFromSnapshot(1)

        await checkTeam(team.id, 2026, serve(CGY))
        expect(await db.job.count({ where: { kind: 'chart-alert' } })).toBe(1)
    })

    it('treats a burst of new charts as a backfill: recorded and archived, but no alert', async () => {
        // A club re-hosting its PDFs, or the scraper catching up after an
        // outage — November 2026 was both. Emailing about each would be spam.
        const team = await seedTeam()
        await checkTeam(team.id, 2026, serve(CGY))
        await dropFromSnapshot(BACKFILL_THRESHOLD + 2)

        const r = await checkTeam(team.id, 2026, serve(CGY))
        expect(r.addedCount).toBe(BACKFILL_THRESHOLD + 2)
        expect(await db.depthChart.count()).toBe(BACKFILL_THRESHOLD + 2)
        expect(await db.job.count({ where: { kind: 'chart-alert' } })).toBe(0)
    })

    it('resolves an article-per-chart club to the PDFs inside the articles', async () => {
        const listing =
            '<a href="/article/11-07-2026-depth-chart-vs-bc"><p class="t">VS BC</p></a>' +
            '<a href="/article/10-24-2026-depth-chart-at-ssk"><p class="t">AT SSK</p></a>'
        const pages: Record<string, string> = {
            'https://goelks.com/depth-chart-updates': listing,
            'https://goelks.com/article/11-07-2026-depth-chart-vs-bc':
                '<a href="https://static.cfl.ca/1107-vs-BC.pdf">View Depth Chart</a>',
            'https://goelks.com/article/10-24-2026-depth-chart-at-ssk':
                '<a href="https://static.cfl.ca/1024-at-SSK.pdf">View Depth Chart</a>',
        }
        const site = (async (input: string | URL | Request) =>
            new Response(pages[String(input)] ?? '%PDF-1.7', {
                status: 200,
            })) as unknown as typeof fetch
        const team = await seedTeam({
            url: 'https://goelks.com/depth-chart-updates',
            strategy: 'articleList',
            config: { linkHrefMatch: '/article/[^/]*depth-chart', titleSelector: 'p.t' },
        })

        const r = await checkTeam(team.id, 2026, site)
        expect(r.status).toBe('OK')
        const list = await db.depthChartList.findFirstOrThrow()
        expect((list.value as { href: string }[]).map((i) => i.href)).toEqual([
            'https://static.cfl.ca/1107-vs-BC.pdf',
            'https://static.cfl.ca/1024-at-SSK.pdf',
        ])
    })

    it('creates nothing on a repeat scrape', async () => {
        const team = await seedTeam()
        await checkTeam(team.id, 2026, serve(CGY))
        const r = await checkTeam(team.id, 2026, serve(CGY))
        expect(r.addedCount).toBe(0)
        expect(await db.depthChart.count()).toBe(0)
    })

    it('records a ScrapeRun for every attempt, which is the health signal', async () => {
        const team = await seedTeam()
        await checkTeam(team.id, 2026, serve(CGY))
        const run = await db.scrapeRun.findFirstOrThrow()
        expect(run.status).toBe('OK')
        expect(run.finishedAt).not.toBeNull()
    })

    it('marks a failed fetch without touching the stored snapshot', async () => {
        const team = await seedTeam()
        await checkTeam(team.id, 2026, serve(CGY))
        const before = await db.depthChartList.findFirstOrThrow()

        const r = await checkTeam(team.id, 2026, serve('gone', 503))
        expect(r.status).toBe('FAILED')
        // A 503 is an outage that may clear: the job should retry.
        expect(r.permanent).toBe(false)
        const after = await db.depthChartList.findFirstOrThrow()
        // A club site being down must not become the new baseline.
        expect(after.value).toEqual(before.value)
    })

    it('marks a 404 on the listing page as permanent, and still records the ScrapeRun', async () => {
        const team = await seedTeam()
        const r = await checkTeam(team.id, 2026, serve('not found', 404))
        expect(r).toMatchObject({ status: 'FAILED', permanent: true })
        expect(r.error).toMatch(/HTTP 404/)
        const run = await db.scrapeRun.findFirstOrThrow()
        expect(run.status).toBe('FAILED')
        expect(run.error).toMatch(/HTTP 404/)
    })

    it('treats a rate limit or a network error on the listing page as retryable', async () => {
        const team = await seedTeam()
        expect((await checkTeam(team.id, 2026, serve('slow down', 429))).permanent).toBe(false)
        const offline = (async () => {
            throw new TypeError('fetch failed')
        }) as unknown as typeof fetch
        expect((await checkTeam(team.id, 2026, offline)).permanent).toBe(false)
    })

    it('REJECTS an empty page instead of wiping the snapshot', async () => {
        const team = await seedTeam()
        await checkTeam(team.id, 2026, serve(CGY))
        const before = await db.depthChartList.findFirstOrThrow()

        const r = await checkTeam(team.id, 2026, serve('<html><body>redesign</body></html>'))
        expect(r.status).toBe('REJECTED')
        const after = await db.depthChartList.findFirstOrThrow()
        expect(after.value).toEqual(before.value)

        const runs = await db.scrapeRun.findMany({ orderBy: { id: 'desc' } })
        expect(runs[0].status).toBe('REJECTED')
        expect(runs[0].error).toMatch(/no items/)
    })

    it('fails cleanly when the strategy is unknown', async () => {
        const team = await seedTeam({ strategy: 'someStrategyWeRemoved' })
        const r = await checkTeam(team.id, 2026, serve(CGY))
        expect(r.status).toBe('FAILED')
        expect(r.error).toMatch(/unknown strategy/)
        // The same row gives the same answer on every retry.
        expect(r.permanent).toBe(true)
    })

    it('skips a disabled source, permanently', async () => {
        const team = await seedTeam({ enabled: false })
        const r = await checkTeam(team.id, 2026, serve(CGY))
        expect(r).toMatchObject({ status: 'FAILED', permanent: true })
        expect(r.error).toMatch(/disabled/)
    })

    it('fails permanently when the club has no depth-chart source at all', async () => {
        const team = await db.team.create({
            data: { slug: 'no-source', abbreviation: 'NOS', name: 'No Source' },
        })
        const r = await checkTeam(team.id, 2026, serve(CGY))
        expect(r).toMatchObject({ status: 'FAILED', permanent: true })
        expect(r.error).toMatch(/no depth-chart source/)
    })

    it('fails a source still flagged requiresBrowser, without fetching or touching the snapshot', async () => {
        const team = await seedTeam({ requiresBrowser: true })
        let fetched = 0
        const counting = (async () => {
            fetched++
            return new Response(CGY)
        }) as unknown as typeof fetch

        const r = await checkTeam(team.id, 2026, counting)
        expect(r.status).toBe('FAILED')
        expect(r.error).toMatch(/browser scraping was removed/)
        expect(fetched).toBe(0)
        expect(await db.depthChartList.count()).toBe(0)
        const run = await db.scrapeRun.findFirstOrThrow()
        expect(run).toMatchObject({ status: 'FAILED', error: r.error })
    })
})

describe('sweepAllTeams', () => {
    it('enqueues one job per enabled club, not one job for all nine', async () => {
        await seedTeam()
        const t2 = await db.team.create({
            data: { slug: 'bc-lions', abbreviation: 'BC', name: 'BC Lions' },
        })
        await db.teamSource.create({
            data: { teamId: t2.id, url: 'https://x.test', strategy: 'tableRowCells' },
        })

        expect(await sweepAllTeams(2026)).toBe(2)
        // Per-club jobs mean one club's site being down cannot block the rest,
        // and each retries on its own.
        expect(await db.job.count({ where: { kind: 'depth-chart-team' } })).toBe(2)
    })
})
