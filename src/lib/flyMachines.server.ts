import { logger } from '~/lib/logger.server'

const fileName = 'lib/flyMachines'

// Waking the worker is best-effort by design: if it fails, the worker's own
// next boot still picks the job up from the queue. A wake that throws must
// never fail the request that triggered it.
const API = 'https://api.machines.dev/v1'

type Machine = { id: string; state: string; config?: { metadata?: Record<string, string> } }

/**
 * Start any stopped worker machine.
 *
 * The web process holds the schedule ticker (it is always-on anyway to serve
 * GraphQL), so the worker can stay asleep between jobs and bill only while it
 * works. Fly's own machine schedules were the alternative; one silently stopped
 * firing for five days on another project here, so the trigger lives in a
 * process we control.
 */
export async function wakeWorker(fetchImpl: typeof fetch = fetch): Promise<boolean> {
    const token = process.env.FLY_MACHINES_TOKEN
    const app = process.env.FLY_APP_NAME
    if (!token || !app) {
        logger.debug(fileName, 'FLY_MACHINES_TOKEN or FLY_APP_NAME unset; skipping wake')
        return false
    }

    try {
        const res = await fetchImpl(`${API}/apps/${app}/machines`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) throw new Error(`list machines: HTTP ${res.status}`)
        const machines = (await res.json()) as Machine[]

        const workers = machines.filter(
            (m) => m.config?.metadata?.fly_process_group === 'worker' && m.state !== 'started',
        )
        if (workers.length === 0) return false

        for (const m of workers) {
            const start = await fetchImpl(`${API}/apps/${app}/machines/${m.id}/start`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10_000),
            })
            if (!start.ok) throw new Error(`start ${m.id}: HTTP ${start.status}`)
            logger.info(fileName, `woke worker machine ${m.id}`)
        }
        return true
    } catch (err) {
        logger.warn(fileName, `wake failed: ${err instanceof Error ? err.message : String(err)}`)
        return false
    }
}
