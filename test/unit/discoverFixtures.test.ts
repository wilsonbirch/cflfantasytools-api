import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { gamePageUrl, parseFixtureId, parseGameLinks } from '~/services/pbp/discoverFixtures.server'

// Real markup, trimmed to the parts the parsers read. CFL publishes the
// BetGenius fixture id in the tracker embed on every game page, which is what
// makes discovery deterministic — 3DF's ids were found by probing the id space
// until one hit, then counting backwards to game one.
const schedule = readFileSync('test/fixtures/pbp/schedule.html', 'utf8')
const gamePage = readFileSync('test/fixtures/pbp/game-page.html', 'utf8')

describe('parseGameLinks', () => {
    it('extracts game ids and slugs from real schedule markup', () => {
        const links = parseGameLinks(schedule)
        expect(links.length).toBeGreaterThan(0)
        expect(links[0]).toEqual({
            cflGameId: 6582,
            slug: 'calgary-stampeders-vs-saskatchewan-roughriders',
        })
    })

    it('deduplicates a game linked more than once on the page', () => {
        const html = '<a href="https://www.cfl.ca/games/1/a-vs-b/">x</a>'.repeat(3)
        expect(parseGameLinks(html)).toHaveLength(1)
    })

    it('returns them in schedule order', () => {
        const ids = parseGameLinks(schedule).map((l) => l.cflGameId)
        expect(ids).toEqual([...ids].sort((a, b) => a - b))
    })

    it('returns nothing rather than throwing when the page has no games', () => {
        expect(parseGameLinks('<html><body>no games here</body></html>')).toEqual([])
    })
})

describe('parseFixtureId', () => {
    it('reads the fixture id out of the real tracker embed', () => {
        expect(parseFixtureId(gamePage)).toBe(13419665)
    })

    it('returns null when the embed is absent, so the game is skipped not fatal', () => {
        expect(parseFixtureId('<html><body>no tracker</body></html>')).toBeNull()
    })
})

describe('gamePageUrl', () => {
    it('builds the canonical game page url', () => {
        expect(gamePageUrl(6582, 'calgary-stampeders-vs-saskatchewan-roughriders')).toBe(
            'https://www.cfl.ca/games/6582/calgary-stampeders-vs-saskatchewan-roughriders/',
        )
    })
})
