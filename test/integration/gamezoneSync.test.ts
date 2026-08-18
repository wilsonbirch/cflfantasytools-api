import { describe, expect, it, vi } from 'vitest'
import { db } from '~/lib/db.server'
import { fetchFeed } from '~/services/gamezone/fetchFeed.server'
import { syncGameZone } from '~/services/gamezone/syncGameZone.server'

const SQUADS = [
    { id: 1, name: 'Ottawa REDBLACKS', abbreviation: 'OTT' },
    { id: 8, name: 'Saskatchewan Roughriders', abbreviation: 'SSK' },
]

const GAMEWEEKS = [
    {
        id: 1,
        feedId: 1420012,
        name: 'Week 1',
        status: 'complete',
        matches: [
            {
                id: 1,
                homeSquad: { id: 1, abbr: 'OTT' },
                awaySquad: { id: 8, abbr: 'SSK' },
                homeSquadScore: 27,
                awaySquadScore: 30,
                status: 'complete',
                date: '2026-06-04T19:30:00-04:00',
                venue: 'TD Place',
            },
        ],
    },
]

const PLAYERS = [
    {
        id: 100,
        feedId: 999,
        firstName: 'Test',
        lastName: 'Rider',
        squad: { id: 8, abbr: 'SSK' },
        status: 'available',
        cost: 12000,
        points: 88,
        position: 'quarterback',
        stats: { avgPoints: 11, stats: { pass_yds: 900 }, points: { gws: { '1': 20.6 } } },
    },
]

const stubFetch = (payloads: Record<string, unknown>) =>
    vi.fn(async (url: string | URL | Request) => {
        const key = String(url).match(/\/([a-z]+)\.json/)?.[1] ?? ''
        return new Response(JSON.stringify(payloads[key] ?? []), { status: 200 })
    }) as unknown as typeof fetch

// Riders first ON PURPOSE. With RESTART IDENTITY the Riders take our id 1 while
// Game Zone calls them squad 8, and Ottawa takes our id 2 while Game Zone calls
// them squad 1 — so the two id spaces demonstrably cross. Seeding the other way
// round would let a broken id-based join pass by coincidence.
async function seedTeams() {
    await db.team.createMany({
        data: [
            {
                slug: 'saskatchewan-roughriders',
                abbreviation: 'SSK',
                name: 'Saskatchewan Roughriders',
            },
            { slug: 'ottawa-redblacks', abbreviation: 'OTT', name: 'Ottawa REDBLACKS' },
        ],
    })
}

describe('fetchFeed', () => {
    it('records an OK snapshot and returns items', async () => {
        const r = await fetchFeed('squads', stubFetch({ squads: SQUADS }))
        expect(r.status).toBe('OK')
        const snap = await db.feedSnapshot.findFirstOrThrow({ where: { source: 'squads' } })
        expect(snap.status).toBe('OK')
        expect(snap.itemCount).toBe(2)
    })

    it('short-circuits an unchanged payload on its hash', async () => {
        const f = stubFetch({ squads: SQUADS })
        await fetchFeed('squads', f)
        const second = await fetchFeed('squads', f)
        // Most hourly runs land here — this is what makes the cadence cheap.
        expect(second.status).toBe('UNCHANGED')
    })

    it('records INVALID and keeps the payload when the shape changes', async () => {
        const r = await fetchFeed('squads', stubFetch({ squads: [{ id: 'not-a-number' }] }))
        expect(r.status).toBe('INVALID')
        const snap = await db.feedSnapshot.findFirstOrThrow({
            where: { source: 'squads', status: 'INVALID' },
        })
        // Retained so an upstream change is diagnosable after the fact.
        expect(snap.payload).not.toBeNull()
    })

    it('records INVALID when the body is not JSON at all', async () => {
        const notJson = vi.fn(
            async () => new Response('<html>maintenance</html>', { status: 200 }),
        ) as unknown as typeof fetch
        const r = await fetchFeed('squads', notJson)
        expect(r.status).toBe('INVALID')
        // An HTML error page served with a 200 is a real failure mode for S3.
        expect(r.status === 'INVALID' && r.error).toMatch(/not JSON/)
    })

    it('records FETCH_FAILED when the feed is unreachable', async () => {
        const failing = vi.fn(async () => {
            throw new Error('ECONNREFUSED')
        }) as unknown as typeof fetch
        const r = await fetchFeed('squads', failing)
        expect(r.status).toBe('FETCH_FAILED')
    })
})

