import { db, Prisma, type Job } from '~/lib/db.server'

const MAX_ATTEMPTS = 5

// runAt defers execution: jobClaimNext only claims rows due now, so a future
// timestamp is a scheduled send (send-admin-notification's sendAt path).
export const jobEnqueue = async (
    kind: string,
    payload: Prisma.InputJsonValue = {},
    runAt?: Date,
): Promise<Job> => db.job.create({ data: { kind, payload, ...(runAt ? { runAt } : {}) } })

/**
 * Queue `kinds` to run next, in the order given, behind whatever is running now.
 *
 * Deduped: a kind that already has a PENDING job reuses it rather than gaining a
 * second. But the existing job is MOVED, not merely kept: the queue runs in
 * (runAt, id) order, so a job enqueued at boot would otherwise run ahead of one
 * enqueued here — a stale `projections-fit` from boot would run before a fresh
 * `epa-fit`, which is the ordering this exists to prevent. Each kind gets a runAt
 * a millisecond after the previous one, so the order holds whatever the ids.
 *
 * A kind listed in `moveOnly` is moved if it is pending but never created: the
 * chain only reorders work something else already asked for.
 */
export const jobEnqueueChain = async (
    kinds: readonly string[],
    { moveOnly = [] }: { moveOnly?: readonly string[] } = {},
): Promise<void> => {
    const base = Date.now()
    for (const [i, kind] of kinds.entries()) {
        const runAt = new Date(base + i + 1)
        const { count } = await db.job.updateMany({
            where: { kind, status: 'PENDING' },
            data: { runAt },
        })
        if (count === 0 && !moveOnly.includes(kind)) await db.job.create({ data: { kind, runAt } })
    }
}

// Optimistic claim, safe through the transaction pooler (no advisory locks, no
// $transaction): find the next due PENDING job, then flip it RUNNING guarded on
// status — count === 1 means this session owns it. Correct for a single worker;
// if this ever runs N workers concurrently, replace the findFirst with a raw
// `FOR UPDATE SKIP LOCKED` select (still a single statement).
export const jobClaimNext = async (): Promise<Job | null> => {
    const job = await db.job.findFirst({
        where: { status: 'PENDING', runAt: { lte: new Date() } },
        orderBy: [{ runAt: 'asc' }, { id: 'asc' }],
    })
    if (!job) return null
    const { count } = await db.job.updateMany({
        where: { id: job.id, status: 'PENDING' },
        data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
    })
    if (count !== 1) return null
    return { ...job, status: 'RUNNING', attempts: job.attempts + 1 }
}

export const jobMarkSucceeded = async (id: number): Promise<void> => {
    await db.job.update({
        where: { id },
        data: { status: 'SUCCEEDED', finishedAt: new Date(), error: null },
    })
}

// Under MAX_ATTEMPTS the job returns to PENDING with exponential backoff
// (2^attempts minutes); at the cap it lands FAILED for a human to inspect.
export const jobMarkFailed = async (
    id: number,
    attempts: number,
    message: string,
): Promise<void> => {
    await db.job.update({
        where: { id },
        data:
            attempts < MAX_ATTEMPTS
                ? {
                      status: 'PENDING',
                      runAt: new Date(Date.now() + 2 ** attempts * 60_000),
                      error: message,
                  }
                : { status: 'FAILED', finishedAt: new Date(), error: message },
    })
}

// Skip the retry ladder — for jobs no amount of retrying can fix (an unknown
// kind, or a handler that raised a PermanentError / 4xx; see lib/jobErrors).
export const jobMarkFailedForGood = async (id: number, message: string): Promise<void> =>
    jobMarkFailed(id, MAX_ATTEMPTS, message)

// Idle-exit check, scoped to the retry-backoff horizon (max 2^(MAX_ATTEMPTS-1)
// minutes): a session stays up to run its own near-term retries instead of
// leaving them an hour, while a far-future scheduled row (a sendAt up to 30
// days out) lets the machine sleep — the hourly heartbeat boot claims it when due.
const PENDING_HORIZON_MS = 2 ** (MAX_ATTEMPTS - 1) * 60_000

export const jobHasPending = async (): Promise<boolean> =>
    (await db.job.count({
        where: { status: 'PENDING', runAt: { lte: new Date(Date.now() + PENDING_HORIZON_MS) } },
    })) > 0

// A RUNNING row at boot means a previous session died mid-job; requeue it
// (handlers are idempotent, so at-least-once re-execution is safe).
export const jobResetOrphaned = async (): Promise<number> => {
    const { count } = await db.job.updateMany({
        where: { status: 'RUNNING' },
        data: { status: 'PENDING', startedAt: null },
    })
    return count
}

/**
 * When the last successful run of `kind` finished, or null if none is on record
 * (never ran, or pruned after 30 days). Callers must treat null as "not done".
 */
export const jobLastSucceededAt = async (kind: string): Promise<Date | null> => {
    const row = await db.job.findFirst({
        where: { kind, status: 'SUCCEEDED', finishedAt: { not: null } },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
    })
    return row?.finishedAt ?? null
}

export const jobLastCreatedAt = async (kind: string): Promise<Date | null> => {
    const row = await db.job.findFirst({
        where: { kind },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
    })
    return row?.createdAt ?? null
}

export const jobPruneFinished = async (olderThan: Date): Promise<number> => {
    const { count } = await db.job.deleteMany({
        where: { status: 'SUCCEEDED', finishedAt: { lt: olderThan } },
    })
    return count
}
