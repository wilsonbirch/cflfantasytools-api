import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jobEnqueue } from '~/dao/job.server'
import { db } from '~/lib/db.server'
import { parseStoredGames } from '~/services/pbp/parsePlays.server'
import { JOB_HANDLERS, type JobHandler } from '~/worker/handlers.server'
import { tickOnce } from '~/worker/loop'

// A re-parse recreates every Play with a null epa. These pin down that the
// worker reprices before anything reads EPA — in the same session, through a
// failing fit, and after a crash — rather than leaving production unpriced until
// epa-fit's own 25-hour schedule comes round.

const priced = () => db.play.count({ where: { epa: { not: null } } })

// Every projection fit that really runs, recorded as the number of plays priced
// at that moment. A projections-fit job that stands down records nothing.
const projections = vi.hoisted(() => ({ fits: [] as number[] }))
vi.mock('~/services/projections/fitProjections.server', async (importOriginal) => {
    const real =
        await importOriginal<typeof import('~/services/projections/fitProjections.server')>()
    const { db: database } = await import('~/lib/db.server')
    return {
        ...real,
        runProjectionsFit: async (...args: Parameters<typeof real.runProjectionsFit>) => {
            projections.fits.push(await database.play.count({ where: { epa: { not: null } } }))
            return real.runProjectionsFit(...args)
        },
    }
})
beforeEach(() => {
    projections.fits.length = 0
})

const PAYLOAD = readFileSync('test/fixtures/pbp/widget-payload.json', 'utf8')
const FIXTURE_ID = 13419665

// Run every job that is due now, in queue order, and return — the claim loop a
// worker session runs, without its wait for retries coming due (a live session
// would sit out the retry's backoff and run it too).
const drain = (handlers: Record<string, JobHandler> = JOB_HANDLERS) => tickOnce(handlers)

/**
 * Twelve parsed games (one cannot clear the 50-play cell threshold, so nothing
 * would be priced at all — see epaFit.test.ts), priced by a real epa-fit job so
 * a successful fit is on record. Returns the priced count and the last job id
 * the seeding used; the seed's own projection fit is forgotten.
 */
async function seed() {
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
    for (let i = 0; i < 12; i++) {
        await db.game.create({ data: { id: FIXTURE_ID + i, response: PAYLOAD, year: 2024 } })
    }
    await parseStoredGames()
    await jobEnqueue('epa-fit')
    await drain()
    const last = await db.job.findFirstOrThrow({ orderBy: { id: 'desc' } })
    const full = await priced()
    expect(full).toBeGreaterThan(0)
    projections.fits.length = 0
    return { full, seededUpTo: last.id }
}

/** What a PARSER_VERSION bump looks like to every stored game. */
const bumpParserVersion = () =>
    db.$executeRaw`UPDATE "Game" SET "parsedHash" = md5('3' || "response")`

const ranAfter = async (id: number) =>
    (
        await db.job.findMany({
            where: { id: { gt: id }, status: 'SUCCEEDED' },
            orderBy: { finishedAt: 'asc' },
            select: { kind: true },
        })
    ).map((j) => j.kind)

describe('a re-parse reprices before anything reads EPA', () => {
    it('chains epa-fit, then projections-fit, in the same drain after a version bump', async () => {
        const { full, seededUpTo } = await seed()

        // The boot that finds it: pbp-parse due, epa-fit NOT due, and a
        // projections-fit already queued AHEAD of anything the parse can queue.
        await bumpParserVersion()
        await jobEnqueue('pbp-parse')
        await jobEnqueue('projections-fit')
        await drain()

        // The boot-time projections-fit stood down on unpriced plays; the one
        // the successful epa-fit queued is the only one that fitted.
        expect(await ranAfter(seededUpTo)).toEqual([
            'pbp-parse',
            'projections-fit',
            'epa-fit',
            'projections-fit',
        ])
        expect(projections.fits).toEqual([full])
        expect(await priced()).toBe(full)
    }, 60_000)

    it('holds projections back until a failed epa-fit succeeds on retry', async () => {
        let failNext = false
        const handlers: Record<string, JobHandler> = {
            ...JOB_HANDLERS,
            'epa-fit': async (payload) => {
                if (failNext) {
                    failNext = false
                    throw new Error('simulated epa-fit failure')
                }
                await JOB_HANDLERS['epa-fit'](payload)
            },
        }
        const { full, seededUpTo } = await seed()
        failNext = true

        await bumpParserVersion()
        await jobEnqueue('pbp-parse')
        await jobEnqueue('projections-fit')
        await drain(handlers)

        // The fit failed and went back to PENDING a couple of minutes out; the
        // projections-fit that was due ran, found unpriced plays, and stood down.
        const retry = await db.job.findFirstOrThrow({
            where: { kind: 'epa-fit', status: 'PENDING' },
        })
        expect(retry.attempts).toBe(1)
        expect(retry.runAt.getTime()).toBeGreaterThan(Date.now())
        expect(await priced()).toBe(0)
        expect(projections.fits).toEqual([])

        // The retry comes due and succeeds; only then does a projection fit.
        await db.job.update({ where: { id: retry.id }, data: { runAt: new Date() } })
        await drain(handlers)

        expect((await ranAfter(seededUpTo)).slice(-2)).toEqual(['epa-fit', 'projections-fit'])
        expect(projections.fits).toEqual([full])
        expect(await priced()).toBe(full)
    }, 60_000)

    it('still reprices when the worker died after the parse committed', async () => {
        const { full, seededUpTo } = await seed()

        // The crashed attempt: every game re-parsed and committed, plays now
        // unpriced, and the process gone before it queued anything. Its job is
        // left for the retry, which finds no game left to parse.
        await bumpParserVersion()
        expect((await parseStoredGames()).games).toBe(12)
        expect(await priced()).toBe(0)
        await jobEnqueue('pbp-parse')

        await drain()

        expect(await ranAfter(seededUpTo)).toEqual(['pbp-parse', 'epa-fit', 'projections-fit'])
        expect(projections.fits).toEqual([full])
        expect(await priced()).toBe(full)
    }, 60_000)

    it('queues nothing when the parse found nothing and EPA is current', async () => {
        const { seededUpTo } = await seed()
        await jobEnqueue('pbp-parse')

        await drain()

        expect(await ranAfter(seededUpTo)).toEqual(['pbp-parse'])
        expect(projections.fits).toEqual([])
    }, 60_000)
})