describe('syncGameZone', () => {
    it('maps squads to teams by abbreviation, never by id', async () => {
        await seedTeams()

        vi.stubGlobal(
            'fetch',
            stubFetch({ squads: SQUADS, gameweeks: GAMEWEEKS, players: PLAYERS }),
        )
        await syncGameZone(2026)
        vi.unstubAllGlobals()

        const ssk = await db.team.findUniqueOrThrow({ where: { abbreviation: 'SSK' } })
        const ott = await db.team.findUniqueOrThrow({ where: { abbreviation: 'OTT' } })

        // The two id spaces cross: Game Zone squad 1 is Ottawa, but our id 1 is
        // the Riders. Joining on the integer would swap the two clubs' data.
        expect(ssk.id).toBe(1)
        expect(ssk.gameZoneSquadId).toBe(8)
        expect(ott.gameZoneSquadId).toBe(1)
        expect(ott.id).not.toBe(ott.gameZoneSquadId)
    })

    it('attaches players to the correct club', async () => {
        await seedTeams()
        vi.stubGlobal(
            'fetch',
            stubFetch({ squads: SQUADS, gameweeks: GAMEWEEKS, players: PLAYERS }),
        )
        await syncGameZone(2026)
        vi.unstubAllGlobals()

        const player = await db.player.findFirstOrThrow({
            where: { gameZoneId: 100 },
            include: { Team: true },
        })
        expect(player.Team?.abbreviation).toBe('SSK')
        expect(player.position).toBe('QUARTERBACK')
    })

    it('captures a perishable stat snapshot on every changed pull', async () => {
        await seedTeams()
        vi.stubGlobal(
            'fetch',
            stubFetch({ squads: SQUADS, gameweeks: GAMEWEEKS, players: PLAYERS }),
        )
        await syncGameZone(2026)
        vi.unstubAllGlobals()

        const snap = await db.playerStatSnapshot.findFirstOrThrow()
        // Salary and projection are the values the feed will overwrite next week
        // and can never be recovered.
        expect(snap.cost).toBe(12000)
        expect(snap.totalPoints).toBe(88)
    })

    it('records matches with both clubs resolved', async () => {
        await seedTeams()
        vi.stubGlobal(
            'fetch',
            stubFetch({ squads: SQUADS, gameweeks: GAMEWEEKS, players: PLAYERS }),
        )
        await syncGameZone(2026)
        vi.unstubAllGlobals()

        const match = await db.match.findFirstOrThrow({
            include: { HomeTeam: true, AwayTeam: true },
        })
        expect(match.HomeTeam?.abbreviation).toBe('OTT')
        expect(match.AwayTeam?.abbreviation).toBe('SSK')
        expect(match.homeScore).toBe(27)
        // Owned by the play-by-play job, not this one.
        expect(match.geniusFixtureId).toBeNull()
    })

    it('leaves existing rows untouched when a feed goes malformed', async () => {
        await seedTeams()
        vi.stubGlobal(
            'fetch',
            stubFetch({ squads: SQUADS, gameweeks: GAMEWEEKS, players: PLAYERS }),
        )
        await syncGameZone(2026)
        vi.unstubAllGlobals()
        const before = await db.player.count()

        // A truncated or reshaped feed must never be able to delete the dimension.
        vi.stubGlobal('fetch', stubFetch({ squads: [], gameweeks: [], players: [{ bogus: true }] }))
        const summary = await syncGameZone(2026)
        vi.unstubAllGlobals()

        expect(summary.skipped).toContain('players:INVALID')
        expect(await db.player.count()).toBe(before)
    })

    it('ingests a sparse feed where every optional field is absent', async () => {
        await seedTeams()
        // Real feeds carry inactive players with no squad, cost, points or stats,
        // and upcoming matches with no score or venue. None of that is an error.
        const sparsePlayers = [{ id: 500, firstName: 'No', lastName: 'Data' }]
        const sparseGameweeks = [
            {
                id: 9,
                name: 'Week 9',
                status: 'upcoming',
                matches: [{ id: 90, status: 'upcoming' }],
            },
        ]
        vi.stubGlobal(
            'fetch',
            stubFetch({ squads: SQUADS, gameweeks: sparseGameweeks, players: sparsePlayers }),
        )
        const summary = await syncGameZone(2026)
        vi.unstubAllGlobals()

        expect(summary.skipped).toEqual([])
        const player = await db.player.findFirstOrThrow({ where: { gameZoneId: 500 } })
        expect(player.teamId).toBeNull()
        expect(player.position).toBe('OTHER')

        const match = await db.match.findFirstOrThrow({ where: { gameZoneId: 90 } })
        expect(match.homeTeamId).toBeNull()
        expect(match.homeScore).toBeNull()
        expect(match.date).toBeNull()
    })

    it('ages out an absent player instead of deleting them', async () => {
        await seedTeams()
        vi.stubGlobal(
            'fetch',
            stubFetch({ squads: SQUADS, gameweeks: GAMEWEEKS, players: PLAYERS }),
        )
        await syncGameZone(2026)

        // Same shape, different content, so the hash changes and the sync runs.
        vi.stubGlobal(
            'fetch',
            stubFetch({
                squads: SQUADS,
                gameweeks: GAMEWEEKS,
                players: [{ ...PLAYERS[0], id: 101, lastName: 'Replacement' }],
            }),
        )
        await syncGameZone(2026)
        vi.unstubAllGlobals()

        const gone = await db.player.findFirstOrThrow({ where: { gameZoneId: 100 } })
        // Still present, with their history — a released player's season stats
        // stay meaningful, and an upstream glitch must not destroy rows.
        expect(gone.missedSyncs).toBe(1)
        expect(gone.isActive).toBe(true)
    })
})
