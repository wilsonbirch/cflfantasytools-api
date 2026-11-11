import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import { toStoredPayload } from '~/services/pbp/capturePbp.server'
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

// Montreal (86680) v Ottawa (88019), 2026 week 12, final 46–16. Carries a
// pick-six stamped with the team that threw it and a touchdown that stood
// under a flag — the two cases that made the play sum read 34–22.
const MTL_OTT = readFileSync('test/fixtures/pbp/widget-payload-13419716.json', 'utf8')
const MTL_OTT_ID = 13419716

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

    it('stores the official final and signs scores by whose goal line was reached', async () => {
        await seedTeams()
        await db.team.create({
            data: {
                slug: 'montreal',
                abbreviation: 'MTL',
                name: 'Montreal',
                geniusTeamId: '86680',
            },
        })
        await db.team.create({
            data: { slug: 'ottawa', abbreviation: 'OTT', name: 'Ottawa', geniusTeamId: '88019' },
        })
        await db.game.create({ data: { id: MTL_OTT_ID, response: MTL_OTT, year: 2026 } })
        await parseGame(MTL_OTT_ID)

        const game = await db.game.findUniqueOrThrow({ where: { id: MTL_OTT_ID } })
        expect(game).toMatchObject({
            homeGeniusTeamId: '86680',
            awayGeniusTeamId: '88019',
            homeScore: 46,
            awayScore: 16,
        })

        // The play sum agrees with the official final once a touchdown at the
        // play team's own goal line counts for the opponent and a touchdown
        // under a non-nullifying flag counts at all.
        const plays = await db.play.findMany({
            where: { gameId: MTL_OTT_ID },
            select: { geniusTeamId: true, points: true },
        })
        const sum = (team: string) =>
            plays.reduce(
                (n, p) =>
                    n +
                    (p.geniusTeamId === team ? Math.max(p.points ?? 0, 0) : 0) +
                    (p.geniusTeamId !== team ? Math.max(-(p.points ?? 0), 0) : 0),
                0,
            )
        expect(sum('86680')).toBe(46)
        expect(sum('88019')).toBe(16)
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

    it('re-parses a game whose hash predates the current parser version', async () => {
        await seedTeams()
        await seedGame()
        await parseStoredGames(2026)

        // A row left by an older parser: the unversioned md5(response) that v1
        // wrote, and the hash every production game carried before this shipped.
        // No payload changed, no operator forced anything — the version bump
        // alone must make it stale, or a parser fix never reaches stored games.
        await db.$executeRaw`UPDATE "Game" SET "parsedHash" = md5("response") WHERE id = ${FIXTURE_ID}`

        const upgraded = await parseStoredGames(2026)
        expect(upgraded.games).toBe(1)
        expect((await parseStoredGames(2026)).games).toBe(0)
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

describe('fixture metadata', () => {
    it('lifts home, away and kickoff time out of matchInfo so reads never open the blob', async () => {
        await seedTeams()
        await seedGame()
        await parseGame(FIXTURE_ID)
        const game = await db.game.findUniqueOrThrow({ where: { id: FIXTURE_ID } })
        expect(game.homeGeniusTeamId).toBe(CGY)
        expect(game.awayGeniusTeamId).toBe(SSK)
        expect(game.startedAt?.toISOString()).toBe('2026-05-18T19:00:00.000Z')
    })

    it('leaves an unknown club null rather than failing the foreign key', async () => {
        await seedTeams()
        const payload = JSON.parse(PAYLOAD)
        payload.data.matchInfo.awayTeam.competitorId = '999999'
        payload.data.matchInfo.scheduledStartTime = 'not a date'
        await seedGame(2026, JSON.stringify(payload))
        await parseGame(FIXTURE_ID)
        const game = await db.game.findUniqueOrThrow({ where: { id: FIXTURE_ID } })
        expect(game.homeGeniusTeamId).toBe(CGY)
        expect(game.awayGeniusTeamId).toBeNull()
        expect(game.startedAt).toBeNull()
    })
})

// The same MTL v OTT game as captured from the per-widget feeds that replaced
// the old endpoint in 2026. Whatever the parser makes of it must match what it
// makes of the old capture — otherwise the season would split at the switch.
describe('parseGame on a payload from the new feeds', () => {
    const NEW_FEED = JSON.stringify(
        toStoredPayload(
            JSON.parse(readFileSync('test/fixtures/pbp/feed-playbyplay-13419716.json', 'utf8')),
            JSON.parse(readFileSync('test/fixtures/pbp/feed-scoreboard-13419716.json', 'utf8')),
        ),
    )

    async function parseBoth() {
        await db.team.create({
            data: {
                slug: 'montreal',
                abbreviation: 'MTL',
                name: 'Montreal',
                geniusTeamId: '86680',
            },
        })
        await db.team.create({
            data: { slug: 'ottawa', abbreviation: 'OTT', name: 'Ottawa', geniusTeamId: '88019' },
        })
        const OLD_ID = MTL_OTT_ID
        const NEW_ID = MTL_OTT_ID + 1
        await db.game.create({ data: { id: OLD_ID, response: MTL_OTT, year: 2026 } })
        await db.game.create({ data: { id: NEW_ID, response: NEW_FEED, year: 2026 } })
        return { old: await parseGame(OLD_ID), now: await parseGame(NEW_ID), OLD_ID, NEW_ID }
    }

    it('produces the same drives and plays as the old capture', async () => {
        const { old, now, NEW_ID } = await parseBoth()
        expect(now).toEqual({ ...old, gameId: NEW_ID })
    })

    it('stores the same teams, kickoff and official final', async () => {
        const { OLD_ID, NEW_ID } = await parseBoth()
        const pick = {
            homeGeniusTeamId: true,
            awayGeniusTeamId: true,
            homeScore: true,
            awayScore: true,
            startedAt: true,
            ruleEra: true,
        } as const
        const old = await db.game.findUniqueOrThrow({ where: { id: OLD_ID }, select: pick })
        const now = await db.game.findUniqueOrThrow({ where: { id: NEW_ID }, select: pick })
        expect(now).toEqual(old)
        expect(now).toMatchObject({ homeScore: 46, awayScore: 16 })
    })

    it('scores every play the same way', async () => {
        const { OLD_ID, NEW_ID } = await parseBoth()
        const rows = (gameId: number) =>
            db.play.findMany({
                where: { gameId },
                orderBy: [{ timestamp: 'asc' }],
                select: {
                    number: true,
                    type: true,
                    subtype: true,
                    points: true,
                    isComplete: true,
                    down: true,
                    distance: true,
                    yardLine: true,
                },
            })
        const [old, now] = await Promise.all([rows(OLD_ID), rows(NEW_ID)])
        expect(now).toHaveLength(old.length)
        // Play 1-3 carries a start position Genius filled in after the old
        // capture, so its down/distance/yard line legitimately differ.
        const differing = now.filter((p, i) => JSON.stringify(p) !== JSON.stringify(old[i]))
        expect(differing.length).toBeLessThanOrEqual(1)
    })
})

// Ottawa (88019) v Winnipeg (110380), 2023 week 6, final 31–28 — verbatim from
// the legacy 3DF database. 225 rows, 71 of them ghost copies of the next drive
// left on the end of the previous one under the wrong team's id: summed as
// given, the play by play read 49–51.
const OTT_WPG_2023 = readFileSync('test/fixtures/pbp/legacy-payload-9889304.json', 'utf8')
const OTT_WPG_2023_ID = 9889304

describe('parseGame on a legacy 2023 payload', () => {
    const OTT = '88019'
    const WPG = '110380'

    async function seed(year: number) {
        await db.team.create({
            data: { slug: 'ottawa', abbreviation: 'OTT', name: 'Ottawa', geniusTeamId: OTT },
        })
        await db.team.create({
            data: { slug: 'winnipeg', abbreviation: 'WPG', name: 'Winnipeg', geniusTeamId: WPG },
        })
        await db.game.create({ data: { id: OTT_WPG_2023_ID, response: OTT_WPG_2023, year } })
        return parseGame(OTT_WPG_2023_ID)
    }

    const playSum = async () => {
        const plays = await db.play.findMany({
            where: { gameId: OTT_WPG_2023_ID },
            select: { geniusTeamId: true, points: true },
        })
        const sum = (team: string) =>
            plays.reduce(
                (n, p) =>
                    n +
                    (p.geniusTeamId === team ? Math.max(p.points ?? 0, 0) : 0) +
                    (p.geniusTeamId !== team ? Math.max(-(p.points ?? 0), 0) : 0),
                0,
            )
        return { OTT: sum(OTT), WPG: sum(WPG) }
    }

    it('drops the ghost rows, so the play by play reaches the official final', async () => {
        const result = await seed(2023)

        expect(result?.plays).toBe(225 - 71)
        expect(await playSum()).toEqual({ OTT: 31, WPG: 28 })
        // No Winnipeg quarterback left playing for Ottawa.
        expect(
            await db.play.count({
                where: { gameId: OTT_WPG_2023_ID, geniusTeamId: OTT, passer: '#8 Z.Collaros' },
            }),
        ).toBe(0)
    })

    it('labels a drive by the score that actually followed it', async () => {
        await seed(2023)
        // Ottawa's opening three-and-out. Its ghost tail held Winnipeg's field
        // goal under Ottawa's id, so the label read +3 for Ottawa. The next score
        // was Winnipeg's: -3.
        const drive = await db.drive.findUniqueOrThrow({
            where: { gameId_number: { gameId: OTT_WPG_2023_ID, number: 2 } },
            include: { Plays: true },
        })
        expect(drive.geniusTeamId).toBe(OTT)
        expect(drive.Plays).toHaveLength(3)
        expect(drive.points).toBeNull()
        expect(drive.nextPointOutcome).toBe(-3)
    })

    it('leaves the same payload untouched when it is not from the legacy era', async () => {
        // The repair is scoped to PRE_2026: a 2026 game parses exactly as before.
        const result = await seed(2026)
        expect(result?.plays).toBe(225)
    })
})
