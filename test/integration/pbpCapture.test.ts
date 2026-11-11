import { describe, expect, it, vi } from 'vitest'
import { db } from '~/lib/db.server'
import { isPermanentError } from '~/lib/jobErrors.server'
import { capturePbp } from '~/services/pbp/capturePbp.server'

// Two played fixtures (a preseason game and Week 1) and one not yet kicked off,
// as cfl.ca's Nuxt schedule payload carries them.
const NOW = new Date('2026-07-01T00:00:00Z')
const SCHEDULE = `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify([
    [1, 5, 9],
    { ID: 2, genius: 3, start_at: 4, home_team_id: 16, away_team_id: 16 },
    6582,
    { id: 13 },
    '2026-05-18T23:00:00+00:00',
    { ID: 6, genius: 7, start_at: 8, home_team_id: 16, away_team_id: 16 },
    6600,
    { id: 14 },
    '2026-06-04T23:30:00+00:00',
    { ID: 10, genius: 11, start_at: 12, home_team_id: 16, away_team_id: 16 },
    6700,
    { id: 15 },
    '2026-10-30T23:30:00+00:00',
    1001,
    1002,
    1003,
    1,
])}</script>`

const pbpFeed = (plays: number, ids: (i: number) => string = (i) => `1-${i}`) =>
    JSON.stringify({
        data: {
            status: { status: 'AVAILABLE', description: 'Ok' },
            details: {
                playByPlayInfo:
                    plays === 0
                        ? {}
                        : {
                              Q1: Array.from({ length: plays }, (_, i) => ({ id: ids(i) })),
                              HL: [{ id: ids(0) }],
                          },
            },
        },
    })

const scoreboardFeed = (opts: { round: string; homeGeniusId?: string; start?: string }) =>
    JSON.stringify({
        data: {
            status: { status: 'AVAILABLE', description: 'Ok' },
            details: {
                matchSummaries: { matchStatus: 'PostMatch' },
                homeTeam: { competitorId: opts.homeGeniusId, score: '27' },
                awayTeam: { competitorId: '86680', score: '24' },
                scheduledStartTime: opts.start,
                seasonName: '2026 CFL',
                roundName: opts.round,
            },
        },
    })

type Feeds = { pbp: string; scoreboard: string }

// 83579 = Hamilton, matching the seeded Team.geniusTeamId.
const PRESEASON: Feeds = {
    pbp: pbpFeed(138),
    scoreboard: scoreboardFeed({
        round: 'Preseason Week 1',
        homeGeniusId: '112939',
        start: '2026-05-18T23:00:00Z',
    }),
}
const REGULAR: Feeds = {
    pbp: pbpFeed(147),
    scoreboard: scoreboardFeed({
        round: 'Week 1',
        homeGeniusId: '83579',
        start: '2026-06-04T23:30:00Z',
    }),
}
const EMPTY: Feeds = {
    pbp: pbpFeed(0),
    scoreboard: scoreboardFeed({ round: 'Week 1', homeGeniusId: '83579' }),
}

const stub = (feeds: Record<string, Feeds | Response>) =>
    vi.fn(async (url: string | URL | Request) => {
        const u = String(url)
        if (u.includes('cfl.ca/schedule/')) return new Response(SCHEDULE, { status: 200 })
        const fixture = u.match(/fixtureId=(\d+)/)?.[1] ?? ''
        const f = feeds[fixture]
        if (!f) throw new Error(`unexpected fetch ${u}`)
        if (f instanceof Response) return f.clone()
        return new Response(u.includes('/playByPlay/') ? f.pbp : f.scoreboard, { status: 200 })
    }) as unknown as typeof fetch

