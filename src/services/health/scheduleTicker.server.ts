import { wakeWorker } from '~/lib/flyMachines.server'
import { logger } from '~/lib/logger.server'
import { jobHasPending } from '~/dao/job.server'
import { enqueueDueSchedules } from '~/worker/loop'
import { SCHEDULES } from '~/worker/schedule.server'
import { jobStaleness } from './staleness.server'

const fileName = 'services/health/scheduleTicker'

const TICK_MS = 60_000

let timer: NodeJS.Timeout | undefined

/**
 * One pass: enqueue what is due, wake the worker if anything was, then report
 * anything that has gone quiet for too long.
 *
 * Exported so it is directly testable — the interval that calls it is trivial;
 * the decision-making here is not.
 */
export async function runScheduleTick(): Promise<void> {
    try {
        const enqueued = await enqueueDueSchedules(SCHEDULES)
        if (enqueued > 0) logger.info(fileName, `enqueued ${enqueued} scheduled job(s)`)

        // Wake on PENDING WORK, not on "this tick enqueued something".
        //
        // Waking only after an enqueue strands a job permanently the first time
        // a wake fails: the schedule will not re-enqueue a kind that already has
        // a recent row, so nothing ever tries again and the queue sits full with
        // the worker asleep. Observed in production within minutes of deploy —
        // depth-chart-sweep sat PENDING with 0 attempts.
        if (await jobHasPending()) await wakeWorker()

        for (const h of (await jobStaleness()).filter((x) => x.isStale)) {
            logger.error(
                fileName,
                `STALE: ${h.kind} last succeeded ` +
                    (h.lastSuccessAt ? `${Math.round((h.ageMs ?? 0) / 60_000)}m ago` : 'never') +
                    ` (expected every ${Math.round(h.expectedEveryMs / 60_000)}m)`,
            )
        }
    } catch (err) {
        // Never let a tick failure kill the interval — the next one retries.
        logger.error(fileName, `tick failed: ${err instanceof Error ? err.message : String(err)}`)
    }
}

/**
 * The schedule trigger, running in the always-on web process.
 *
 * web is up regardless (it serves GraphQL), so putting the ticker here lets the
 * worker sleep between jobs and bill only while it works.
 *
 * The staleness report is what makes that safe: if web itself wedges, or the
 * wake keeps failing, "nothing has succeeded in far too long" gets said out
 * loud rather than discovered later when the data is wanted and the upstream
 * window has closed.
 */
export function startScheduleTicker(): void {
    if (process.env.SCHEDULE_TICKER_ENABLED !== 'true') {
        logger.info(fileName, 'schedule ticker disabled')
        return
    }
    if (timer) return

    // unref'd so it never holds the process open during a graceful shutdown.
    timer = setInterval(() => void runScheduleTick(), TICK_MS)
    timer.unref()
    void runScheduleTick()
    logger.info(fileName, `schedule ticker started (every ${TICK_MS / 1000}s)`)
}

export function stopScheduleTicker(): void {
    if (timer) clearInterval(timer)
    timer = undefined
}
