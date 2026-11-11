import { jobEnqueueChain } from '~/dao/job.server'
import { syncGameZone } from '~/services/gamezone/syncGameZone.server'
import { capturePbp } from '~/services/pbp/capturePbp.server'
import { parseStoredGames } from '~/services/pbp/parsePlays.server'
import { epaIsStale, refitAndApply } from '~/services/epa/fitEp.server'
import { runProjectionsFit } from '~/services/projections/fitProjections.server'
import { checkTeam, sweepAllTeams } from '~/services/depthCharts/checkTeam.server'
import { PermanentError } from '~/lib/jobErrors.server'
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
    //
    // A parse deletes and recreates Play rows with a null `epa`, and only
    // epa-fit writes it back. So whenever stored plays may be unpriced, the
    // parse puts epa-fit straight behind itself in this session instead of
    // leaving it to its 25-hour schedule — which let a PARSER_VERSION bump leave
    // production unpriced for up to a day. Decided from stored state
    // (epaIsStale), not from this attempt's parse count: a worker that died after
    // the last game committed leaves a retry that parses nothing, and that retry
    // must still queue the fit.
    //
    // A projections-fit already pending (queued at boot, ahead of everything) is
    // moved behind that epa-fit too, so a normal collection never runs it on
    // unpriced plays. It is only moved, never created: the epa-fit queues one
    // when it succeeds.
    'pbp-parse': async (payload) => {
        const { year, force } = asRecord(payload)
        await parseStoredGames(typeof year === 'number' ? year : undefined, force === true)
        if (await epaIsStale()) {
            await jobEnqueueChain(['epa-fit', 'projections-fit'], { moveOnly: ['projections-fit'] })
        }
    },
    // Refits the expected-points surface and reprices every play from it.
    // Separate from pbp-parse for the same reason parse is separate from
    // capture: a model change must not be able to break normalization, and both
    // halves rebuild from stored rows so this is re-runnable at any time.
    //
    // Every successful fit queues projections-fit behind it, chained or
    // scheduled alike: any fit rewrites the EPA projections read, so the
    // projection is stale after every one, and one extra projection pass a day
    // is cheap. An unconditional rule also has no "was this chained?" flag for a
    // crash or a retry to lose. Queued only on success: a fit that throws goes
    // back to PENDING for a retry, and projections must wait for it.
    'epa-fit': async () => {
        await refitAndApply()
        await jobEnqueueChain(['projections-fit'])
    },
    // Refits the projection model from stored plays and writes this and next
    // gameweek's projections under one fittedAt. Rebuilds from rows every run,
    // so a model change is a refit and older fits stay on disk for audit.
    //
    // REFUSES to run while stored plays may be unpriced (a parse newer than the
    // last successful epa-fit): fitting then would publish projections built on
    // all-zero EPA. The parse moves a pending projections-fit behind its
    // epa-fit, so a normal collection never gets here; this is the backstop for
    // an epa-fit that failed and is retrying.
    //
    // It throws rather than returning, so the job is never recorded as a fresh
    // success it did not earn. The error is an ordinary, TRANSIENT one (not a
    // PermanentError — retrying is exactly what can fix it): the job goes back
    // to PENDING, a successful epa-fit pulls it forward to run, and if epa-fit
    // never succeeds it exhausts its attempts and ends FAILED, where jobHealth
    // and collect.sh can see it.
    'projections-fit': async (payload) => {
        if (await epaIsStale()) {
            throw new Error(
                'EPA is stale: plays were parsed after the last successful epa-fit; ' +
                    'waiting for that fit before projecting',
            )
        }
        const { year } = asRecord(payload)
        await runProjectionsFit(typeof year === 'number' ? year : currentSeasonYear())
    },
    // Fans out one job per club rather than scraping nine sites in one job, so
    // a single club's site being down cannot block or fail the other eight.
    'depth-chart-sweep': async (payload) => {
        const { year } = asRecord(payload)
        await sweepAllTeams(typeof year === 'number' ? year : currentSeasonYear())
    },
    'depth-chart-team': async (payload) => {
        const { teamId, year } = asRecord(payload)
        if (typeof teamId !== 'number') {
            throw new PermanentError('depth-chart-team requires a teamId')
        }
        const result = await checkTeam(
            teamId,
            typeof year === 'number' ? year : currentSeasonYear(),
        )
        // A scrape that could not load the page is an outage, so fail the job and
        // let the retry ladder / Job table show it — straight to FAILED when the
        // page answered 4xx or the source is misconfigured, since retrying cannot
        // help. REJECTED stays non-fatal: that is the data-quality guard refusing
        // a parse, not a site being down.
        if (result.status === 'FAILED') {
            const message = `team ${teamId}: ${result.error}`
            throw result.permanent ? new PermanentError(message) : new Error(message)
        }
    },
    // Emails the club's subscribers about a new or replaced depth chart. Its
    // own job so a Resend outage retries without re-scraping; the batchKey
    // (teamId + scrapeRunId) makes retries resume, never double-send.
    'chart-alert': async (payload) => {
        const { teamId, scrapeRunId, added, revised } = asRecord(payload)
        if (typeof teamId !== 'number' || typeof scrapeRunId !== 'number') {
            throw new PermanentError('chart-alert requires teamId and scrapeRunId')
        }
        const { sendChartAlert } = await import('~/services/email/chartAlert.server')
        const result = await sendChartAlert(
            teamId,
            scrapeRunId,
            typeof added === 'number' ? added : 0,
            typeof revised === 'number' ? revised : 0,
        )
        if (result.failed > 0) {
            const message = `${result.failed} of ${result.queued} sends failed`
            // Every failed chunk was refused with a 4xx (bad key, unverified
            // domain, invalid recipient): the same request would be refused again.
            throw result.permanentFailed === result.failed
                ? new PermanentError(message)
                : new Error(message)
        }
    },
}
