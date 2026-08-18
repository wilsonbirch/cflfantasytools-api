import { describe, expect, it } from 'vitest'
import {
    jobClaimNext,
    jobEnqueue,
    jobHasPending,
    jobLastCreatedAt,
    jobMarkFailed,
    jobMarkFailedForGood,
    jobMarkSucceeded,
    jobPruneFinished,
    jobResetOrphaned,
} from '~/dao/job.server'
import { db } from '~/lib/db.server'

// The queue replaces node-resque + Redis, so its retry ladder and orphan
// recovery are load-bearing rather than incidental — 3DF's equivalent logic was
// ~450 lines of stale-worker cleanup that nothing tested.
describe('job lifecycle', () => {
    it('marks a claimed job succeeded and clears any earlier error', async () => {
        const job = await jobEnqueue('sweep')
        const claimed = await jobClaimNext()
        await jobMarkSucceeded(claimed!.id)
        const row = await db.job.findUniqueOrThrow({ where: { id: job.id } })
        expect(row.status).toBe('SUCCEEDED')
        expect(row.error).toBeNull()
        expect(row.finishedAt).not.toBeNull()
    })

    it('returns a failed job to PENDING with exponential backoff', async () => {
        await jobEnqueue('sweep')
        const claimed = await jobClaimNext()
        await jobMarkFailed(claimed!.id, claimed!.attempts, 'club site timed out')

        const row = await db.job.findUniqueOrThrow({ where: { id: claimed!.id } })
        expect(row.status).toBe('PENDING')
        expect(row.error).toBe('club site timed out')
        // attempts = 1 -> 2^1 minutes out.
        expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + 60_000)
    })

    it('gives up at the attempt cap instead of retrying forever', async () => {
        await jobEnqueue('sweep')
        const claimed = await jobClaimNext()
        await jobMarkFailed(claimed!.id, 5, 'still broken')
        const row = await db.job.findUniqueOrThrow({ where: { id: claimed!.id } })
        expect(row.status).toBe('FAILED')
    })

    it('fails an unknown job kind for good, skipping the retry ladder', async () => {
        await jobEnqueue('kind-with-no-handler')
        const claimed = await jobClaimNext()
        await jobMarkFailedForGood(claimed!.id, 'no handler')
        const row = await db.job.findUniqueOrThrow({ where: { id: claimed!.id } })
        // Retrying a job nothing can handle would just burn attempts.
        expect(row.status).toBe('FAILED')
    })
})

describe('crash recovery', () => {
    it('requeues jobs left RUNNING by a dead worker', async () => {
        await jobEnqueue('sweep')
        await jobClaimNext()
        const requeued = await jobResetOrphaned()
        expect(requeued).toBe(1)
        const row = await db.job.findFirstOrThrow({ where: { kind: 'sweep' } })
        expect(row.status).toBe('PENDING')
        expect(row.startedAt).toBeNull()
    })
})

describe('idle-exit accounting', () => {
    it('reports pending work that is due soon', async () => {
        await jobEnqueue('sweep')
        expect(await jobHasPending()).toBe(true)
    })

    it('ignores work scheduled far beyond the retry horizon', async () => {
        await jobEnqueue('sweep', {}, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000))
        // The machine should be allowed to sleep; the next boot claims it when due.
        expect(await jobHasPending()).toBe(false)
    })

    it('reports nothing pending on an empty queue', async () => {
        expect(await jobHasPending()).toBe(false)
    })
})

describe('schedule bookkeeping', () => {
    it('reports the last enqueue time for a kind, which is how schedules fire', async () => {
        expect(await jobLastCreatedAt('sweep')).toBeNull()
        await jobEnqueue('sweep')
        expect(await jobLastCreatedAt('sweep')).toBeInstanceOf(Date)
    })
})

describe('pruning', () => {
    it('deletes old succeeded rows but keeps failures for inspection', async () => {
        const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
        const done = await jobEnqueue('sweep')
        await db.job.update({
            where: { id: done.id },
            data: { status: 'SUCCEEDED', finishedAt: old },
        })
        const failed = await jobEnqueue('sweep')
        await db.job.update({
            where: { id: failed.id },
            data: { status: 'FAILED', finishedAt: old },
        })

        const pruned = await jobPruneFinished(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
        expect(pruned).toBe(1)
        expect(await db.job.findUnique({ where: { id: failed.id } })).not.toBeNull()
    })
})

describe('concurrent claims', () => {
    it('hands a job to exactly one caller when two race for it', async () => {
        await jobEnqueue('sweep')
        // The claim is optimistic (findFirst, then a status-guarded updateMany)
        // rather than a lock, so the losing session must observe the guard
        // failing and back off instead of running the same job twice.
        const [a, b] = await Promise.all([jobClaimNext(), jobClaimNext()])
        const winners = [a, b].filter(Boolean)
        expect(winners).toHaveLength(1)
        expect(await db.job.count({ where: { status: 'RUNNING' } })).toBe(1)
    })
})
