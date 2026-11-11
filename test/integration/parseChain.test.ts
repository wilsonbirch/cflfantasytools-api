import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { jobEnqueue } from '~/dao/job.server'
import { db } from '~/lib/db.server'
import { refitAndApply } from '~/services/epa/fitEp.server'
import { parseStoredGames } from '~/services/pbp/parsePlays.server'
import { JOB_HANDLERS } from '~/worker/handlers.server'
import { runWorkerSession } from '~/worker/loop'

// A re-parse recreates every Play with a null epa. These pin down that the
// worker reprices in the same session, rather than leaving production unpriced
// until epa-fit's own 25-hour schedule comes round.

const PAYLOAD = readFileSync('test/fixtures/pbp/widget-payload.json', 'utf8')
const FIXTURE_ID = 13419665

async function seedParsedAndPriced() {
    await db.team.create({
        data: { slug: 'calgary', abbreviation: 'CGY', name: 'Calgary', geniusTeamId: '112939' },
    })
    await db.team.create({
        data: {
            slug: 'saskatchewan',
            abbreviation: 'SSK',
            name: 'Saskatchewan',
            geniusTeamId: '106752',
        },
    })
    // One game cannot clear the 50-play cell threshold, so nothing would be
    // priced at all; a dozen copies can (see epaFit.test.ts).
    for (let i = 0; i < 12; i++) {
        await db.game.create({ data: { id: FIXTURE_ID + i, response: PAYLOAD, year: 2024 } })
    }
    await parseStoredGames()
    await refitAndApply()
    return db.play.count({ where: { epa: { not: null } } })
}

// Only the queue as boot left it: no schedule re-checks, exit once drained.
const drain = () =>
    runWorkerSession({
        handlers: JOB_HANDLERS,
        schedules: [],
        scheduleCheckMs: 0,
        idleExitMs: 50,
        pollMs: 10,
    })

const ranInOrder = async () =>
    (
        await db.job.findMany({
            where: { status: 'SUCCEEDED' },
            orderBy: { startedAt: 'asc' },
            select: { kind: true },
        })
    ).map((j) => j.kind)

describe('pbp-parse chains the refits behind a re-parse', () => {
    it('reprices every play in the same drain after a PARSER_VERSION bump', async () => {
        const priced = await seedParsedAndPriced()
        expect(priced).toBeGreaterThan(0)

        // What a version bump looks like to a stored game: a hash from an older
        // parser. And the boot that finds it: pbp-parse due, epa-fit NOT due,
        // projections-fit due — the case that left epa null in production.
        await db.$executeRaw`UPDATE "Game" SET "parsedHash" = md5('3' || "response")`
        await jobEnqueue('pbp-parse')
        await jobEnqueue('projections-fit')

        await drain()

        // The boot-time projections-fit was moved behind epa-fit, not run ahead
        // of it on unpriced plays, and not duplicated.
        expect(await ranInOrder()).toEqual(['pbp-parse', 'epa-fit', 'projections-fit'])
        expect(await db.job.count({ where: { status: { not: 'SUCCEEDED' } } })).toBe(0)
        expect(await db.play.count({ where: { epa: { not: null } } })).toBe(priced)
    }, 30_000)

    it('reuses an epa-fit that boot already queued instead of adding a second', async () => {
        await seedParsedAndPriced()
        await db.$executeRaw`UPDATE "Game" SET "parsedHash" = md5('3' || "response")`
        await jobEnqueue('pbp-parse')
        await jobEnqueue('epa-fit')

        await drain()

        expect(await ranInOrder()).toEqual(['pbp-parse', 'epa-fit', 'projections-fit'])
    }, 30_000)

    it('queues nothing when the parse found nothing to do', async () => {
        await seedParsedAndPriced()
        await jobEnqueue('pbp-parse')

        await drain()

        expect(await ranInOrder()).toEqual(['pbp-parse'])
    }, 30_000)
})
