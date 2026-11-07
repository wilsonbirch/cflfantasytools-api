import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import { ruleEraForYear } from '~/lib/season.server'
import type { RawPlay } from './drives'
import { discoverFixtures } from './discoverFixtures.server'

const fileName = 'services/pbp/capturePbp'

// Genius Sports' public widget feeds for the CFL. Unauthenticated, but they
// serve CURRENT-SEASON DATA ONLY. Anything not captured while the season is
// live is gone — which is how the entire 2025 season was lost.
//
// The single `/widget-data/multisportgametracker` endpoint 3DF used began
// answering every fixture with HTTP 500 (`BN001 Unidentified error`) during
// 2026, when Genius moved the tracker to per-widget `/v1/widget/...` routes.
// Two of those together carry everything the old payload did: `playByPlay` for
// the plays, the scoreboard for teams, kickoff and the final.
const FEED_BASE = 'https://gsm-widgets.betstream.betgenius.com/v1/widget'
const FEED_SCOPE = 'customer/democfl_light/locale/en-US/geolocale/CA-ON'

export const PBP_WIDGET = 'playByPlay'
export const SCOREBOARD_WIDGET = 'multisportscoreboardwidget'

export const feedUrl = (widget: string, fixtureId: number): string =>
    `${FEED_BASE}/${widget}/${FEED_SCOPE}?fixtureId=${fixtureId}`

export type CaptureSummary = {
    discovered: number
    linked: number
    captured: number
    skippedEmpty: number
    skippedFuture: number
    failed: number
}

/** The stored shape. Every reader of Game.response depends on `data`. */
export type StoredPayload = {
    // Which feed produced it. Absent on payloads captured from the old endpoint.
    source?: 'gsm-v1'
    data: {
        playByPlayInfo: { ALL: RawPlay[] }
        matchInfo: {
            seasonName?: string
            roundName?: string
            scheduledStartTime?: string
            homeTeam?: { competitorId?: string }
            awayTeam?: { competitorId?: string }
        }
        scoreboardInfo: {
            matchStatus?: string
            homeScore: number | null
            awayScore: number | null
        }
    }
    // The feed responses as received, so nothing the normalization drops is lost.
    raw?: { playByPlay: unknown; scoreboard: unknown }
}

type FeedEnvelope<T> = { data?: { status?: { status?: string }; details?: T } }

type PbpDetails = { playByPlayInfo?: Record<string, Partial<RawPlay>[]> }

type ScoreboardTeam = { competitorId?: string; score?: string | number }
type ScoreboardDetails = {
    matchSummaries?: { matchStatus?: string }
    homeTeam?: ScoreboardTeam
    awayTeam?: ScoreboardTeam
    scheduledStartTime?: string
    seasonName?: string
    roundName?: string
}

const toScore = (v: unknown): number | null => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null
}

/**
 * Fold the two feed responses into the payload shape the parser was built on.
 *
 * Normalizing here, rather than teaching the parser a second shape, keeps
 * every reader of Game.response (parser, legacy import, tests) on one format,
 * and keeps the legacy 2023/24 rows and new captures interchangeable.
 *
 * Verified against a game captured from BOTH feeds (13419716, MTL v OTT, week
 * 12): same 140 plays, same teams, kickoff and final. The new feed omits keys
 * the old one sent as null (`subType`) or "" (`clock`); those are restored so
 * the stored plays match field for field.
 *
 * Plays arrive grouped by period — Q1–Q4, OT — plus `HL`, a highlights reel
 * that only repeats plays from the periods and is dropped. Order is not
 * preserved because nothing relies on it: `chronological()` sorts on play id.
 */
export function toStoredPayload(pbpBody: unknown, scoreboardBody: unknown): StoredPayload {
    const pbp = (pbpBody as FeedEnvelope<PbpDetails>)?.data?.details
    const sb = (scoreboardBody as FeedEnvelope<ScoreboardDetails>)?.data?.details

    const periods = pbp?.playByPlayInfo ?? {}
    const seen = new Set<string>()
    const plays: RawPlay[] = []
    for (const [period, list] of Object.entries(periods)) {
        if (period === 'HL' || !Array.isArray(list)) continue
        for (const p of list) {
            if (typeof p?.id !== 'string' || seen.has(p.id)) continue
            seen.add(p.id)
            plays.push({ ...p, subType: p.subType ?? null, clock: p.clock ?? '' } as RawPlay)
        }
    }

    return {
        source: 'gsm-v1',
        data: {
            playByPlayInfo: { ALL: plays },
            matchInfo: {
                seasonName: sb?.seasonName,
                roundName: sb?.roundName,
                scheduledStartTime: sb?.scheduledStartTime,
                homeTeam: { competitorId: sb?.homeTeam?.competitorId },
                awayTeam: { competitorId: sb?.awayTeam?.competitorId },
            },
            scoreboardInfo: {
                matchStatus: sb?.matchSummaries?.matchStatus,
                homeScore: toScore(sb?.homeTeam?.score),
                awayScore: toScore(sb?.awayTeam?.score),
            },
        },
        raw: { playByPlay: pbpBody, scoreboard: scoreboardBody },
    }
}

