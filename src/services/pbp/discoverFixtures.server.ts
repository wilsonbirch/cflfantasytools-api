import { logger } from '~/lib/logger.server'

const fileName = 'services/pbp/discoverFixtures'

// CFL publishes the BetGenius fixture id in the tracker embed on each game page.
// This is why discovery does not need guesswork: 3DF's ids were found by probing
// the id space until one hit, then counting backwards to game one.
export const SCHEDULE_URL = 'https://www.cfl.ca/schedule/'

export type DiscoveredFixture = {
    // CFL's own game id, from the URL.
    cflGameId: number
    slug: string
    fixtureId: number
}

const GAME_LINK = /cfl\.ca\/games\/(\d+)\/([a-z0-9-]+)\//g
const FIXTURE_ID = /fixtureId=(\d+)/

/** Game page URLs linked from the schedule, deduplicated, in id order. */
export function parseGameLinks(scheduleHtml: string): { cflGameId: number; slug: string }[] {
    const seen = new Map<number, string>()
    for (const m of scheduleHtml.matchAll(GAME_LINK)) {
        seen.set(Number(m[1]), m[2])
    }
    return [...seen.entries()]
        .map(([cflGameId, slug]) => ({ cflGameId, slug }))
        .sort((a, b) => a.cflGameId - b.cflGameId)
}

export const parseFixtureId = (gamePageHtml: string): number | null => {
    const m = gamePageHtml.match(FIXTURE_ID)
    return m ? Number(m[1]) : null
}

export const gamePageUrl = (cflGameId: number, slug: string): string =>
    `https://www.cfl.ca/games/${cflGameId}/${slug}/`

/**
 * Walk the schedule and resolve every game page to its BetGenius fixture id.
 *
 * Deliberately sequential with a small delay: this reads ~80 pages off cfl.ca
 * and there is no reason to hammer them for a job that runs a few times a day.
 * A page that fails to yield an id is skipped and logged, not fatal — one club
 * page changing shape must not stop the rest of the season being captured.
 */
export async function discoverFixtures(
    fetchImpl: typeof fetch = fetch,
    delayMs = 250,
): Promise<DiscoveredFixture[]> {
    const res = await fetchImpl(SCHEDULE_URL, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`schedule fetch failed: HTTP ${res.status}`)
    const links = parseGameLinks(await res.text())
    logger.info(fileName, `schedule lists ${links.length} game pages`)

    const found: DiscoveredFixture[] = []
    for (const link of links) {
        try {
            const page = await fetchImpl(gamePageUrl(link.cflGameId, link.slug), {
                signal: AbortSignal.timeout(30_000),
            })
            if (!page.ok) throw new Error(`HTTP ${page.status}`)
            const fixtureId = parseFixtureId(await page.text())
            if (fixtureId === null) {
                logger.warn(fileName, `game ${link.cflGameId}: no fixtureId in page`)
                continue
            }
            found.push({ ...link, fixtureId })
        } catch (err) {
            logger.warn(
                fileName,
                `game ${link.cflGameId}: ${err instanceof Error ? err.message : String(err)}`,
            )
        }
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    }

    logger.info(fileName, `resolved ${found.length}/${links.length} fixture ids`)
    return found
}
