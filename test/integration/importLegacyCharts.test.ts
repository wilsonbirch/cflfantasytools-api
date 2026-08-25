import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import {
    importLegacyCharts,
    type LegacyChartData,
    type LegacyChartRow,
} from '~/services/depthCharts/importLegacyCharts.server'

const CGY = '112939'
const SSK = '106752'

// Legacy 3DF team ids differ from ours; the import must map through
// geniusTeamId, never trust the raw id.
const LEGACY_CGY = 4
const LEGACY_SSK = 1

let cgyId: number
let sskId: number

beforeEach(async () => {
    const cgy = await db.team.create({
        data: { slug: 'calgary', abbreviation: 'CGY', name: 'Calgary', geniusTeamId: CGY },
    })
    const ssk = await db.team.create({
        data: {
            slug: 'saskatchewan',
            abbreviation: 'SSK',
            name: 'Saskatchewan',
            geniusTeamId: SSK,
        },
    })
    cgyId = cgy.id
    sskId = ssk.id
})

const chart = (over: Partial<LegacyChartRow> & { id: number }): LegacyChartRow => ({
    teamId: LEGACY_SSK,
    title: 'Week 5, Sat. July 6, ',
    value: `https://static.cfl.ca/chart-${over.id}.pdf`,
    year: 2024,
    season: 'regular',
    week: 5,
    createdAt: new Date('2024-11-27T18:38:38Z'),
    ...over,
})

const data = (charts: LegacyChartRow[], lists: LegacyChartData['lists'] = []): LegacyChartData => ({
    teams: [
        { id: LEGACY_SSK, geniusTeamId: SSK },
        { id: LEGACY_CGY, geniusTeamId: CGY },
    ],
    lists,
    charts,
})

describe('importLegacyCharts', () => {
    it('imports a chart under the mapped team with the title date as publishedAt', async () => {
        const summary = await importLegacyCharts(async () => data([chart({ id: 1 })]))
        expect(summary).toMatchObject({ read: 1, imported: 1, datedFromTitle: 1 })

        const row = await db.depthChart.findFirstOrThrow({ where: { teamId: sskId } })
        expect(row.publishedAt).toEqual(new Date(Date.UTC(2024, 6, 6, 12)))
        expect(row.year).toBe(2024)
        expect(row.week).toBe(5)

        const list = await db.depthChartList.findUniqueOrThrow({
            where: { teamId_year: { teamId: sskId, year: 2024 } },
        })
        expect(row.depthChartListId).toBe(list.id)
    })

    it('dates a dateless title from the team game number, day before kickoff', async () => {
        // Calgary's second regular game; one preseason game shifts the index.
        await db.game.create({
            data: {
                id: 90001,
                year: 2024,
                response: '{}',
                startedAt: new Date('2024-05-25T02:00:00Z'),
                homeGeniusTeamId: CGY,
                awayGeniusTeamId: SSK,
            },
        })
        await db.game.create({
            data: {
                id: 90002,
                year: 2024,
                response: '{}',
                startedAt: new Date('2024-06-08T02:00:00Z'),
                homeGeniusTeamId: SSK,
                awayGeniusTeamId: CGY,
            },
        })
        await db.game.create({
            data: {
                id: 90003,
                year: 2024,
                response: '{}',
                startedAt: new Date('2024-06-15T02:00:00Z'),
                homeGeniusTeamId: CGY,
                awayGeniusTeamId: SSK,
            },
        })
        const summary = await importLegacyCharts(async () =>
            data([
                chart({
                    id: 1,
                    teamId: LEGACY_CGY,
                    title: 'Pre-Season Game 1, BC, CGY',
                    season: 'pre',
                    week: 1,
                }),
                chart({ id: 2, teamId: LEGACY_CGY, title: 'Game 2, CGY, BC', week: 3 }),
            ]),
        )
        expect(summary).toMatchObject({ imported: 2, datedFromGame: 2 })

        const rows = await db.depthChart.findMany({
            where: { teamId: cgyId },
            orderBy: { publishedAt: 'asc' },
        })
        // Preseason game 1 kicked off 05-25; regular game 2 is the third
        // chronological game (one preseason), kicked off 06-15.
        expect(rows[0].publishedAt).toEqual(new Date('2024-05-24T02:00:00Z'))
        expect(rows[1].publishedAt).toEqual(new Date('2024-06-14T02:00:00Z'))
    })

    it('falls back to createdAt when neither a date nor a game matches', async () => {
        const summary = await importLegacyCharts(async () =>
            data([chart({ id: 1, title: 'Game 9, CGY, TOR', teamId: LEGACY_CGY })]),
        )
        expect(summary).toMatchObject({ imported: 1, datedFromCreatedAt: 1 })
    })

    it('is idempotent on the chart href and never duplicates', async () => {
        const rows = data([chart({ id: 1 })])
        await importLegacyCharts(async () => rows)
        const second = await importLegacyCharts(async () => rows)
        expect(second).toMatchObject({ imported: 0, skippedExisting: 1 })
        expect(await db.depthChart.count()).toBe(1)
    })

    it('counts a legacy team it cannot map instead of guessing', async () => {
        const summary = await importLegacyCharts(async () => data([chart({ id: 1, teamId: 99 })]))
        expect(summary).toMatchObject({ imported: 0, unknownTeam: 1 })
    })
})
