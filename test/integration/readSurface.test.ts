import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import { parseGame } from '~/services/pbp/parsePlays.server'
import { executeOperation } from './setup/yogaClient'

// The same captured fixture pbpParse.test.ts uses: Calgary (112939) at home to
// Saskatchewan (106752), 2026 preseason week 1, 138 plays over 30 drives.
const PAYLOAD = readFileSync('test/fixtures/pbp/widget-payload.json', 'utf8')
const FIXTURE_ID = 13419665

async function seedTeams() {
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
    return { cgy, ssk }
}

async function seedParsedGame() {
    await db.game.create({ data: { id: FIXTURE_ID, response: PAYLOAD, year: 2026 } })
    await parseGame(FIXTURE_ID)
}

describe('teams', () => {
    it('lists teams alphabetically and finds one by slug', async () => {
        await seedTeams()
        const r = await executeOperation<{
            teams: { slug: string }[]
            team: { abbreviation: string; nameFr: string | null } | null
        }>({
            query: '{ teams { slug } team(slug: "saskatchewan") { abbreviation nameFr } }',
        })
        expect(r.errors).toBeUndefined()
        expect(r.data?.teams.map((t) => t.slug)).toEqual(['calgary', 'saskatchewan'])
        expect(r.data?.team).toEqual({ abbreviation: 'SSK', nameFr: null })
    })

    it('returns null for an unknown slug rather than erroring', async () => {
        const r = await executeOperation<{ team: null }>({ query: '{ team(slug: "nope") { id } }' })
        expect(r.errors).toBeUndefined()
        expect(r.data?.team).toBeNull()
    })
})

describe('depth charts', () => {
    it('exposes years and lists with their charts, newest chart first', async () => {
        const { cgy } = await seedTeams()
        for (const year of [2025, 2026]) {
            const list = await db.depthChartList.create({ data: { teamId: cgy.id, year } })
            for (const week of [1, 2]) {
                await db.depthChart.create({
                    data: {
                        teamId: cgy.id,
                        depthChartListId: list.id,
                        title: `Week ${week}`,
                        value: `https://example.test/${year}/w${week}.pdf`,
                        year,
                        season: 'regular',
                        week,
                        publishedAt: new Date(Date.UTC(year, 6, week)),
                    },
                })
            }
        }

        const r = await executeOperation<{
            depthChartYears: number[]
            depthChartLists: {
                year: number
                team: { slug: string }
                charts: { title: string; url: string; week: number; detectedAt: string }[]
            }[]
            all: { year: number }[]
        }>({
            query: `{
                depthChartYears(teamSlug: "calgary")
                depthChartLists(teamSlug: "calgary", year: 2026) {
                    year team { slug } charts { title url week detectedAt }
                }
                all: depthChartLists(teamSlug: "calgary") { year }
            }`,
        })
        expect(r.errors).toBeUndefined()
        expect(r.data?.depthChartYears).toEqual([2026, 2025])
        expect(r.data?.depthChartLists).toHaveLength(1)
        const list = r.data!.depthChartLists[0]
        expect(list.team.slug).toBe('calgary')
        expect(list.charts.map((c) => c.week)).toEqual([2, 1])
        expect(list.charts[0].url).toBe('https://example.test/2026/w2.pdf')
        expect(list.charts[0].detectedAt).toBeTruthy()
        expect(r.data?.all.map((l) => l.year)).toEqual([2026, 2025])
    })

    it('is empty for a team with no charts', async () => {
        const r = await executeOperation<{ depthChartYears: number[] }>({
            query: '{ depthChartYears(teamSlug: "nobody") }',
        })
        expect(r.data?.depthChartYears).toEqual([])
    })
})

describe('seasons', () => {
    it('lists every year with a game or a fixture, newest first, without duplicates', async () => {
        await seedTeams()
        await db.game.create({ data: { id: 1, response: '{}', year: 2024 } })
        await db.game.create({ data: { id: 2, response: '{}', year: 2026 } })
        const gw = await db.gameweek.create({
            data: { gameZoneId: 1, name: 'Week 1', status: 'x', year: 2026 },
        })
        await db.match.create({
            data: { gameZoneId: 1, gameweekId: gw.id, status: 'x', year: 2025 },
        })
        await db.match.create({
            data: { gameZoneId: 2, gameweekId: gw.id, status: 'x', year: 2026 },
        })
        const r = await executeOperation<{ seasons: number[] }>({ query: '{ seasons }' })
        expect(r.errors).toBeUndefined()
        expect(r.data?.seasons).toEqual([2026, 2025, 2024])
    })

    it('is empty on a fresh database', async () => {
        const r = await executeOperation<{ seasons: number[] }>({ query: '{ seasons }' })
        expect(r.data?.seasons).toEqual([])
    })
})

