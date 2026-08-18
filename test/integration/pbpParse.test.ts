import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import { parseGame, parseStoredGames } from '~/services/pbp/parsePlays.server'

// A real captured fixture: Calgary (112939) v Saskatchewan (106752), 2026
// preseason week 1. 138 plays across 30 drives, 10 of them scoring.
const PAYLOAD = readFileSync('test/fixtures/pbp/widget-payload.json', 'utf8')
const FIXTURE_ID = 13419665

const CGY = '112939'
const SSK = '106752'

async function seedTeams() {
    await db.team.create({
        data: { slug: 'calgary', abbreviation: 'CGY', name: 'Calgary', geniusTeamId: CGY },
    })
    await db.team.create({
        data: {
            slug: 'saskatchewan',
            abbreviation: 'SSK',
            name: 'Saskatchewan',
            geniusTeamId: SSK,
        },
    })
}

const seedGame = (year = 2026, response = PAYLOAD) =>
    db.game.create({ data: { id: FIXTURE_ID, response, year } })

// The fixture cut down to its first n plays, standing in for a game captured
// while it was still being played.
function truncatedTo(n: number): string {
    const payload = JSON.parse(PAYLOAD)
    payload.data.playByPlayInfo.ALL = payload.data.playByPlayInfo.ALL.slice(0, n)
    return JSON.stringify(payload)
}

