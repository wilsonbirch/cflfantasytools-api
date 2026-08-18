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
    // 0 = never exit (local `dev:worker` watch mode).
    idleExitMs?: number
    isStopping?: () => boolean
    schedules?: ScheduleRule[]
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
}: WorkerSessionOptions): Promise<void> {
    const now = new Date()
    const lastCreated: Record<string, Date | null> = {}
    for (const rule of schedules) lastCreated[rule.kind] = await jobLastCreatedAt(rule.kind)
    for (const kind of dueScheduledKinds(now, lastCreated, schedules)) {
        await jobEnqueue(kind)
        logger.info(fileName, `enqueued scheduled ${kind}`)
    }
    const pruned = await jobPruneFinished(new Date(now.getTime() - PRUNE_AFTER_MS))
    if (pruned > 0) logger.info(fileName, `pruned ${pruned} finished jobs`)

    let lastWorkAt = Date.now()
    while (!isStopping()) {
        const processed = await tickOnce(handlers, isStopping)
        if (processed > 0) {
            lastWorkAt = Date.now()
            continue
        }
        if (idleExitMs > 0 && Date.now() - lastWorkAt >= idleExitMs && !(await jobHasPending())) {
            logger.info(fileName, `queue empty for ${idleExitMs}ms; idle-exiting`)
            return
        }
        await sleep(pollMs)
    }
    logger.info(fileName, 'stop requested; exiting session')
}
