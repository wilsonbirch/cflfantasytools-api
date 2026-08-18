import { db } from '~/lib/db.server'
import { SCHEDULES, type ScheduleRule } from '~/worker/schedule.server'

// A scheduled job is considered stale once it has gone this many times its own
// interval without a success. Two intervals absorbs one missed run plus a retry;
// beyond that something is actually wrong.
const STALENESS_FACTOR = 2

// Daily rules have no `everyMs`, so treat them as a 24h interval for this purpose.
const DAY_MS = 24 * 60 * 60 * 1000

export type JobHealth = {
    kind: string
    lastSuccessAt: Date | null
    ageMs: number | null
    expectedEveryMs: number
    isStale: boolean
}

const expectedInterval = (rule: ScheduleRule): number => rule.everyMs ?? DAY_MS

/**
 * Per-kind freshness for every scheduled job.
 *
 * The point is that a capture pipeline failing SILENTLY is worse than one
 * failing loudly: nobody goes looking until they need the data, by which time
 * the upstream window has closed and it is unrecoverable. This makes "nothing
 * has run since Tuesday" a queryable fact rather than something you notice
 * months later.
 */
export async function jobStaleness(
    schedules: ScheduleRule[] = SCHEDULES,
    now: Date = new Date(),
): Promise<JobHealth[]> {
    const health: JobHealth[] = []
    for (const rule of schedules) {
        const last = await db.job.findFirst({
            where: { kind: rule.kind, status: 'SUCCEEDED' },
            orderBy: { finishedAt: 'desc' },
            select: { finishedAt: true },
        })
        const lastSuccessAt = last?.finishedAt ?? null
        const ageMs = lastSuccessAt ? now.getTime() - lastSuccessAt.getTime() : null
        const expectedEveryMs = expectedInterval(rule)
        health.push({
            kind: rule.kind,
            lastSuccessAt,
            ageMs,
            expectedEveryMs,
            // Never having succeeded counts as stale — a job that has never run
            // is the exact condition worth shouting about on a fresh deploy.
            isStale: ageMs === null || ageMs > expectedEveryMs * STALENESS_FACTOR,
        })
    }
    return health
}

export const anyStale = (health: JobHealth[]): boolean => health.some((h) => h.isStale)
