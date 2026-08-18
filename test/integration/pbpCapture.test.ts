import { describe, expect, it, vi } from 'vitest'
import { db } from '~/lib/db.server'
import { capturePbp } from '~/services/pbp/capturePbp.server'

const SCHEDULE = `
  <a href="https://www.cfl.ca/games/6582/preseason-game/">pre</a>
  <a href="https://www.cfl.ca/games/6600/hamilton-vs-montreal/">reg</a>
`

const payload = (opts: { round: string; homeGeniusId: string; start: string; plays: number }) =>
    JSON.stringify({
        data: {
            matchInfo: {
                seasonName: '2026 CFL',
                roundName: opts.round,
                scheduledStartTime: opts.start,
                homeTeam: { competitorId: opts.homeGeniusId },
                awayTeam: { competitorId: '86680' },
            },
            playByPlayInfo: {
                ALL: Array.from({ length: opts.plays }, (_, i) => ({ id: `1-${i}` })),
            },
        },
    })

// 83579 = Hamilton, matching the seeded Team.geniusTeamId.
const PRESEASON = payload({
    round: 'Preseason Week 1',
    homeGeniusId: '112939',
    start: '2026-05-18T23:00:00+00:00',
    plays: 138,
})
const REGULAR = payload({
    round: 'Week 1',
    homeGeniusId: '83579',
    start: '2026-06-04T23:30:00+00:00',
    plays: 147,
})
const EMPTY = payload({
    round: 'Week 20',
    homeGeniusId: '83579',
    start: '2026-10-30T23:30:00+00:00',
    plays: 0,
})

const stub = (pages: Record<string, string>) =>
    vi.fn(async (url: string | URL | Request) => {
        const u = String(url)
        if (u.includes('/schedule/')) return new Response(SCHEDULE, { status: 200 })
        if (u.includes('/games/6582/')) return new Response('fixtureId=1001', { status: 200 })
        if (u.includes('/games/6600/')) return new Response('fixtureId=1002', { status: 200 })
        const fixture = u.match(/fixtureId=(\d+)/)?.[1] ?? ''
        return new Response(pages[fixture] ?? '{}', { status: 200 })
    }) as unknown as typeof fetch

async function seed() {
    const ham = await db.team.create({
        data: { slug: 'hamilton', abbreviation: 'HAM', name: 'Hamilton', geniusTeamId: '83579' },
    })
    await db.team.create({
        data: { slug: 'calgary', abbreviation: 'CGY', name: 'Calgary', geniusTeamId: '112939' },
    })
    const gw = await db.gameweek.create({
        data: { gameZoneId: 1, name: 'Week 1', status: 'complete', year: 2026 },
    })
    // Regular-season match only. The Game Zone feed carries no preseason rows,
    // which is the whole reason linkage cannot be done by list position.
    await db.match.create({
        data: {
            gameZoneId: 1,
            gameweekId: gw.id,
            homeTeamId: ham.id,
            status: 'complete',
            year: 2026,
            date: new Date('2026-06-04T23:30:00Z'),
        },
    })
}

describe('capturePbp', () => {
    it('captures every fixture, preseason included', async () => {
        await seed()
        const s = await capturePbp(2026, stub({ '1001': PRESEASON, '1002': REGULAR }), 0)
        expect(s.discovered).toBe(2)
        expect(s.captured).toBe(2)
        expect(await db.game.count()).toBe(2)
    })

    it('links a fixture to its match by team and date, NOT by list position', async () => {
        await seed()
        await capturePbp(2026, stub({ '1001': PRESEASON, '1002': REGULAR }), 0)

        const match = await db.match.findFirstOrThrow()
        // Position-based linking put fixture 1001 (a Calgary preseason game)
        // on the Week 1 Hamilton match. Identity-based linking must pick 1002.
        expect(match.geniusFixtureId).toBe(1002)
    })

    it('leaves preseason fixtures unlinked, because the feed has no row for them', async () => {
        await seed()
        const s = await capturePbp(2026, stub({ '1001': PRESEASON, '1002': REGULAR }), 0)
        expect(s.linked).toBe(1)
        expect(await db.game.count({ where: { id: 1001 } })).toBe(1)
    })

    it('never overwrites a stored payload with an empty one', async () => {
        await seed()
        await capturePbp(2026, stub({ '1001': PRESEASON, '1002': REGULAR }), 0)
        const before = await db.game.findUniqueOrThrow({ where: { id: 1002 } })

        // A refetch that comes back empty — an aged-out or postponed fixture.
        const s = await capturePbp(2026, stub({ '1001': PRESEASON, '1002': EMPTY }), 0)
        expect(s.skippedEmpty).toBe(1)

        const after = await db.game.findUniqueOrThrow({ where: { id: 1002 } })
        // Losing a good capture to an empty response is unrecoverable: the
        // widget serves current-season data only.
        expect(after.response).toBe(before.response)
    })

    it('records a failed fixture without abandoning the rest', async () => {
        await seed()
        const flaky = vi.fn(async (url: string | URL | Request) => {
            const u = String(url)
            if (u.includes('/schedule/')) return new Response(SCHEDULE, { status: 200 })
            if (u.includes('/games/6582/')) return new Response('fixtureId=1001', { status: 200 })
            if (u.includes('/games/6600/')) return new Response('fixtureId=1002', { status: 200 })
            if (u.includes('fixtureId=1001')) return new Response('boom', { status: 500 })
            return new Response(REGULAR, { status: 200 })
        }) as unknown as typeof fetch

        const s = await capturePbp(2026, flaky, 0)
        expect(s.failed).toBe(1)
        // One bad fixture must not cost the season.
        expect(s.captured).toBe(1)
    })

    it('is idempotent — a re-run refreshes rather than duplicating', async () => {
        await seed()
        await capturePbp(2026, stub({ '1001': PRESEASON, '1002': REGULAR }), 0)
        await capturePbp(2026, stub({ '1001': PRESEASON, '1002': REGULAR }), 0)
        expect(await db.game.count()).toBe(2)
    })

    it('captures but does not link a fixture whose payload lacks team info', async () => {
        await seed()
        const noTeams = JSON.stringify({
            data: {
                matchInfo: { roundName: 'Week 1' },
                playByPlayInfo: { ALL: [{ id: '1-1' }] },
            },
        })
        const s = await capturePbp(2026, stub({ '1001': noTeams, '1002': noTeams }), 0)
        expect(s.captured).toBe(2)
        // Better an unlinked capture than a wrong one — the payload is still
        // safely stored and can be linked later.
        expect(s.linked).toBe(0)
    })

    it('does not link a fixture whose home team is unknown to us', async () => {
        await seed()
        const foreign = payload({
            round: 'Week 1',
            homeGeniusId: '999999',
            start: '2026-06-04T23:30:00+00:00',
            plays: 10,
        })
        const s = await capturePbp(2026, stub({ '1001': foreign, '1002': foreign }), 0)
        expect(s.linked).toBe(0)
    })

    it('does not link when no match falls in the fixture window', async () => {
        await seed()
        const wrongDate = payload({
            round: 'Week 19',
            homeGeniusId: '83579',
            start: '2026-10-15T23:30:00+00:00',
            plays: 10,
        })
        const s = await capturePbp(2026, stub({ '1001': wrongDate, '1002': wrongDate }), 0)
        expect(s.captured).toBe(2)
        expect(s.linked).toBe(0)
    })
})