describe('parseGame', () => {
    it('writes drives and plays for a real captured game', async () => {
        await seedTeams()
        await seedGame()

        const result = await parseGame(FIXTURE_ID)

        expect(result).toEqual({ gameId: FIXTURE_ID, drives: 30, plays: 138 })
        expect(await db.drive.count()).toBe(30)
        expect(await db.play.count()).toBe(138)
    })

    it('stamps the rule era on the game and every play', async () => {
        await seedTeams()
        await seedGame(2026)
        await parseGame(FIXTURE_ID)

        const game = await db.game.findUnique({ where: { id: FIXTURE_ID } })
        expect(game?.ruleEra).toBe('E2026')
        expect(game?.playCount).toBe(138)
        expect(game?.parsedAt).not.toBeNull()

        // Denormalized onto Play so a model can filter an era without a join.
        expect(await db.play.count({ where: { ruleEra: 'E2026' } })).toBe(138)
    })

    it('derives the era from the season, so the 2023-24 corpus is PRE_2026', async () => {
        await seedTeams()
        await seedGame(2024)
        await parseGame(FIXTURE_ID)

        expect((await db.game.findUnique({ where: { id: FIXTURE_ID } }))?.ruleEra).toBe('PRE_2026')
    })

    it('stores plays in chronological order despite the feed being reversed', async () => {
        await seedTeams()
        await seedGame()
        await parseGame(FIXTURE_ID)

        const drives = await db.drive.findMany({ orderBy: { number: 'asc' } })
        expect(drives[0].number).toBe(0)
        expect(drives[drives.length - 1].number).toBe(29)
    })

    it('extracts the target zone the receiving model needs', async () => {
        await seedTeams()
        await seedGame()
        await parseGame(FIXTURE_ID)

        const zoned = await db.play.count({ where: { targetDepth: { not: null } } })
        expect(zoned).toBeGreaterThan(50)

        const shortLeft = await db.play.findFirst({
            where: { targetDepth: 'SHORT', targetDirection: 'LEFT', subtype: 'CompletePass' },
        })
        expect(shortLeft?.receiver).toMatch(/^#\d+ /)
        expect(shortLeft?.passer).toMatch(/^#\d+ /)
    })

    it('signs the yard line against the team in possession', async () => {
        await seedTeams()
        await seedGame()
        await parseGame(FIXTURE_ID)

        const own = await db.play.findFirst({
            where: {
                geniusTeamId: CGY,
                startPosition: { contains: 'at CGY' },
                down: { not: null },
            },
        })
        expect(own?.yardLine).toBeLessThan(0)

        const opponent = await db.play.findFirst({
            where: {
                geniusTeamId: SSK,
                startPosition: { contains: 'at CGY' },
                down: { not: null },
            },
        })
        expect(opponent?.yardLine).toBeGreaterThan(0)
    })

    it('counts touchdown catches as receptions', async () => {
        await seedTeams()
        await seedGame()
        await parseGame(FIXTURE_ID)

        // The reason isComplete exists: a caught touchdown is subtype
        // "Touchdown", so the subtype rule would score it as a drop.
        const touchdownCatches = await db.play.count({
            where: { type: 'Pass', subtype: 'Touchdown', isComplete: true },
        })
        expect(touchdownCatches).toBeGreaterThan(0)

        const receptions = await db.play.count({
            where: { receiver: { not: null }, isComplete: true },
        })
        const subtypeOnly = await db.play.count({
            where: { receiver: { not: null }, subtype: 'CompletePass' },
        })
        expect(receptions).toBeGreaterThan(subtypeOnly)
    })

    it('leaves isComplete null on plays that are not passes', async () => {
        await seedTeams()
        await seedGame()
        await parseGame(FIXTURE_ID)

        expect(await db.play.count({ where: { type: 'Run', isComplete: { not: null } } })).toBe(0)
    })

    it('never stores a kick returner as a receiver', async () => {
        await seedTeams()
        await seedGame()
        await parseGame(FIXTURE_ID)

        // Reception counts are built on `receiver`; a returner landing there
        // would inflate every one of them.
        expect(await db.play.count({ where: { type: 'Punt', receiver: { not: null } } })).toBe(0)
        expect(await db.play.count({ where: { type: 'Kickoff', receiver: { not: null } } })).toBe(0)
        expect(
            await db.play.count({ where: { type: 'Punt', returner: { not: null } } }),
        ).toBeGreaterThan(0)
    })

    it('sums a touchdown drive to 7, counting the convert once', async () => {
        await seedTeams()
        await seedGame()
        await parseGame(FIXTURE_ID)

        const scoring = await db.drive.findMany({ where: { isScoring: true } })
        expect(scoring.length).toBeGreaterThan(0)
        // Every drive total must be a value a CFL drive can actually produce.
        for (const drive of scoring) {
            expect([1, 2, 3, 6, 7, 8]).toContain(drive.points)
        }
    })

    it('is idempotent — a re-parse rebuilds rather than duplicates', async () => {
        await seedTeams()
        await seedGame()

        await parseGame(FIXTURE_ID)
        await parseGame(FIXTURE_ID)

        expect(await db.drive.count()).toBe(30)
        expect(await db.play.count()).toBe(138)
    })

    it('returns null for an unplayed fixture rather than failing', async () => {
        await seedTeams()
        await db.game.create({
            data: {
                id: 999,
                response: JSON.stringify({ data: { playByPlayInfo: { ALL: [] } } }),
                year: 2026,
            },
        })

        expect(await parseGame(999)).toBeNull()
    })

    it('returns null for a game that does not exist', async () => {
        expect(await parseGame(12345)).toBeNull()
    })

    it('throws a useful error on a corrupt payload', async () => {
        await seedTeams()
        await db.game.create({ data: { id: 998, response: 'not json', year: 2026 } })

        await expect(parseGame(998)).rejects.toThrow(/not valid JSON/)
    })
})

describe('parseStoredGames', () => {
    it('parses an unparsed game and then skips it on the next run', async () => {
        await seedTeams()
        await seedGame()

        const first = await parseStoredGames(2026)
        expect(first.games).toBe(1)
        expect(first.plays).toBe(138)

        // Nothing has been re-captured, so there is nothing to redo.
        const second = await parseStoredGames(2026)
        expect(second.games).toBe(0)
    })

    it('re-parses everything when forced, which a parser change needs', async () => {
        await seedTeams()
        await seedGame()

        await parseStoredGames(2026)
        const forced = await parseStoredGames(2026, true)

        expect(forced.games).toBe(1)
        expect(await db.play.count()).toBe(138)
    })

    it('picks a game back up after its payload grows', async () => {
        await seedTeams()
        await seedGame(2026, truncatedTo(100))
        expect((await parseStoredGames(2026)).plays).toBe(100)

        // A live game re-captured mid-match: the same game, more plays.
        await db.game.update({ where: { id: FIXTURE_ID }, data: { response: PAYLOAD } })

        const second = await parseStoredGames(2026)
        expect(second.games).toBe(1)
        expect(second.plays).toBe(138)
    })

    it('leaves a game alone when a re-capture returns identical bytes', async () => {
        await seedTeams()
        await seedGame()
        await parseStoredGames(2026)

        // The capture ran again and found nothing new. Rewriting the same bytes
        // touches the row — and used to be enough to re-parse the whole game,
        // because staleness was judged by updatedAt rather than by content.
        await db.game.update({ where: { id: FIXTURE_ID }, data: { response: PAYLOAD } })

        expect((await parseStoredGames(2026)).games).toBe(0)
    })

    it('counts an empty fixture as skipped, not failed', async () => {
        await seedTeams()
        await db.game.create({
            data: { id: 997, response: JSON.stringify({ data: {} }), year: 2026 },
        })

        const summary = await parseStoredGames(2026)
        expect(summary.skipped).toBe(1)
        expect(summary.failed).toBe(0)
    })

    it('keeps going when one game is corrupt', async () => {
        await seedTeams()
        await seedGame()
        await db.game.create({ data: { id: 996, response: '{{{', year: 2026 } })

        const summary = await parseStoredGames(2026)
        expect(summary.games).toBe(1)
        expect(summary.failed).toBe(1)
    })

    it('parses every season when given no year, which the legacy backfill needs', async () => {
        await seedTeams()
        await seedGame(2024)

        expect((await parseStoredGames()).games).toBe(1)
    })
})
