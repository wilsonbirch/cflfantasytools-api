import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TEAMS } from '~/data/teams'
import { db } from '~/lib/db.server'
import { checkTeam } from '~/services/depthCharts/checkTeam.server'
import { rederiveChartWeeks } from '~/services/depthCharts/chartWeek.server'

// The real 2026 Game Zone schedule (trimmed gameweeks.json): 21 gameweeks, 81
// matches, no playoffs — loaded the way syncGameZone stores it. Gameweeks go in
// newest first, so a row's id is NOT its week: the ordinal comes from the
// dates. `completeThrough` marks that many weeks complete, the rest upcoming.
type FeedGameweek = {
    id: number
    name: string
    startDate: string
    endDate: string
    matches: {
        id: number
        homeSquad: { abbr: string }
        awaySquad: { abbr: string }
        date: string
    }[]
}
const FEED = JSON.parse(
    readFileSync('test/fixtures/gamezone/gameweeks-2026.json', 'utf8'),
) as FeedGameweek[]

async function seedRealSchedule(completeThrough = 21) {
    const teams = new Map<string, number>()
    for (const t of TEAMS) teams.set(t.abbreviation, (await team(t.abbreviation)).id)
    const ordered = [...FEED].sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate))
    for (const [i, g] of [...ordered.entries()].reverse()) {
        const gw = await db.gameweek.create({
            data: {
                gameZoneId: g.id,
                name: g.name,
                status: i < completeThrough ? 'complete' : 'upcoming',
                year: 2026,
                startDate: new Date(g.startDate),
                endDate: new Date(g.endDate),
            },
        })
        for (const m of g.matches) {
            await db.match.create({
                data: {
                    gameZoneId: m.id,
                    gameweekId: gw.id,
                    homeTeamId: teams.get(m.homeSquad.abbr),
                    awayTeamId: teams.get(m.awaySquad.abbr),
                    status: 'complete',
                    year: 2026,
                    date: new Date(m.date),
                },
            })
        }
    }
    return teams
}

const team = (abbreviation: string) =>
    db.team.create({ data: { slug: abbreviation.toLowerCase(), abbreviation, name: abbreviation } })

describe('rederiveChartWeeks', () => {
    async function seed() {
        const teams = await seedRealSchedule()
        const ssk = teams.get('SSK')!
        const cgy = teams.get('CGY')!
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
        const ldc = await chart(ssk, 'Week 14 (LDC), Sunday, Sept 6, WPG @ SSK', 'post', 21)
        const wsf = await chart(ssk, 'Western Semi-Final, Saturday, Oct 31, SSK @ BC', 'post', 21)
        const blank = await chart(ssk, 'Depth chart', 'regular', 7)
        const right = await chart(ssk, 'Week 3, Saturday, June 20, SSK @ CGY', 'regular', 3)
        const cgyChart = await chart(cgy, 'Game 12, EDM, CGY', 'post', 21)
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
                    teamId: ssk,
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

    it('puts both sides of a playoff game in the same week', async () => {
        const teams = await seedRealSchedule()
        // The 2026 Western Final, as BC (a day early) and Edmonton (no round) titled it.
        const make = async (abbr: string, title: string) => {
            const teamId = teams.get(abbr)!
            const list = await db.depthChartList.create({ data: { teamId, year: 2026 } })
            return db.depthChart.create({
                data: {
                    teamId,
                    depthChartListId: list.id,
                    title,
                    value: `https://example.test/${abbr}.pdf`,
                    year: 2026,
                    season: 'post',
                    week: 21,
                },
            })
        }
        await make('BC', 'Western Final, Sat, Nov 06, BC @ EDM')
        await make('EDM', '11.07.2026 | Depth Chart: VS BC Lions')
        await rederiveChartWeeks({ year: 2026, apply: true })
        const weeks = await db.depthChart.findMany({ select: { season: true, week: true } })
        expect(weeks).toEqual([
            { season: 'post', week: 23 },
            { season: 'post', week: 23 },
        ])
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
        const teams = await seedRealSchedule(15)
        const cgy = { id: teams.get('CGY')! }
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
