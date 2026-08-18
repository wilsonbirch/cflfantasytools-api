import { describe, expect, it } from 'vitest'
import { FEED_SCHEMAS, mapPosition } from '~/services/gamezone/feeds'

const base = {
    id: 1,
    firstName: 'Tyson',
    lastName: 'Philpot',
    squad: { id: 4, abbr: 'MTL' },
    position: 'wide_receiver',
}

// Every case here is a real shape observed in the live feed on 2026-08-17.
// They are the reason a naive schema rejected the whole 702-player payload.
describe('players feed', () => {
    it('accepts a fully populated player', () => {
        const r = FEED_SCHEMAS.players.safeParse([
            {
                ...base,
                cost: 15000,
                points: 233,
                stats: {
                    avgPoints: 25.89,
                    stats: { rec: 74, rec_yds: 1154 },
                    points: { gws: { '1': 20.6 }, matches: { '1': 20.6 } },
                },
            },
        ])
        expect(r.success).toBe(true)
    })

    it('accepts an EMPTY MAP SERIALIZED AS AN ARRAY', () => {
        // Inactive players come back as `"stats": []` and `"points": []` rather
        // than `{}`. Rejecting this would fail the entire sync over players who
        // have no data in the first place.
        const r = FEED_SCHEMAS.players.safeParse([{ ...base, stats: { stats: [], points: [] } }])
        expect(r.success).toBe(true)
        expect(r.data?.[0].stats?.stats).toBeUndefined()
    })

    it('accepts null point values, meaning did-not-play', () => {
        // Distinct from 0, which means played and scored nothing.
        const r = FEED_SCHEMAS.players.safeParse([
            { ...base, stats: { points: { gws: { '1': null, '2': 2.2 }, matches: {} } } },
        ])
        expect(r.success).toBe(true)
        expect(r.data?.[0].stats?.points?.gws).toEqual({ '1': null, '2': 2.2 })
    })

    it('tolerates unknown extra fields rather than failing the sync', () => {
        const r = FEED_SCHEMAS.players.safeParse([{ ...base, somethingNew: { nested: true } }])
        expect(r.success).toBe(true)
    })

    it('still rejects a genuinely wrong shape', () => {
        expect(FEED_SCHEMAS.players.safeParse([{ ...base, firstName: 42 }]).success).toBe(false)
        expect(FEED_SCHEMAS.players.safeParse({ not: 'an array' }).success).toBe(false)
    })
})

describe('gameweeks feed', () => {
    it('parses a gameweek with its matches', () => {
        const r = FEED_SCHEMAS.gameweeks.safeParse([
            {
                id: 1,
                feedId: 1420012,
                name: 'Week 1',
                status: 'complete',
                startDate: '2026-06-06T19:00:00-04:00',
                matches: [
                    {
                        id: 1,
                        homeSquad: { id: 3, abbr: 'HAM' },
                        awaySquad: { id: 4, abbr: 'MTL' },
                        homeSquadScore: 27,
                        awaySquadScore: 30,
                        status: 'complete',
                        date: '2026-06-04T19:30:00-04:00',
                        venue: 'Hamilton Stadium',
                    },
                ],
            },
        ])
        expect(r.success).toBe(true)
        expect(r.data?.[0].matches).toHaveLength(1)
    })

    it('defaults a missing matches array rather than failing', () => {
        const r = FEED_SCHEMAS.gameweeks.safeParse([
            { id: 22, name: 'Week 22', status: 'upcoming' },
        ])
        expect(r.success).toBe(true)
        expect(r.data?.[0].matches).toEqual([])
    })
})

describe('mapPosition', () => {
    it.each([
        ['quarterback', 'QUARTERBACK'],
        ['running_back', 'RUNNING_BACK'],
        ['wide_receiver', 'WIDE_RECEIVER'],
    ])('maps %s', (input, expected) => {
        expect(mapPosition(input)).toBe(expected)
    })

    it('falls back to OTHER for an unseen position instead of throwing', () => {
        // The pool is QB/RB/WR today, but the game could add a position mid-season.
        expect(mapPosition('kicker')).toBe('OTHER')
        expect(mapPosition(null)).toBe('OTHER')
    })
})
