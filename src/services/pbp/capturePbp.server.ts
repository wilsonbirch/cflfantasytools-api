import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import { ruleEraForYear } from '~/lib/season.server'
import { discoverFixtures } from './discoverFixtures.server'

const fileName = 'services/pbp/capturePbp'

// The BetGenius widget 3DF used. Public and unauthenticated, but it serves
// CURRENT-SEASON DATA ONLY: a 2024 fixture now returns PreMatch with no plays.
// Anything not captured while the season is live is gone — which is how the
// entire 2025 season was lost.
const WIDGET_BASE =
    'https://gsm-widgets.betstream.betgenius.com/widget-data/multisportgametracker' +
    '?productName=democfl_light&sport=AmericanFootball&sportId=17&culture%5B0%5D=en-US' +
    '&competitionId=1035&isUsingBetGeniusId=true&live=false&phase=ALL&activeContent=playByPlay'

export const widgetUrl = (fixtureId: number): string => `${WIDGET_BASE}&fixtureId=${fixtureId}`

export type CaptureSummary = {
    discovered: number
    linked: number
    captured: number
    skippedEmpty: number
    failed: number
}

type WidgetPayload = {
    data?: {
        playByPlayInfo?: { ALL?: unknown[] }
        matchInfo?: {
            seasonName?: string
            roundName?: string
            scheduledStartTime?: string
            homeTeam?: { competitorId?: string }
            awayTeam?: { competitorId?: string }
        }
        scoreboardInfo?: { matchStatus?: string }
    }
}

const playCount = (p: WidgetPayload): number => p.data?.playByPlayInfo?.ALL?.length ?? 0

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
    payload: WidgetPayload,
    year: number,
): Promise<boolean> {
    const info = payload.data?.matchInfo
    const homeGeniusId = info?.homeTeam?.competitorId
    const startedAt = info?.scheduledStartTime
    if (!homeGeniusId || !startedAt) return false

    const home = await db.team.findUnique({ where: { geniusTeamId: homeGeniusId } })
    if (!home) return false

    const day = new Date(startedAt)
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
 * Discovery reads fixture ids from cfl.ca game pages and records them on Match,
 * so the mapping survives even if a capture fails. Payloads are stored raw in
 * Game exactly as 3DF did — parsing into Drive/Play is a separate concern and a
 * later phase, and keeping the raw blob means a parser bug is re-runnable
 * rather than a data loss.
 */
export async function capturePbp(
    year: number,
    fetchImpl: typeof fetch = fetch,
    delayMs = 250,
): Promise<CaptureSummary> {
    const summary: CaptureSummary = {
        discovered: 0,
        linked: 0,
        captured: 0,
        skippedEmpty: 0,
        failed: 0,
    }

    const fixtures = await discoverFixtures(fetchImpl, delayMs)
    summary.discovered = fixtures.length

    for (const fixture of fixtures) {
        try {
            const res = await fetchImpl(widgetUrl(fixture.fixtureId), {
                signal: AbortSignal.timeout(30_000),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const body = await res.text()
            const parsed = JSON.parse(body) as WidgetPayload
            const plays = playCount(parsed)

            if (plays === 0) {
                // An unplayed or aged-out fixture. Never overwrite a stored
                // payload with an empty one — that would destroy a good capture.
                summary.skippedEmpty += 1
                continue
            }

            await db.game.upsert({
                where: { id: fixture.fixtureId },
                update: { response: body, year },
                create: { id: fixture.fixtureId, response: body, year },
            })
            summary.captured += 1

            if (await linkFixtureToMatch(fixture.fixtureId, parsed, year)) summary.linked += 1
        } catch (err) {
            summary.failed += 1
            logger.warn(
                fileName,
                `fixture ${fixture.fixtureId}: ${err instanceof Error ? err.message : String(err)}`,
            )
        }
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    }

    logger.info(
        fileName,
        `capture ${year} (${ruleEraForYear(year)}): ${summary.captured} captured, ` +
            `${summary.linked} linked, ${summary.skippedEmpty} empty, ${summary.failed} failed`,
    )
    return summary
}
