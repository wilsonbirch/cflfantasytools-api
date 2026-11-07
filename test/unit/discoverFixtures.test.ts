import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseScheduleFixtures, unflattenNuxtPayload } from '~/services/pbp/discoverFixtures.server'

// Real cfl.ca/schedule/ markup from 2026-11-07, after the site moved to Nuxt.
// Every fixture in the season is server-rendered into __NUXT_DATA__ with its
// BetGenius id attached, so discovery needs no per-game page fetches.
const schedule = readFileSync('test/fixtures/pbp/schedule.html', 'utf8')

const nuxtPage = (values: unknown[]) =>
    `<script type="application/json" id="__NUXT_DATA__" data-ssr="true">${JSON.stringify(values)}</script>`

describe('parseScheduleFixtures', () => {
    const fixtures = parseScheduleFixtures(schedule)

    it('finds the whole 2026 season: 9 preseason, 81 regular, 5 playoff', () => {
        expect(fixtures).toHaveLength(95)
    })

    it('reads the BetGenius id alongside the cfl.ca game id and kickoff', () => {
        expect(fixtures[0]).toEqual({
            cflGameId: 6582,
            fixtureId: 13419665,
            startAt: new Date('2026-05-18T19:00:00Z'),
        })
    })

    it('includes the fixtures the old discovery silently missed', () => {
        const ids = new Set(fixtures.map((f) => f.fixtureId))
        // Week 14 opener and the Western semi-final — both absent from prod
        // until this fix.
        expect(ids.has(13419724)).toBe(true)
        expect(ids.has(14617316)).toBe(true)
    })

    it('keeps the Grey Cup, which is listed before its teams are known', () => {
        expect(fixtures.map((f) => f.fixtureId)).toContain(13463068)
    })

    it('returns them in kickoff order', () => {
        const t = fixtures.map((f) => f.startAt?.getTime() ?? 0)
        expect(t).toEqual([...t].sort((a, b) => a - b))
    })

    it('returns nothing rather than throwing when the payload is absent or broken', () => {
        expect(parseScheduleFixtures('<html><body>no payload</body></html>')).toEqual([])
        expect(parseScheduleFixtures('<script id="__NUXT_DATA__">not json</script>')).toEqual([])
    })

    it('deduplicates a fixture referenced from more than one place', () => {
        // root -> [fixture, fixture-copy]; both carry genius id 7, only the
        // first knows its kickoff — and that is the copy to keep.
        const page = nuxtPage([
            [1, 1, 5],
            { ID: 2, genius: 3, start_at: 4, home_team_id: 2, away_team_id: 2 },
            10,
            { id: 6 },
            '2026-06-01T00:00:00Z',
            { ID: 2, genius: 3, home_team_id: 2, away_team_id: 2 },
            7,
        ])
        expect(parseScheduleFixtures(page)).toEqual([
            { cflGameId: 10, fixtureId: 7, startAt: new Date('2026-06-01T00:00:00Z') },
        ])
    })
    it('ignores teams and venues, which also carry ID and genius.id', () => {
        // A team object as the real page carries it under teams-primary.
        const page = nuxtPage([
            [1],
            { ID: 2, genius: 3, abbreviation: 4 },
            1,
            { id: 5 },
            'BC',
            93775,
        ])
        expect(parseScheduleFixtures(page)).toEqual([])
    })
})

describe('unflattenNuxtPayload', () => {
    it('unwraps Vue reactivity wrappers to their value', () => {
        expect(unflattenNuxtPayload([['ShallowReactive', 1], { a: 2 }, 'x'])).toEqual({ a: 'x' })
    })

    it('resolves a shared reference to the same object', () => {
        const out = unflattenNuxtPayload([{ a: 1, b: 1 }, { v: 2 }, 3]) as {
            a: object
            b: object
        }
        expect(out.a).toBe(out.b)
    })

    it('survives a cycle', () => {
        const out = unflattenNuxtPayload([{ self: 0 }]) as { self: unknown }
        expect(out.self).toBe(out)
    })

    it('rebuilds null-prototype objects', () => {
        expect(unflattenNuxtPayload([['null', 'k', 1], 'v'])).toEqual({ k: 'v' })
    })

    it('treats negative indices (devalue sentinels) as undefined', () => {
        expect(unflattenNuxtPayload([{ a: -1 }])).toEqual({ a: undefined })
    })
})