async function fetchFeed(fetchImpl: typeof fetch, widget: string, fixtureId: number) {
    const res = await fetchImpl(feedUrl(widget, fixtureId), { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`${widget}: HTTP ${res.status}`)
    const body = (await res.json()) as FeedEnvelope<unknown>
    const status = body?.data?.status?.status
    // Unplayed fixtures still answer AVAILABLE, just with no plays; anything
    // else is the feed telling us it could not serve this fixture.
    if (status !== 'AVAILABLE') throw new Error(`${widget}: status ${status ?? 'missing'}`)
    return body
}

/**
 * Link a captured fixture to its Match row by IDENTITY, not by position.
 *
 * An earlier version aligned the two lists by index and produced nonsense: the
 * CFL schedule page includes preseason games and the Game Zone feed does not,
 * so every fixture was off by the number of preseason games and a Week 1 match
 * ended up pointing at a preseason payload.
 *
 * The payload carries `competitorId`, which is the same Genius id stored on
 * Team.geniusTeamId, so home team plus calendar day is an exact match. Preseason
 * fixtures simply match nothing — correct, since the feed has no row for them —
 * and are still captured as Games.
 */
async function linkFixtureToMatch(
    fixtureId: number,
    payload: StoredPayload,
    year: number,
): Promise<boolean> {
    const info = payload.data.matchInfo
    const homeGeniusId = info.homeTeam?.competitorId
    const startedAt = info.scheduledStartTime
    if (!homeGeniusId || !startedAt) return false

    const home = await db.team.findUnique({ where: { geniusTeamId: homeGeniusId } })
    if (!home) return false

    const day = new Date(startedAt)
    if (Number.isNaN(day.getTime())) return false
    const from = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()))
    const to = new Date(from.getTime() + 48 * 60 * 60 * 1000)

    // A 48h window, not an exact timestamp: the two sources record kickoff in
    // different timezones and a late game can land on either calendar day.
    const match = await db.match.findFirst({
        where: { year, homeTeamId: home.id, date: { gte: from, lt: to } },
    })
    if (!match || match.geniusFixtureId === fixtureId) return false

    await db.match.update({ where: { id: match.id }, data: { geniusFixtureId: fixtureId } })
    return true
}

/**
 * Capture play-by-play for the season.
 *
 * Every run re-fetches every fixture that has kicked off, so a single run
 * backfills anything an outage missed — as long as the feed still serves the
 * season. Payloads are stored whole in Game; parsing into Drive/Play is a
 * separate job, so a parser bug is re-runnable rather than a data loss.
 *
 * Throws when fixtures were attempted and NONE could be fetched. Individual
 * failures are tolerated — one bad fixture must not cost the season — but a
 * run where the feed failed for everything is an outage, and must surface in
 * jobHealth rather than record a success.
 */
export async function capturePbp(
    year: number,
    fetchImpl: typeof fetch = fetch,
    delayMs = 250,
    now: Date = new Date(),
): Promise<CaptureSummary> {
    const summary: CaptureSummary = {
        discovered: 0,
        linked: 0,
        captured: 0,
        skippedEmpty: 0,
        skippedFuture: 0,
        failed: 0,
    }

    const fixtures = await discoverFixtures(fetchImpl)
    summary.discovered = fixtures.length

    for (const fixture of fixtures) {
        // Not kicked off yet: nothing to fetch, and no point asking twice.
        if (fixture.startAt && fixture.startAt.getTime() > now.getTime()) {
            summary.skippedFuture += 1
            continue
        }
        try {
            const pbp = await fetchFeed(fetchImpl, PBP_WIDGET, fixture.fixtureId)
            const scoreboard = await fetchFeed(fetchImpl, SCOREBOARD_WIDGET, fixture.fixtureId)
            const payload = toStoredPayload(pbp, scoreboard)

            if (payload.data.playByPlayInfo.ALL.length === 0) {
                // Unplayed, postponed or aged out. Never overwrite a stored
                // payload with an empty one — that would destroy a good capture.
                summary.skippedEmpty += 1
            } else {
                const response = JSON.stringify(payload)
                await db.game.upsert({
                    where: { id: fixture.fixtureId },
                    update: { response, year },
                    create: { id: fixture.fixtureId, response, year },
                })
                summary.captured += 1
                if (await linkFixtureToMatch(fixture.fixtureId, payload, year)) summary.linked += 1
            }
        } catch (err) {
            summary.failed += 1
            logger.warn(
                fileName,
                `fixture ${fixture.fixtureId}: ${err instanceof Error ? err.message : String(err)}`,
            )
        }
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    }

    const line =
        `capture ${year} (${ruleEraForYear(year)}): ${summary.captured} captured, ` +
        `${summary.linked} linked, ${summary.skippedEmpty} empty, ` +
        `${summary.skippedFuture} not yet played, ${summary.failed} failed`
    logger.info(fileName, line)

    if (summary.failed > 0 && summary.captured === 0 && summary.skippedEmpty === 0) {
        throw new Error(`every fixture failed — the feed is down or has moved. ${line}`)
    }
    return summary
}
