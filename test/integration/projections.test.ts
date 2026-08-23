import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import { parseGame } from '~/services/pbp/parsePlays.server'
import { fitGameweek, runProjectionsFit } from '~/services/projections/fitProjections.server'
import { fantasyPoints } from '~/services/fantasy/scoring'
import { executeOperation } from './setup/yogaClient'

// The captured fixture: Calgary (112939) at home to Saskatchewan (106752),
// 2026, 138 plays. One game is a thin training set, which is the point — the
// model must project from it without inventing anything.
const PAYLOAD = readFileSync('test/fixtures/pbp/widget-payload.json', 'utf8')
const FIXTURE_ID = 13419665
const YEAR = 2026

async function seed() {
    const cgy = await db.team.create({
        data: { slug: 'calgary', abbreviation: 'CGY', name: 'Calgary', geniusTeamId: '112939' },
    })
    const ssk = await db.team.create({
        data: {
            slug: 'saskatchewan',
            abbreviation: 'SSK',
            name: 'Saskatchewan',
            geniusTeamId: '106752',
        },
    })
    await db.coachingStaff.createMany({
        data: [
            {
                teamId: cgy.id,
                role: 'OC',
                person: 'Calgary OC',
                effectiveFrom: new Date('2026-01-01'),
            },
            {
                teamId: ssk.id,
                role: 'DC',
                person: 'Sask DC',
                effectiveFrom: new Date('2026-01-01'),
            },
        ],
    })
    await db.game.create({ data: { id: FIXTURE_ID, response: PAYLOAD, year: YEAR } })
    await parseGame(FIXTURE_ID)
    const game = await db.game.findUniqueOrThrow({ where: { id: FIXTURE_ID } })
    const played = await db.gameweek.create({
        data: {
            gameZoneId: 1,
            name: 'Week 1',
            status: 'complete',
            year: YEAR,
            startDate: game.startedAt!,
        },
    })
    await db.match.create({
        data: {
            gameZoneId: 10,
            gameweekId: played.id,
            homeTeamId: cgy.id,
            awayTeamId: ssk.id,
            status: 'complete',
            year: YEAR,
            date: game.startedAt,
            geniusFixtureId: FIXTURE_ID,
        },
    })
    const next = await db.gameweek.create({
        data: {
            gameZoneId: 2,
            name: 'Week 2',
            status: 'scheduled',
            year: YEAR,
            startDate: new Date(game.startedAt!.getTime() + 7 * 86_400_000),
        },
    })
    await db.match.create({
        data: {
            gameZoneId: 11,
            gameweekId: next.id,
            homeTeamId: ssk.id,
            awayTeamId: cgy.id,
            status: 'scheduled',
            year: YEAR,
            date: next.startDate,
        },
    })
    // Game Zone players matching names in the play text ("#12 J.Love" throws for
    // Calgary, "#86 M.Sexton" catches for Saskatchewan), plus one who never played.
    const [qb, wr, bench] = await Promise.all([
        db.player.create({
            data: {
                gameZoneId: 1,
                firstName: 'Jack',
                lastName: 'Love',
                teamId: cgy.id,
                position: 'QUARTERBACK',
            },
        }),
        db.player.create({
            data: {
                gameZoneId: 2,
                firstName: 'Mitch',
                lastName: 'Sexton',
                teamId: ssk.id,
                position: 'WIDE_RECEIVER',
            },
        }),
        db.player.create({
            data: {
                gameZoneId: 3,
                firstName: 'Never',
                lastName: 'Dressed',
                teamId: cgy.id,
                position: 'WIDE_RECEIVER',
            },
        }),
    ])
    await db.playerStatSnapshot.create({
        data: { playerId: wr.id, year: YEAR, cost: 15000, projectedScores: 20, stats: {} },
    })
    return { cgy, ssk, played, next, qb, wr, bench }
}

describe('projections', () => {
    it('projects only players who dressed recently, from the era before the fit', async () => {
        const { next, qb, wr, bench, cgy, ssk } = await seed()
        const rows = await fitGameweek(next.id)
        const ids = rows.map((r) => r.playerId)
        expect(ids).toContain(qb.id)
        expect(ids).toContain(wr.id)
        expect(ids).not.toContain(bench.id)

        const passer = rows.find((r) => r.playerId === qb.id)!
        expect(passer.games).toBe(1)
        expect(passer.opponentTeamId).toBe(ssk.id)
        expect(passer.passAttempts).toBeGreaterThan(5)
        expect(passer.receptions).toBe(0)
        const catcher = rows.find((r) => r.playerId === wr.id)!
        expect(catcher.games).toBe(1)
        expect(catcher.targets).toBeGreaterThan(0)
        expect(catcher.opponentTeamId).toBe(cgy.id)

        // A fit dated before the only game has nothing to learn from.
        expect(await fitGameweek(next.id, new Date('2026-01-01'))).toEqual([])
    })

    it('stores a fit per run and serves the newest over GraphQL', async () => {
        const { next, wr } = await seed()
        const first = await runProjectionsFit(YEAR, new Date('2026-06-20T00:00:00Z'))
        expect(first.rows).toBeGreaterThan(0)
        const again = await runProjectionsFit(YEAR, new Date('2026-06-21T00:00:00Z'))
        expect(again.rows).toBe(first.rows)
        // Both fits are kept, only the newest is read.
        expect(await db.projection.count()).toBe(first.rows + again.rows)

        const r = await executeOperation<{
            projections: {
                player: { name: string }
                fittedAt: string
                points: number
                opponent: { slug: string }
            }[]
            fantasyPlayer: {
                projection: { points: number; games: number } | null
                value: number | null
                gameZoneProjection: number | null
            } | null
            none: unknown[]
        }>({
            query: `{
                projections(year: ${YEAR}, week: 2, teamSlug: "calgary") {
                    player { name } fittedAt points opponent { slug }
                }
                fantasyPlayer(id: ${wr.id}, gameweekId: ${next.id}) {
                    projection { points games } value gameZoneProjection
                }
                none: projections(year: ${YEAR}, week: 9) { points }
            }`,
        })
        expect(r.errors).toBeUndefined()
        const list = r.data!.projections
        expect(list.length).toBeGreaterThan(0)
        expect(new Set(list.map((p) => p.fittedAt))).toEqual(new Set(['2026-06-21T00:00:00.000Z']))
        expect(list.every((p) => p.opponent.slug === 'saskatchewan')).toBe(true)
        // Highest points first.
        expect(list.map((p) => p.points)).toEqual(
            [...list.map((p) => p.points)].sort((a, b) => b - a),
        )
        const stored = await db.projection.findFirst({
            where: { playerId: wr.id, gameweekId: next.id },
            orderBy: { fittedAt: 'desc' },
        })
        expect(r.data!.fantasyPlayer).toEqual({
            projection: { points: fantasyPoints(stored!), games: 1 },
            value: Math.round((fantasyPoints(stored!) / 15) * 100) / 100,
            gameZoneProjection: 20,
        })
        expect(r.data!.none).toEqual([])
    })

    it('warns and writes nothing when the season has no gameweeks', async () => {
        expect(await runProjectionsFit(1999)).toEqual({ gameweeks: 0, rows: 0 })
        expect(await db.projection.count()).toBe(0)
    })
})