describe('games', () => {
    it('exposes a parsed game with teams, score, drives, plays and stats', async () => {
        await seedTeams()
        await seedParsedGame()

        const r = await executeOperation<{
            game: {
                id: number
                year: number
                ruleEra: string
                date: string
                homeTeam: { abbreviation: string }
                awayTeam: { abbreviation: string }
                homeScore: number
                awayScore: number
                drives: { number: number; team: { abbreviation: string }; points: number | null }[]
                plays: {
                    number: number
                    driveNumber: number
                    quarter: number | null
                    isNoPlay: boolean
                    team: { abbreviation: string }
                }[]
                boxScore: {
                    team: { abbreviation: string }
                    points: number
                    passAttempts: number
                    completions: number
                    totalYards: number
                }[]
                playerStats: {
                    player: string
                    gameId: number
                    team: { abbreviation: string }
                    targets: number
                    receptions: number
                    targetsByZone: { depth: string; direction: string; targets: number }[]
                }[]
            }
        }>({
            query: `{ game(id: ${FIXTURE_ID}) {
                id year ruleEra date
                homeTeam { abbreviation } awayTeam { abbreviation } homeScore awayScore
                drives { number team { abbreviation } points }
                plays { number driveNumber quarter isNoPlay team { abbreviation } }
                boxScore { team { abbreviation } points passAttempts completions totalYards }
                playerStats { player gameId team { abbreviation } targets receptions
                    targetsByZone { depth direction targets } }
            } }`,
        })
        expect(r.errors).toBeUndefined()
        const g = r.data!.game
        expect(g).toMatchObject({
            id: FIXTURE_ID,
            year: 2026,
            ruleEra: 'E2026',
            date: '2026-05-18T19:00:00.000Z',
            homeTeam: { abbreviation: 'CGY' },
            awayTeam: { abbreviation: 'SSK' },
        })
        expect(g.drives).toHaveLength(30)
        expect(g.drives.map((d) => d.number)).toEqual([...Array(30).keys()])
        expect(g.plays).toHaveLength(138)
        // Chronological: drive numbers never decrease.
        const driveNumbers = g.plays.map((p) => p.driveNumber)
        expect([...driveNumbers].sort((a, b) => a - b)).toEqual(driveNumbers)
        expect(g.plays[0].quarter).toBe(1)
        expect(g.plays.at(-1)?.quarter).toBe(4)

        // Scores agree with the box score and with the signed drive points.
        const box = Object.fromEntries(g.boxScore.map((b) => [b.team.abbreviation, b]))
        expect(g.homeScore).toBe(box.CGY.points)
        expect(g.awayScore).toBe(box.SSK.points)
        const driveTotal = (abbr: string) =>
            g.drives.reduce(
                (sum, d) =>
                    sum +
                    (d.team.abbreviation === abbr ? Math.max(d.points ?? 0, 0) : 0) +
                    (d.team.abbreviation !== abbr ? Math.max(-(d.points ?? 0), 0) : 0),
                0,
            )
        expect(g.homeScore).toBe(driveTotal('CGY'))
        expect(g.awayScore).toBe(driveTotal('SSK'))
        expect(g.homeScore! + g.awayScore!).toBeGreaterThan(0)
        expect(box.CGY.completions).toBeLessThanOrEqual(box.CGY.passAttempts)
        expect(box.CGY.totalYards).toBeGreaterThan(0)

        // Player lines: every player carries the game id, and a targeted
        // receiver's zones sum to their targets.
        expect(g.playerStats.length).toBeGreaterThan(10)
        expect(g.playerStats.every((p) => p.gameId === FIXTURE_ID)).toBe(true)
        const top = g.playerStats.find((p) => p.targets > 0)!
        expect(top.targetsByZone.reduce((s, z) => s + z.targets, 0)).toBeLessThanOrEqual(
            top.targets,
        )
        expect(top.receptions).toBeLessThanOrEqual(top.targets)
    })

    it('excludes no-plays from stats but keeps them in the play list', async () => {
        await seedTeams()
        await seedParsedGame()
        const noPlays = await db.play.count({ where: { isNoPlay: true } })
        expect(noPlays).toBeGreaterThan(0)

        const r = await executeOperation<{
            game: { plays: { isNoPlay: boolean }[]; boxScore: { plays: number }[] }
        }>({ query: `{ game(id: ${FIXTURE_ID}) { plays { isNoPlay } boxScore { plays } } }` })
        expect(r.data?.game.plays.filter((p) => p.isNoPlay)).toHaveLength(noPlays)
        const scrimmage = await db.play.count({
            where: { isNoPlay: false, type: { in: ['Pass', 'Run'] } },
        })
        // Not every Pass/Run row names a passer or rusher (spikes, aborted
        // snaps), so the box score may count fewer — never more.
        expect(r.data!.game.boxScore.reduce((s, b) => s + b.plays, 0)).toBeLessThanOrEqual(
            scrimmage,
        )
    })

    it('lists games by year and team, newest first, skipping unparsed ones', async () => {
        await seedTeams()
        await seedParsedGame()
        await db.game.create({ data: { id: 1, response: '{}', year: 2026 } })
        await db.game.create({ data: { id: 2, response: '{}', year: 2025, playCount: 3 } })

        const r = await executeOperation<{
            games: { id: number }[]
            ssk: { id: number }[]
            none: { id: number }[]
            paged: { id: number }[]
        }>({
            query: `{
                games(year: 2026) { id }
                ssk: games(year: 2026, teamSlug: "saskatchewan") { id }
                none: games(year: 2026, teamSlug: "nobody") { id }
                paged: games(year: 2026, offset: 1) { id }
            }`,
        })
        expect(r.errors).toBeUndefined()
        expect(r.data?.games.map((g) => g.id)).toEqual([FIXTURE_ID])
        expect(r.data?.ssk.map((g) => g.id)).toEqual([FIXTURE_ID])
        expect(r.data?.none).toEqual([])
        expect(r.data?.paged).toEqual([])
    })

    it('returns null for an unknown game', async () => {
        const r = await executeOperation<{ game: null }>({ query: '{ game(id: 42) { id } }' })
        expect(r.errors).toBeUndefined()
        expect(r.data?.game).toBeNull()
    })

    it('leaves score and teams null for a game whose metadata was never parsed', async () => {
        await seedTeams()
        await db.game.create({ data: { id: 7, response: '{}', year: 2026, playCount: 1 } })
        const r = await executeOperation<{
            game: { homeTeam: null; homeScore: null; awayScore: null; boxScore: unknown[] }
        }>({ query: '{ game(id: 7) { homeTeam { id } homeScore awayScore boxScore { points } } }' })
        expect(r.errors).toBeUndefined()
        expect(r.data?.game).toEqual({
            homeTeam: null,
            homeScore: null,
            awayScore: null,
            boxScore: [],
        })
    })
})

