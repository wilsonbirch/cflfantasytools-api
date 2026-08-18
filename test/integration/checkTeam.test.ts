import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import { checkTeam, sweepAllTeams } from '~/services/depthCharts/checkTeam.server'

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
        const after = await db.depthChartList.findFirstOrThrow()
        // A club site being down must not become the new baseline.
        expect(after.value).toEqual(before.value)
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
    })

    it('skips a disabled source', async () => {
        const team = await seedTeam({ enabled: false })
        expect((await checkTeam(team.id, 2026, serve(CGY))).error).toMatch(/disabled/)
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
