import { syncGameZone } from '~/services/gamezone/syncGameZone.server'
import { capturePbp } from '~/services/pbp/capturePbp.server'
import { parseStoredGames } from '~/services/pbp/parsePlays.server'
import { checkTeam, sweepAllTeams } from '~/services/depthCharts/checkTeam.server'
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
    'pbp-capture': async (payload) => {
        const { year } = asRecord(payload)
        await capturePbp(typeof year === 'number' ? year : currentSeasonYear())
    },
    // Normalizes stored payloads into Drive/Play rows. Deliberately separate
    // from pbp-capture: capture talks to the network and must not be blocked by
    // a parser bug, and the raw blob is retained so this is re-runnable.
    // `year` omitted parses every stored season, not just the current one —
    // which is what the legacy 2023/24 backfill will need.
    'pbp-parse': async (payload) => {
        const { year, force } = asRecord(payload)
        await parseStoredGames(typeof year === 'number' ? year : undefined, force === true)
    },
    // Fans out one job per club rather than scraping nine sites in one job, so
    // a single club's site being down cannot block or fail the other eight.
    'depth-chart-sweep': async (payload) => {
        const { year } = asRecord(payload)
        await sweepAllTeams(typeof year === 'number' ? year : currentSeasonYear())
    },
    'depth-chart-team': async (payload) => {
        const { teamId, year } = asRecord(payload)
        if (typeof teamId !== 'number') throw new Error('depth-chart-team requires a teamId')
        await checkTeam(teamId, typeof year === 'number' ? year : currentSeasonYear())
    },
}
