import { jobResetOrphaned } from '~/dao/job.server'
import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import { JOB_HANDLERS } from './handlers.server'
import { runWorkerSession } from './loop'

const fileName = 'worker/index'

/**
 * Worker entrypoint — no HTTP listener. Boots, requeues orphans, runs a session
 * until the queue stays idle, then exits 0 so the Fly machine stops (the restart
 * policy is 'on-failure', so a clean exit is not restarted). SIGTERM/SIGINT
 * finish the in-flight job first.
 */
let stopping = false
const requestStop = (signal: string): void => {
    logger.info(fileName, `${signal} received; finishing in-flight job then exiting`)
    stopping = true
}
process.on('SIGTERM', () => requestStop('SIGTERM'))
process.on('SIGINT', () => requestStop('SIGINT'))

// 0 = never exit (dev:worker watch mode).
const idleExitMs = process.env.WORKER_IDLE_EXIT_MS
    ? Number(process.env.WORKER_IDLE_EXIT_MS)
    : 60_000

logger.info(fileName, '🛠 worker ready')

const requeued = await jobResetOrphaned()
if (requeued > 0) logger.info(fileName, `requeued ${requeued} orphaned jobs`)

await runWorkerSession({ handlers: JOB_HANDLERS, idleExitMs, isStopping: () => stopping })

await db.$disconnect()
process.exit(0)
