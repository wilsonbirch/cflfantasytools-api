import { db } from '~/lib/db.server'
import type { ChartSlot } from './alignment'

// Which chart applies to a game: the club's newest parsed chart published in
// the ten days up to a day after kickoff. Charts are posted a day or two before
// a game and detected within the half-hour, so "newest before kickoff" is the
// game's chart; the ten-day floor stops a bye week borrowing the chart from two
// games back, and the day of slack absorbs a sweep that found it late.
const BEFORE_MS = 10 * 24 * 60 * 60 * 1000
const AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Receiver slots per Genius team id for one game. Empty when the game has no
 * kickoff time, or a club has no parsed chart in the window.
 */
export async function gameAlignments(
    startedAt: Date | null,
    geniusTeamIds: string[],
): Promise<Map<string, ChartSlot[]>> {
    const out = new Map<string, ChartSlot[]>()
    if (!startedAt) return out
    const charts = await db.depthChart.findMany({
        where: {
            parseStatus: 'OK',
            Team: { geniusTeamId: { in: geniusTeamIds } },
            publishedAt: {
                gte: new Date(startedAt.getTime() - BEFORE_MS),
                lte: new Date(startedAt.getTime() + AFTER_MS),
            },
        },
        select: {
            publishedAt: true,
            Team: { select: { geniusTeamId: true } },
            positions: { select: { position: true, player: true, jersey: true, depth: true } },
        },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    })
    for (const c of charts) {
        const id = c.Team.geniusTeamId
        if (id && !out.has(id)) out.set(id, c.positions)
    }
    return out
}

/** Every parsed chart of a season, per Genius team id, for primaryAlignment. */
export async function seasonAlignments(
    year: number,
    teamSlug?: string | null,
): Promise<Map<string, ChartSlot[][]>> {
    const charts = await db.depthChart.findMany({
        where: { year, parseStatus: 'OK', ...(teamSlug ? { Team: { slug: teamSlug } } : {}) },
        select: {
            Team: { select: { geniusTeamId: true } },
            positions: { select: { position: true, player: true, jersey: true, depth: true } },
        },
    })
    const out = new Map<string, ChartSlot[][]>()
    for (const c of charts) {
        const id = c.Team.geniusTeamId
        if (!id) continue
        out.set(id, [...(out.get(id) ?? []), c.positions])
    }
    return out
}
