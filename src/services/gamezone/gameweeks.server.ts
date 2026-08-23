import { db } from '~/lib/db.server'

// Gameweek ordinals and "which gameweek is it", from the rows the Game Zone
// feed gives us. The feed numbers gameweeks by its own id and names them
// "Week N"; neither is a contract, so `week` is derived: the gameweek's 1-based
// position within its season by start date.

export type GameweekRef = { id: number; week: number; year: number }

/** A season's gameweeks in schedule order, each with its ordinal. */
export async function seasonGameweeks(
    year: number,
): Promise<(GameweekRef & { status: string; startDate: Date | null; endDate: Date | null })[]> {
    const rows = await db.gameweek.findMany({
        where: { year },
        select: { id: true, year: true, status: true, startDate: true, endDate: true },
        orderBy: [{ startDate: { sort: 'asc', nulls: 'last' } }, { gameZoneId: 'asc' }],
    })
    return rows.map((g, i) => ({ ...g, week: i + 1 }))
}

/** The ordinal of one gameweek within its season. */
export async function weekOf(gameweek: { id: number; year: number }): Promise<number> {
    const season = await seasonGameweeks(gameweek.year)
    return season.find((g) => g.id === gameweek.id)?.week ?? 0
}

/**
 * The gameweek lineups are being set for: the first not yet complete, else the
 * season's last. Null when the season has no gameweeks at all.
 */
export async function currentGameweek(year: number): Promise<GameweekRef | null> {
    const season = await seasonGameweeks(year)
    return season.find((g) => g.status !== 'complete') ?? season.at(-1) ?? null
}
