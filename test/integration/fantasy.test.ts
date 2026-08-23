import { describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import { currentGameweek } from '~/services/gamezone/gameweeks.server'
import { executeOperation } from './setup/yogaClient'

const YEAR = new Date().getUTCFullYear()

async function seed() {
    const cgy = await db.team.create({
        data: { slug: 'calgary', abbreviation: 'CGY', name: 'Calgary', geniusTeamId: '112939' },
    })
    const ssk = await db.team.create({
        data: { slug: 'saskatchewan', abbreviation: 'SSK', name: 'Saskatchewan' },
    })
    // Three gameweeks, seeded out of schedule order so `week` proves it sorts by date.
    const gw2 = await db.gameweek.create({
        data: {
            gameZoneId: 12,
            name: 'Week 12',
            status: 'playing',
            year: YEAR,
            startDate: new Date(`${YEAR}-08-22T23:00:00Z`),
        },
    })
    const gw1 = await db.gameweek.create({
        data: {
            gameZoneId: 11,
            name: 'Week 11',
            status: 'complete',
            year: YEAR,
            startDate: new Date(`${YEAR}-08-15T19:00:00Z`),
        },
    })
    const gw3 = await db.gameweek.create({
        data: {
            gameZoneId: 13,
            name: 'Week 13',
            status: 'scheduled',
            year: YEAR,
            startDate: new Date(`${YEAR}-08-29T00:30:00Z`),
        },
    })
    await db.match.create({
        data: {
            gameZoneId: 40,
            gameweekId: gw2.id,
            homeTeamId: cgy.id,
            awayTeamId: ssk.id,
            status: 'scheduled',
            year: YEAR,
            date: new Date(`${YEAR}-08-22T23:00:00Z`),
        },
    })
    const philpot = await db.player.create({
        data: {
            gameZoneId: 101,
            firstName: 'Tyson',
            lastName: 'Philpot',
            teamId: cgy.id,
            position: 'WIDE_RECEIVER',
            status: 'available',
        },
    })
    const rankin = await db.player.create({
        data: {
            gameZoneId: 102,
            firstName: 'Justin',
            lastName: 'Rankin',
            teamId: ssk.id,
            position: 'RUNNING_BACK',
        },
    })
    const gone = await db.player.create({
        data: {
            gameZoneId: 103,
            firstName: 'Old',
            lastName: 'Timer',
            teamId: ssk.id,
            position: 'OTHER',
            isActive: false,
        },
    })
    // Two snapshots for Philpot: a price change, then a same-price refresh that
    // must NOT appear in salaryHistory but IS the latest salary.
    await db.playerStatSnapshot.createMany({
        data: [
            {
                playerId: philpot.id,
                year: YEAR,
                cost: 14000,
                projectedScores: 20,
                totalPoints: 200,
                stats: {},
                capturedAt: new Date(`${YEAR}-08-10T00:00:00Z`),
            },
            {
                playerId: philpot.id,
                year: YEAR,
                cost: 15000,
                projectedScores: 22.5,
                avgPoints: 26.1,
                totalPoints: 261.5,
                weekSalaryChange: 1000,
                stats: {},
                capturedAt: new Date(`${YEAR}-08-20T00:00:00Z`),
            },
            {
                playerId: philpot.id,
                year: YEAR,
                cost: 15000,
                projectedScores: 23,
                avgPoints: 26.1,
                totalPoints: 261.5,
                weekSalaryChange: 1000,
                stats: {},
                capturedAt: new Date(`${YEAR}-08-21T00:00:00Z`),
            },
            { playerId: rankin.id, year: YEAR, cost: 9000, stats: {} },
            { playerId: gone.id, year: YEAR, cost: 99000, stats: {} },
        ],
    })
    await db.playerGameweekPoints.createMany({
        data: [
            { playerId: philpot.id, gameweekId: gw1.id, points: 31.8 },
            { playerId: philpot.id, gameweekId: gw2.id, points: 12.1 },
            { playerId: rankin.id, gameweekId: gw2.id, points: 9 },
        ],
    })
    return { cgy, ssk, gw1, gw2, gw3, philpot, rankin }
}

describe('gameweeks', () => {
    it('orders a season by start date and numbers weeks from it', async () => {
        const { cgy } = await seed()
        const r = await executeOperation<{
            gameweeks: {
                week: number
                name: string
                status: string
                matches: { homeTeam: { slug: string }; game: null }[]
            }[]
        }>({
            query: `{ gameweeks(year: ${YEAR}) { week name status matches { homeTeam { slug } game { id } } } }`,
        })
        expect(r.errors).toBeUndefined()
        expect(r.data?.gameweeks.map((g) => [g.week, g.name])).toEqual([
            [1, 'Week 11'],
            [2, 'Week 12'],
            [3, 'Week 13'],
        ])
        expect(r.data?.gameweeks[1].matches).toEqual([{ homeTeam: { slug: cgy.slug }, game: null }])
        // The current gameweek is the first not yet complete.
        expect(await currentGameweek(YEAR)).toMatchObject({ week: 2 })
        expect(await currentGameweek(1999)).toBeNull()
    })
})

describe('fantasyPlayers', () => {
    it('lists active players by salary with the latest snapshot and history', async () => {
        const { philpot } = await seed()
        const r = await executeOperation<{
            fantasyPlayers: {
                name: string
                salary: number | null
                gameZoneProjection: number | null
                seasonPoints: number | null
                lastGameweekPoints: number | null
                pointsHistory: { gameweek: { week: number }; points: number }[]
                salaryHistory: { salary: number; gameZoneProjection: number | null }[]
            }[]
        }>({
            query: `{ fantasyPlayers { name salary gameZoneProjection seasonPoints lastGameweekPoints
                pointsHistory { gameweek { week } points } salaryHistory { salary gameZoneProjection } } }`,
        })
        expect(r.errors).toBeUndefined()
        expect(r.data?.fantasyPlayers.map((p) => p.name)).toEqual([
            'Tyson Philpot',
            'Justin Rankin',
        ])
        expect(r.data?.fantasyPlayers[0]).toEqual({
            name: 'Tyson Philpot',
            salary: 15000,
            gameZoneProjection: 23,
            seasonPoints: 261.5,
            // Week 11 is the latest complete gameweek.
            lastGameweekPoints: 31.8,
            pointsHistory: [
                { gameweek: { week: 1 }, points: 31.8 },
                { gameweek: { week: 2 }, points: 12.1 },
            ],
            salaryHistory: [
                { salary: 14000, gameZoneProjection: 20 },
                { salary: 15000, gameZoneProjection: 22.5 },
            ],
        })
        // Rankin never featured in a complete gameweek.
        expect(r.data?.fantasyPlayers[1].lastGameweekPoints).toBeNull()

        const one = await executeOperation<{ fantasyPlayer: { name: string } | null }>({
            query: `{ fantasyPlayer(id: ${philpot.id}) { name } }`,
        })
        expect(one.data?.fantasyPlayer).toEqual({ name: 'Tyson Philpot' })
    })

    it('filters by team and position and paginates', async () => {
        await seed()
        const r = await executeOperation<{
            byTeam: { name: string }[]
            byPos: { name: string }[]
            page: { name: string }[]
        }>({
            query: `{
                byTeam: fantasyPlayers(teamSlug: "saskatchewan") { name }
                byPos: fantasyPlayers(position: WIDE_RECEIVER) { name }
                page: fantasyPlayers(limit: 1, offset: 1) { name }
            }`,
        })
        expect(r.errors).toBeUndefined()
        expect(r.data?.byTeam.map((p) => p.name)).toEqual(['Justin Rankin'])
        expect(r.data?.byPos.map((p) => p.name)).toEqual(['Tyson Philpot'])
        expect(r.data?.page.map((p) => p.name)).toEqual(['Justin Rankin'])
    })
})