describe('playerSeasonStats', () => {
    it('aggregates a season per player and team, with paging', async () => {
        await seedTeams()
        await seedParsedGame()

        const r = await executeOperation<{
            playerSeasonStats: {
                player: string
                year: number
                games: number
                team: { abbreviation: string }
                targets: number
                passAttempts: number
                rushAttempts: number
            }[]
            ssk: { team: { abbreviation: string } }[]
            page: { player: string }[]
            empty: unknown[]
        }>({
            query: `{
                playerSeasonStats(year: 2026) {
                    player year games team { abbreviation } targets passAttempts rushAttempts
                }
                ssk: playerSeasonStats(year: 2026, teamSlug: "saskatchewan") { team { abbreviation } }
                page: playerSeasonStats(year: 2026, limit: 2, offset: 1) { player }
                empty: playerSeasonStats(year: 1999) { player }
            }`,
        })
        expect(r.errors).toBeUndefined()
        const all = r.data!.playerSeasonStats
        expect(all.length).toBeGreaterThan(10)
        expect(all[0]).toMatchObject({ year: 2026, games: 1 })
        const involvement = (p: (typeof all)[number]) => p.targets + p.passAttempts + p.rushAttempts
        expect(involvement(all[0])).toBeGreaterThanOrEqual(involvement(all[1]))
        expect(r.data?.ssk.every((p) => p.team.abbreviation === 'SSK')).toBe(true)
        expect(r.data?.ssk.length).toBeLessThan(all.length)
        expect(r.data?.page.map((p) => p.player)).toEqual(all.slice(1, 3).map((p) => p.player))
        expect(r.data?.empty).toEqual([])
    })
})