const capture = (feeds: Record<string, Feeds | Response>) => capturePbp(2026, stub(feeds), 0, NOW)

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
    it('captures every played fixture, preseason included', async () => {
        await seed()
        const s = await capture({ '1001': PRESEASON, '1002': REGULAR })
        expect(s.discovered).toBe(3)
        expect(s.captured).toBe(2)
        expect(await db.game.count()).toBe(2)
    })

    it('does not fetch a fixture that has not kicked off', async () => {
        await seed()
        // No feed registered for 1003 — the stub throws if it is asked for.
        const s = await capture({ '1001': PRESEASON, '1002': REGULAR })
        expect(s.skippedFuture).toBe(1)
        expect(s.failed).toBe(0)
    })

    it('stores the payload in the shape the parser reads', async () => {
        await seed()
        await capture({ '1001': PRESEASON, '1002': REGULAR })
        const game = await db.game.findUniqueOrThrow({ where: { id: 1002 } })
        const stored = JSON.parse(game.response)
        // HL is a highlights reel of plays already in the periods.
        expect(stored.data.playByPlayInfo.ALL).toHaveLength(147)
        expect(stored.data.matchInfo.homeTeam.competitorId).toBe('83579')
        expect(stored.data.scoreboardInfo).toMatchObject({ homeScore: 27, awayScore: 24 })
        expect(stored.source).toBe('gsm-v1')
        expect(stored.raw.playByPlay.data.details.playByPlayInfo.HL).toHaveLength(1)
    })

    it('links a fixture to its match by team and date, NOT by list position', async () => {
        await seed()
        await capture({ '1001': PRESEASON, '1002': REGULAR })

        const match = await db.match.findFirstOrThrow()
        // Position-based linking put fixture 1001 (a Calgary preseason game)
        // on the Week 1 Hamilton match. Identity-based linking must pick 1002.
        expect(match.geniusFixtureId).toBe(1002)
    })

    it('leaves preseason fixtures unlinked, because the feed has no row for them', async () => {
        await seed()
        const s = await capture({ '1001': PRESEASON, '1002': REGULAR })
        expect(s.linked).toBe(1)
        expect(await db.game.count({ where: { id: 1001 } })).toBe(1)
    })

    it('never overwrites a stored payload with an empty one', async () => {
        await seed()
        await capture({ '1001': PRESEASON, '1002': REGULAR })
        const before = await db.game.findUniqueOrThrow({ where: { id: 1002 } })

        // A refetch that comes back empty — an aged-out or postponed fixture.
        const s = await capture({ '1001': PRESEASON, '1002': EMPTY })
        expect(s.skippedEmpty).toBe(1)

        const after = await db.game.findUniqueOrThrow({ where: { id: 1002 } })
        // Losing a good capture to an empty response is unrecoverable: the
        // feed serves current-season data only.
        expect(after.response).toBe(before.response)
    })

    it('records a failed fixture without abandoning the rest', async () => {
        await seed()
        const s = await capture({
            '1001': new Response('{"code":"BN001"}', { status: 500 }),
            '1002': REGULAR,
        })
        expect(s.failed).toBe(1)
        // One bad fixture must not cost the season.
        expect(s.captured).toBe(1)
    })

    it('treats a non-AVAILABLE feed status as a failure, not as an empty game', async () => {
        await seed()
        const unavailable = JSON.stringify({ data: { status: { status: 'UNAVAILABLE' } } })
        const s = await capture({
            '1001': { pbp: unavailable, scoreboard: unavailable },
            '1002': REGULAR,
        })
        expect(s.failed).toBe(1)
        expect(s.skippedEmpty).toBe(0)
    })

    it('throws when every fixture fails — an outage must not record a success', async () => {
        await seed()
        // Exactly what the retired endpoint did to every fixture in 2026.
        const down = new Response('{"code":"BN001"}', { status: 500 })
        await expect(capture({ '1001': down, '1002': down })).rejects.toThrow(
            /every fixture failed/,
        )
    })

    it('makes the all-failed throw permanent only when every failure was a 4xx', async () => {
        await seed()
        const failure = async (feeds: Record<string, Response>) =>
            capture(feeds).then(
                () => null,
                (err: unknown) => err,
            )

        // The feed routes moved: every fixture 404s, and retrying asks the same question.
        const gone = new Response('not found', { status: 404 })
        const moved = await failure({ '1001': gone, '1002': gone })
        expect(String(moved)).toMatch(/every fixture failed/)
        expect(isPermanentError(moved)).toBe(true)

        // A 5xx anywhere among the failures keeps it retryable.
        const down = new Response('{"code":"BN001"}', { status: 500 })
        expect(isPermanentError(await failure({ '1001': down, '1002': down }))).toBe(false)
        expect(isPermanentError(await failure({ '1001': gone, '1002': down }))).toBe(false)
    })

    it('throws when the schedule yields no fixtures', async () => {
        await seed()
        const f = vi.fn(
            async () => new Response('<html>redesigned</html>', { status: 200 }),
        ) as unknown as typeof fetch
        await expect(capturePbp(2026, f, 0, NOW)).rejects.toThrow(/0 fixtures/)
    })

    it('is idempotent — a re-run refreshes rather than duplicating', async () => {
        await seed()
        await capture({ '1001': PRESEASON, '1002': REGULAR })
        await capture({ '1001': PRESEASON, '1002': REGULAR })
        expect(await db.game.count()).toBe(2)
    })

    it('captures but does not link a fixture whose scoreboard lacks team info', async () => {
        await seed()
        const noTeams: Feeds = { pbp: pbpFeed(1), scoreboard: scoreboardFeed({ round: 'Week 1' }) }
        const s = await capture({ '1001': noTeams, '1002': noTeams })
        expect(s.captured).toBe(2)
        // Better an unlinked capture than a wrong one — the payload is still
        // safely stored and can be linked later.
        expect(s.linked).toBe(0)
    })

    it('does not link a fixture whose home team is unknown to us', async () => {
        await seed()
        const foreign: Feeds = {
            pbp: pbpFeed(10),
            scoreboard: scoreboardFeed({
                round: 'Week 1',
                homeGeniusId: '999999',
                start: '2026-06-04T23:30:00Z',
            }),
        }
        const s = await capture({ '1001': foreign, '1002': foreign })
        expect(s.linked).toBe(0)
    })

    it('does not link when no match falls in the fixture window', async () => {
        await seed()
        const wrongDate: Feeds = {
            pbp: pbpFeed(10),
            scoreboard: scoreboardFeed({
                round: 'Week 19',
                homeGeniusId: '83579',
                start: '2026-10-15T23:30:00Z',
            }),
        }
        const s = await capture({ '1001': wrongDate, '1002': wrongDate })
        expect(s.captured).toBe(2)
        expect(s.linked).toBe(0)
    })
})
