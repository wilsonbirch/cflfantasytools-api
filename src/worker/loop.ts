import {
    jobClaimNext,
    jobEnqueue,
    jobHasPending,
    jobLastCreatedAt,
    jobMarkFailed,
    jobMarkFailedForGood,
    jobMarkSucceeded,
    jobPruneFinished,
} from '~/dao/job.server'
import { logger } from '~/lib/logger.server'
import type { JobHandler } from './handlers.server'
import { dueScheduledKinds, SCHEDULES, type ScheduleRule } from './schedule.server'

const fileName = 'worker/loop'

const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Claim and run due jobs until the queue is empty (or a stop is requested).
 * A handler failure is contained to its job: log + jobMarkFailed
 * (which schedules the retry or lands it FAILED); the loop moves on.
 */
export async function tickOnce(
    handlers: Record<string, JobHandler>,
    isStopping: () => boolean = () => false,
): Promise<number> {
    let processed = 0
    while (!isStopping()) {
        const job = await jobClaimNext()
        if (!job) break
        processed += 1
        const handler = handlers[job.kind]
        if (!handler) {
            logger.error(fileName, `job ${job.id}: no handler for kind "${job.kind}"`)
            await jobMarkFailedForGood(job.id, `no handler for kind "${job.kind}"`)
            continue
        }
        try {
            await handler(job.payload)
            await jobMarkSucceeded(job.id)
            logger.info(fileName, `job ${job.id} (${job.kind}) succeeded`)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            logger.error(
                fileName,
                `job ${job.id} (${job.kind}) failed on attempt ${job.attempts}: ${message}`,
            )
            await jobMarkFailed(job.id, job.attempts, message)
        }
    }
    return processed
}

export type WorkerSessionOptions = {
    handlers: Record<string, JobHandler>
    pollMs?: number
    // 0 = never exit (an always-on worker, and local `dev:worker` watch mode).
    idleExitMs?: number
    isStopping?: () => boolean
    schedules?: ScheduleRule[]
    // How often to re-check the schedule while the session stays up.
    scheduleCheckMs?: number
}

/**
 * Enqueue whatever the schedule says is due right now.
 *
 * Called at boot AND periodically while the session runs. The periodic part
 * matters: a worker that only checked at boot would depend on something else
 * waking it on a timer, and a silently dead wake is exactly how 3DF's capture
 * job ran once in November 2024 and never again, losing the whole 2025 season.
 * Re-checking in-process means an always-on worker keeps its own schedule.
 */
export async function enqueueDueSchedules(
    schedules: ScheduleRule[],
    now = new Date(),
): Promise<number> {
    const lastCreated: Record<string, Date | null> = {}
    for (const rule of schedules) lastCreated[rule.kind] = await jobLastCreatedAt(rule.kind)
    let enqueued = 0
    for (const kind of dueScheduledKinds(now, lastCreated, schedules)) {
        await jobEnqueue(kind)
        logger.info(fileName, `enqueued scheduled ${kind}`)
        enqueued += 1
    }
    return enqueued
}

/**
 * One worker session, boot to idle-exit: enqueue whatever the schedule says is
 * due (plus prune old finished rows), then drain the queue, polling for new
 * work — a wake call may land jobs while we're up. Returns once the queue has
 * stayed empty past idleExitMs (the machine stops on the clean exit) or a stop
 * is requested (SIGTERM), always finishing the in-flight job first.
 */
export async function runWorkerSession({
    handlers,
    pollMs = 3000,
    idleExitMs = 60_000,
    isStopping = () => false,
    schedules = SCHEDULES,
    scheduleCheckMs = 60_000,
}: WorkerSessionOptions): Promise<void> {
    const now = new Date()
    await enqueueDueSchedules(schedules, now)
    const pruned = await jobPruneFinished(new Date(now.getTime() - PRUNE_AFTER_MS))
    if (pruned > 0) logger.info(fileName, `pruned ${pruned} finished jobs`)

    let lastWorkAt = Date.now()
    let lastScheduleCheck = Date.now()
    while (!isStopping()) {
        const processed = await tickOnce(handlers, isStopping)
        if (processed > 0) {
            lastWorkAt = Date.now()
            continue
        }
        // Re-check the schedule so a long-lived session keeps firing recurring
        // rules rather than only the ones due at boot.
        if (Date.now() - lastScheduleCheck >= scheduleCheckMs) {
            lastScheduleCheck = Date.now()
            if ((await enqueueDueSchedules(schedules)) > 0) continue
        }
        if (idleExitMs > 0 && Date.now() - lastWorkAt >= idleExitMs && !(await jobHasPending())) {
            logger.info(fileName, `queue empty for ${idleExitMs}ms; idle-exiting`)
            return
        }
        await sleep(pollMs)
    }
    logger.info(fileName, 'stop requested; exiting session')
}
