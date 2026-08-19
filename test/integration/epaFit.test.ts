import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import { applyEpa, fitEpModel, refitAndApply } from '~/services/epa/fitEp.server'
import { parseGame } from '~/services/pbp/parsePlays.server'

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

/** A real captured game, parsed. */
async function seedParsedGame(year: number, id = FIXTURE_ID) {
    await db.game.create({ data: { id, response: PAYLOAD, year } })
    await parseGame(id)
}

/**
 * Enough parsed games to clear the 50-play sample threshold.
 *
 * ONE GAME IS NOT A CORPUS, and the model is right to refuse it: 138 plays
 * spread over three downs, four distance buckets and eleven field-position bands
 * leaves single-figure cells, and the lookup returns null rather than pricing a
 * state off nine plays. These tests therefore fit on a realistic amount of data
 * instead of lowering the threshold to make a thin fit pass.
 */
async function seedCorpus(games = 12, year = 2024) {
    for (let i = 0; i < games; i++) await seedParsedGame(year, CORPUS_BASE_ID + i)
}

const CORPUS_BASE_ID = 20000000

describe('fitEpModel', () => {
    it('fits a surface from parsed drives and stores the sample behind each cell', async () => {
        await seedTeams()
        await seedParsedGame(2024)

        const summary = await fitEpModel('PRE_2026')

        expect(summary.rows).toBeGreaterThan(0)
        expect(summary.cells).toBeGreaterThan(0)

        const cells = await db.epValue.findMany({ where: { ruleEra: 'PRE_2026' } })
        expect(cells).toHaveLength(summary.cells)
        // Every cell carries what it was built from — the honest measure of how
        // far to trust it.
        expect(cells.every((c) => c.sampleSize > 0)).toBe(true)
    })

    it('replaces an era wholesale rather than accumulating fits', async () => {
        await seedTeams()
        await seedParsedGame(2024)

        await fitEpModel('PRE_2026')
        const first = await db.epValue.count()
        await fitEpModel('PRE_2026')

        expect(await db.epValue.count()).toBe(first)
    })

    it('never mixes eras in one surface', async () => {
        await seedTeams()
        await seedParsedGame(2026)

        // The game is E2026, so a PRE_2026 fit has nothing to train on. Pooling
        // them would be the exact mistake the rule-era work exists to prevent.
        const summary = await fitEpModel('PRE_2026')

        expect(summary.rows).toBe(0)
        expect(await db.epValue.count({ where: { ruleEra: 'PRE_2026' } })).toBe(0)
    })

    it('fits an empty corpus without throwing', async () => {
        const summary = await fitEpModel('PRE_2026')

        expect(summary).toMatchObject({ rows: 0, cells: 0 })
    })
})

describe('applyEpa', () => {
    it('writes EPA onto plays from the fitted surface', async () => {
        await seedTeams()
        await seedCorpus()
        await fitEpModel('PRE_2026')

        const summary = await applyEpa()

        expect(summary.games).toBe(12)
        expect(summary.scored).toBeGreaterThan(0)
        expect(await db.play.count({ where: { epa: { not: null } } })).toBe(summary.scored)
    })

    it('leaves plays with no game state unpriced', async () => {
        await seedTeams()
        await seedCorpus()
        await fitEpModel('PRE_2026')
        await applyEpa()

        // Kickoffs and converts have no down and no line of scrimmage. Null
        // means "not measured"; zero would mean "measured as neutral".
        const kickoffs = await db.play.findMany({ where: { down: null }, select: { epa: true } })
        expect(kickoffs.length).toBeGreaterThan(0)
        expect(kickoffs.every((k) => k.epa === null)).toBe(true)
    })

    it('prices a 2026 game from the 2023/24 surface', async () => {
        await seedTeams()
        // Fit on a 2023/24 corpus, then price a 2026 game with it.
        await seedCorpus()
        await fitEpModel('PRE_2026')

        await seedParsedGame(2026)

        const summary = await applyEpa(2026)

        // 2026 did not change the field, so the older surface still prices it.
        expect(summary.games).toBe(1)
        expect(summary.skippedEra).toBe(0)
        expect(
            await db.play.count({ where: { gameId: FIXTURE_ID, epa: { not: null } } }),
        ).toBeGreaterThan(0)
    })

    it('refuses to price a 2027 game at all', async () => {
        await seedTeams()
        await seedCorpus()
        await fitEpModel('PRE_2026')

        await seedParsedGame(2027)

        const summary = await applyEpa(2027)

        // The field is 100 yards, the goalposts have moved, and field-position
        // value is not linear. No surface maps onto it, and a plausible wrong
        // number is worse than none.
        expect(summary.skippedEra).toBe(1)
        expect(await db.play.count({ where: { gameId: FIXTURE_ID, epa: { not: null } } })).toBe(0)
    })

    it('is idempotent — repricing twice gives the same numbers', async () => {
        await seedTeams()
        await seedCorpus()
        await fitEpModel('PRE_2026')

        await applyEpa()
        const first = await db.play.findMany({
            select: { id: true, epa: true },
            orderBy: { id: 'asc' },
        })
        await applyEpa()
        const second = await db.play.findMany({
            select: { id: true, epa: true },
            orderBy: { id: 'asc' },
        })

        expect(second).toEqual(first)
    })

    it('does nothing when no surface has been fitted', async () => {
        await seedTeams()
        await seedParsedGame(2024)

        const summary = await applyEpa()

        expect(summary.skippedEra).toBe(1)
        expect(await db.play.count({ where: { epa: { not: null } } })).toBe(0)
    })
})

describe('refitAndApply', () => {
    it('fits every era that is its own source, then prices everything', async () => {
        await seedTeams()
        await seedCorpus()

        const { fits, applied } = await refitAndApply()

        // E2026 is priced FROM PRE_2026, so fitting a separate 2026 surface
        // would build a table nothing reads.
        expect(fits.map((f) => f.era)).toEqual(['PRE_2026'])
        expect(applied.scored).toBeGreaterThan(0)
    })

    it('produces an expected-points curve that rises up the field', async () => {
        await seedTeams()
        await seedCorpus()
        await refitAndApply()

        const cells = await db.epValue.findMany({
            where: { ruleEra: 'PRE_2026', down: 1 },
            orderBy: { yardLineBucket: 'asc' },
        })

        // The one property any expected-points surface must have: field position
        // is worth more the closer you are to scoring. Checked as a trend across
        // the fitted cells rather than pair-by-pair, because a single game is far
        // too thin for every adjacent pair to be monotone.
        const own = cells.filter((c) => c.yardLineBucket <= 4)
        const opponent = cells.filter((c) => c.yardLineBucket >= 7)
        const mean = (xs: typeof cells) =>
            xs.reduce((sum, c) => sum + c.expectedPoints, 0) / (xs.length || 1)

        expect(own.length).toBeGreaterThan(0)
        expect(opponent.length).toBeGreaterThan(0)
        expect(mean(opponent)).toBeGreaterThan(mean(own))
    })
})
