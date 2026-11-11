import { describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import { checkTeam } from '~/services/depthCharts/checkTeam.server'
import { rederiveChartWeeks } from '~/services/depthCharts/chartWeek.server'

// 2026 as Tuesday–Monday gameweeks (week 1 = June 2–8), the first `complete`
// ones marked so: what the Game Zone sync leaves in the table. Inserted
// newest first, so a row's id is NOT its week — the ordinal comes from the
// dates. Returns the ids indexed by week - 1.
async function seedGameweeks(completeThrough = 21) {
    const ids: number[] = []
    for (let i = 20; i >= 0; i--) {
        const gw = await db.gameweek.create({
            data: {
                gameZoneId: 100 + i,
                name: `Week ${i + 1}`,
                status: i < completeThrough ? 'complete' : 'upcoming',
                year: 2026,
                startDate: new Date(Date.UTC(2026, 5, 2 + 7 * i, 16)),
                endDate: new Date(Date.UTC(2026, 5, 8 + 7 * i, 23)),
            },
        })
        ids[i] = gw.id
    }
    return ids
}

const team = (abbreviation: string) =>
    db.team.create({ data: { slug: abbreviation.toLowerCase(), abbreviation, name: abbreviation } })

describe('rederiveChartWeeks', () => {
    async function seed() {
        const gameweeks = await seedGameweeks()
        const ssk = await team('SSK')
        const wpg = await team('WPG')
        const cgy = await team('CGY')
        // The Labour Day Classic, in gameweek 14 (row id 8).
        await db.match.create({
            data: {
                gameZoneId: 1,
                gameweekId: gameweeks[13],
                homeTeamId: ssk.id,
                awayTeamId: wpg.id,
                status: 'complete',
                year: 2026,
                date: new Date('2026-09-06T20:00:00Z'),
            },
        })
        const chart = async (teamId: number, title: string, season: string, week: number) => {
            const list = await db.depthChartList.upsert({
                where: { teamId_year: { teamId, year: 2026 } },
                update: {},
                create: { teamId, year: 2026 },
            })
            return db.depthChart.create({
                data: {
                    teamId,
                    depthChartListId: list.id,
                    title,
                    value: `https://example.test/${encodeURIComponent(title)}.pdf`,
                    year: 2026,
                    season,
                    week,
                },
            })
        }
        // As the November 2026 backfill stored them: the week they were seen.
        const ldc = await chart(ssk.id, 'Week 14 (LDC), Sunday, Sept 6, WPG @ SSK', 'post', 21)
        const wsf = await chart(
            ssk.id,
            'Western Semi-Final, Saturday, Oct 31, SSK @ BC',
            'post',
            21,
        )
        const blank = await chart(ssk.id, 'Depth chart', 'regular', 7)
        const right = await chart(ssk.id, 'Week 3, Saturday, June 20, SSK @ CGY', 'regular', 3)
        const cgyChart = await chart(cgy.id, 'Game 12, EDM, CGY', 'post', 21)
        await db.depthChart.update({
            where: { id: cgyChart.id },
            data: { value: 'https://static.cfl.ca/260907-vsEDM-position-chart.pdf' },
        })
        for (const [position, depth] of [
            ['1S', 1],
            ['1WK', 1],
        ] as const) {
            await db.depthChartPosition.create({
                data: {
                    depthChartId: ldc.id,
                    teamId: ssk.id,
                    year: 2026,
                    week: 21,
                    position,
                    player: 'X',
                    depth,
                },
            })
        }
        return { ldc, wsf, blank, right, cgyChart }
    }

    it('reports old and new weeks with evidence and writes nothing on a dry run', async () => {
        const { ldc, wsf, blank, right, cgyChart } = await seed()
        const rows = await rederiveChartWeeks({ year: 2026, apply: false })
        const by = new Map(rows.map((r) => [r.id, r]))

        expect(by.get(ldc.id)).toMatchObject({
            old: { season: 'post', week: 21 },
            new: { season: 'regular', week: 14 },
            source: 'fixture',
            changed: true,
        })
        expect(by.get(ldc.id)!.evidence).toContain('WPG @ SSK 2026-09-06')
        expect(by.get(wsf.id)).toMatchObject({ new: { season: 'post', week: 22 }, changed: true })
        expect(by.get(blank.id)).toMatchObject({ new: null, source: null, changed: false })
        expect(by.get(right.id)).toMatchObject({ new: { week: 3 }, changed: false })
        expect(by.get(cgyChart.id)).toMatchObject({ new: { week: 14 }, changed: true })

        const stored = await db.depthChart.findMany({ select: { week: true } })
        expect(stored.map((c) => c.week).sort()).toEqual([21, 21, 21, 3, 7].sort())
        const positions = await db.depthChartPosition.findMany({ select: { week: true } })
        expect(positions.every((p) => p.week === 21)).toBe(true)
    })

    it('writes the changed charts and their positions with --apply', async () => {
        const { ldc, wsf, blank, right } = await seed()
        await rederiveChartWeeks({ year: 2026, apply: true })

        const get = (id: number) =>
            db.depthChart.findUniqueOrThrow({ where: { id }, select: { season: true, week: true } })
        expect(await get(ldc.id)).toEqual({ season: 'regular', week: 14 })
        expect(await get(wsf.id)).toEqual({ season: 'post', week: 22 })
        expect(await get(blank.id)).toEqual({ season: 'regular', week: 7 })
        expect(await get(right.id)).toEqual({ season: 'regular', week: 3 })
        const positions = await db.depthChartPosition.findMany({ select: { week: true } })
        expect(positions.map((p) => p.week)).toEqual([14, 14])

        // Idempotent: a second pass finds nothing left to change.
        const again = await rederiveChartWeeks({ year: 2026, apply: true })
        expect(again.filter((r) => r.changed)).toEqual([])
    })

    it('limits itself to one club with team', async () => {
        await seed()
        const rows = await rederiveChartWeeks({ year: 2026, team: 'CGY', apply: true })
        expect(rows.map((r) => r.team)).toEqual(['CGY'])
        expect(await db.depthChart.count({ where: { week: 21 } })).toBe(2)
    })
})

describe('checkTeam stamps new charts with their game week', () => {
    const page = (rows: [string, string][]) =>
        '<table>' +
        rows
            .map(
                ([title, href]) =>
                    `<tr><td>${title}</td><td></td><td></td><td></td><td><a href="${href}">PDF</a></td></tr>`,
            )
            .join('') +
        '</table>'
    const serve = (html: string) =>
        (async (input: string | URL | Request) =>
            new Response(String(input).endsWith('.pdf') ? '%PDF-1.7' : html, {
                status: 200,
            })) as unknown as typeof fetch

    it('reads the week from the chart, and falls back to the week it was seen', async () => {
        // Gameweeks 1–15 complete, so "now" (first not complete) is week 16.
        await seedGameweeks(15)
        const cgy = await team('CGY')
        await db.teamSource.create({
            data: {
                teamId: cgy.id,
                kind: 'depth-chart',
                url: 'https://stampeders.com/charts',
                strategy: 'tableRowCells',
                config: { titleCells: [0], linkCell: 4, minCells: 5 },
            },
        })
        const first: [string, string] = ['Game 1, WPG, CGY', '/260605-vsWPG-position-chart.pdf']
        await checkTeam(cgy.id, 2026, serve(page([first])))

        const r = await checkTeam(
            cgy.id,
            2026,
            serve(
                page([
                    first,
                    ['Game 12, EDM, CGY', '/260907-vsEDM-position-chart.pdf'],
                    ['Depth chart', '/chart.pdf'],
                ]),
            ),
        )
        expect(r.addedCount).toBe(2)
        const charts = await db.depthChart.findMany({
            select: { title: true, season: true, week: true },
            orderBy: { id: 'asc' },
        })
        expect(charts).toEqual([
            { title: 'Game 12, EDM, CGY', season: 'regular', week: 14 },
            // Says nothing about its game: the week it was first seen.
            { title: 'Depth chart', season: expect.any(String), week: 16 },
        ])
    })
})
