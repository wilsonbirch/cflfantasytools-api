import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import {
    importLegacyGames,
    type LegacyGameRow,
    type LegacyGameReader,
} from '~/services/pbp/importLegacyGames.server'
import { parseStoredGames } from '~/services/pbp/parsePlays.server'

const PAYLOAD = readFileSync('test/fixtures/pbp/widget-payload.json', 'utf8')

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

/**
 * The captured 2026 fixture re-stamped as a legacy row.
 *
 * The 2023/24 payloads carry a superset of the 2026 fixture's keys and an
 * identical play object schema — verified across all 190 rows in the dump — so
 * the fixture stands in for one faithfully once it carries the legacy row's
 * `betGeniusFixtureId`.
 */
function legacyRow(id: number, year: number, empty = false): LegacyGameRow {
    const payload = JSON.parse(PAYLOAD)
    payload.data.betGeniusFixtureId = String(id)
    if (empty) payload.data.playByPlayInfo.ALL = []
    return { id, year, response: JSON.stringify(payload) }
}

const readerFor =
    (rows: LegacyGameRow[]): LegacyGameReader =>
    async (years) =>
        rows.filter((r) => years.includes(r.year))

describe('importLegacyGames', () => {
    it('imports the 2023/24 corpus and leaves 2022 behind', async () => {
        const read = readerFor([
            legacyRow(9888986, 2022),
            legacyRow(9888987, 2023),
            legacyRow(9888988, 2024),
        ])

        const summary = await importLegacyGames(read)

        expect(summary).toMatchObject({ read: 2, imported: 2 })
        expect(await db.game.count()).toBe(2)
        // 2022 is a partial capture; it must never reach the corpus.
        expect(await db.game.findUnique({ where: { id: 9888986 } })).toBeNull()
    })

    it('stores the year from the legacy row, which is what era scoping keys on', async () => {
        await importLegacyGames(readerFor([legacyRow(9888987, 2023), legacyRow(9888988, 2024)]))

        expect((await db.game.findUnique({ where: { id: 9888987 } }))?.year).toBe(2023)
        expect((await db.game.findUnique({ where: { id: 9888988 } }))?.year).toBe(2024)
    })

    it('leaves imported games unparsed so pbp-parse picks them up', async () => {
        await importLegacyGames(readerFor([legacyRow(9888987, 2023)]))

        const game = await db.game.findUnique({ where: { id: 9888987 } })
        // A null parsedHash is precisely what makes the game read as stale. Any
        // value here would claim a parse that never ran and silently exclude the
        // game from the corpus.
        expect(game?.parsedHash).toBeNull()
        expect(game?.parsedAt).toBeNull()
        expect(game?.playCount).toBeNull()
    })

    it('hands the imported games to the existing parser, era-stamped', async () => {
        await seedTeams()
        await importLegacyGames(readerFor([legacyRow(9888987, 2023)]))

        // The whole point of importing rather than back-filling Drive/Play
        // directly: one parser, one path into the model corpus.
        const parsed = await parseStoredGames()

        expect(parsed.games).toBe(1)
        expect(parsed.plays).toBe(138)
        expect(await db.play.count({ where: { ruleEra: 'PRE_2026' } })).toBe(138)
        expect(await db.drive.count()).toBe(30)
    })

    it('skips a fixture already present rather than overwriting it', async () => {
        await db.game.create({ data: { id: 9888987, response: '{"data":{}}', year: 2026 } })

        const summary = await importLegacyGames(readerFor([legacyRow(9888987, 2023)]))

        // Fixture ids share one space across seasons. A legacy row landing on a
        // live capture would destroy the present to recover the past.
        expect(summary).toMatchObject({ imported: 0, skippedExisting: 1 })
        const game = await db.game.findUnique({ where: { id: 9888987 } })
        expect(game?.response).toBe('{"data":{}}')
        expect(game?.year).toBe(2026)
    })

    it('overwrites an existing fixture only when forced', async () => {
        await db.game.create({ data: { id: 9888987, response: '{"data":{}}', year: 2026 } })

        const summary = await importLegacyGames(readerFor([legacyRow(9888987, 2023)]), {
            force: true,
        })

        expect(summary).toMatchObject({ imported: 0, updated: 1 })
        const game = await db.game.findUnique({ where: { id: 9888987 } })
        expect(game?.year).toBe(2023)
        expect(game?.response).not.toBe('{"data":{}}')
    })

    it('skips an unplayed fixture without counting it as a fault', async () => {
        const summary = await importLegacyGames(readerFor([legacyRow(9888987, 2023, true)]))

        expect(summary).toMatchObject({ read: 1, imported: 0, skippedEmpty: 1, rejected: 0 })
        expect(await db.game.count()).toBe(0)
    })

    it('rejects a corrupt payload without aborting the rest of the import', async () => {
        const read = readerFor([
            { id: 9888987, year: 2023, response: 'not json' },
            legacyRow(9888988, 2023),
        ])

        const summary = await importLegacyGames(read)

        // One bad blob in 190 must not cost the other 189.
        expect(summary).toMatchObject({ read: 2, imported: 1, rejected: 1 })
        expect(await db.game.count()).toBe(1)
    })

    it('honours an explicit year list', async () => {
        const read = readerFor([legacyRow(9888986, 2022), legacyRow(9888987, 2023)])

        const summary = await importLegacyGames(read, { years: [2022] })

        expect(summary).toMatchObject({ read: 1, imported: 1 })
        expect(await db.game.findUnique({ where: { id: 9888986 } })).not.toBeNull()
    })

    it('is idempotent — a second run imports nothing new', async () => {
        const read = readerFor([legacyRow(9888987, 2023), legacyRow(9888988, 2024)])

        await importLegacyGames(read)
        const second = await importLegacyGames(read)

        expect(second).toMatchObject({ read: 2, imported: 0, skippedExisting: 2 })
        expect(await db.game.count()).toBe(2)
    })
})
