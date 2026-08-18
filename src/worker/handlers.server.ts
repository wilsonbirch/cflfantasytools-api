import { syncGameZone } from '~/services/gamezone/syncGameZone.server'
import { currentSeasonYear } from '~/lib/season.server'

export type JobHandler = (payload: unknown) => Promise<void>

const asRecord = (payload: unknown): Record<string, unknown> =>
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}

// Job kind -> handler. A kind with no handler here is failed for good rather
// than retried (see loop.ts) — retrying an unknown kind can never succeed.
export const JOB_HANDLERS: Record<string, JobHandler> = {
    'gamezone-sync': async (payload) => {
        const { year } = asRecord(payload)
        await syncGameZone(typeof year === 'number' ? year : currentSeasonYear())
    },
}
