import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import { fetchFeed } from './fetchFeed.server'
import { mapPosition, type FeedGameweek, type FeedPlayer, type Squad } from './feeds'

const fileName = 'services/gamezone/syncGameZone'

// A player absent from this many consecutive changed pulls is marked inactive.
// Never deleted — an upstream glitch must not destroy history, and a released
// player's season stats stay meaningful.
const MISSED_SYNCS_BEFORE_INACTIVE = 3

export type SyncSummary = {
    squads: number
    players: number
    gameweeks: number
    matches: number
    points: number
    skipped: string[]
}

/**
 * Resolve a Game Zone squad to one of our teams BY ABBREVIATION.
 *
 * Never by id. Game Zone's squad ids are 1-9 and so are 3DF's legacy positional
 * ids, but the two orderings are nearly reversed (Game Zone 1 = OTT, legacy
 * 1 = SSK). Matching on the integer would silently attribute every player,
 * match and stat line to the wrong club.
 */
async function teamIdByAbbr(): Promise<Map<string, number>> {
    const teams = await db.team.findMany({ select: { id: true, abbreviation: true } })
    return new Map(teams.map((t) => [t.abbreviation.toUpperCase(), t.id]))
}

const squadAbbr = (s: { abbr?: string | null; abbreviation?: string | null } | null | undefined) =>
    (s?.abbreviation ?? s?.abbr ?? '').toUpperCase()

async function syncSquads(items: Squad[]): Promise<number> {
    let n = 0
    for (const s of items) {
        const { count } = await db.team.updateMany({
            where: { abbreviation: s.abbreviation.toUpperCase() },
            data: {
                gameZoneSquadId: s.id,
                nameFr: s.nameFr ?? undefined,
                shortName: s.shortName ?? undefined,
            },
        })
        n += count
        if (count === 0) {
            logger.warn(fileName, `squad ${s.abbreviation} (${s.name}) matched no team row`)
        }
    }
    return n
}

async function syncPlayers(items: FeedPlayer[], year: number): Promise<number> {
    const byAbbr = await teamIdByAbbr()
    const seen: number[] = []

    for (const p of items) {
        const teamId = byAbbr.get(squadAbbr(p.squad)) ?? null
        const common = {
            feedId: p.feedId ?? undefined,
            firstName: p.firstName,
            lastName: p.lastName,
            teamId,
            position: mapPosition(p.position),
            status: p.status ?? undefined,
            isLocked: p.isLocked ?? false,
            injuredTextEn: p.injuredText?.en ?? null,
            isActive: true,
            missedSyncs: 0,
            lastSeenAt: new Date(),
        }
        const player = await db.player.upsert({
            where: { gameZoneId: p.id },
            update: common,
            create: { gameZoneId: p.id, ...common },
        })
        seen.push(player.id)

        // Perishable: salary, projection and the cumulative stat line as of now.
        // The feed exposes only the current value, so an unrecorded week is gone.
        await db.playerStatSnapshot.create({
            data: {
                playerId: player.id,
                year,
                cost: p.cost ?? undefined,
                avgPoints: p.stats?.avgPoints ?? undefined,
                projectedScores: p.stats?.projectedScores ?? undefined,
                weekSalaryChange: p.stats?.weekSalaryChange ?? undefined,
                totalPoints: p.points ?? undefined,
                stats: (p.stats?.stats ?? {}) as object,
            },
        })
    }

    // Absentees age out rather than disappearing.
    await db.player.updateMany({
        where: { id: { notIn: seen } },
        data: { missedSyncs: { increment: 1 } },
    })
    await db.player.updateMany({
        where: { missedSyncs: { gte: MISSED_SYNCS_BEFORE_INACTIVE } },
        data: { isActive: false },
    })

    return items.length
}

async function syncGameweeks(
    items: FeedGameweek[],
    year: number,
): Promise<{ gameweeks: number; matches: number }> {
    const byAbbr = await teamIdByAbbr()
    let matches = 0

    for (const g of items) {
        const gw = await db.gameweek.upsert({
            where: { gameZoneId: g.id },
            update: {
                feedId: g.feedId ?? undefined,
                name: g.name,
                status: g.status,
                startDate: g.startDate ? new Date(g.startDate) : undefined,
                endDate: g.endDate ? new Date(g.endDate) : undefined,
            },
            create: {
                gameZoneId: g.id,
                feedId: g.feedId ?? undefined,
                name: g.name,
                status: g.status,
                year,
                startDate: g.startDate ? new Date(g.startDate) : undefined,
                endDate: g.endDate ? new Date(g.endDate) : undefined,
            },
        })

        for (const m of g.matches) {
            const data = {
                gameweekId: gw.id,
                homeTeamId: byAbbr.get(squadAbbr(m.homeSquad)) ?? null,
                awayTeamId: byAbbr.get(squadAbbr(m.awaySquad)) ?? null,
                homeScore: m.homeSquadScore ?? undefined,
                awayScore: m.awaySquadScore ?? undefined,
                status: m.status,
                venue: m.venue ?? undefined,
                date: m.date ? new Date(m.date) : undefined,
            }
            await db.match.upsert({
                where: { gameZoneId: m.id },
                // geniusFixtureId is deliberately not touched: the PBP job owns it.
                update: data,
                create: { gameZoneId: m.id, year, ...data },
            })
            matches += 1
        }
    }
    return { gameweeks: items.length, matches }
}

// Per-gameweek fantasy points, written after players and gameweeks exist.
async function syncPoints(items: FeedPlayer[]): Promise<number> {
    const players = new Map(
        (await db.player.findMany({ select: { id: true, gameZoneId: true } })).map((p) => [
            p.gameZoneId,
            p.id,
        ]),
    )
    const gameweeks = new Map(
        (await db.gameweek.findMany({ select: { id: true, gameZoneId: true } })).map((g) => [
            g.gameZoneId,
            g.id,
        ]),
    )

    let n = 0
    for (const p of items) {
        const playerId = players.get(p.id)
        const gws = p.stats?.points?.gws
        if (!playerId || !gws) continue
        for (const [rawGw, points] of Object.entries(gws)) {
            const gameweekId = gameweeks.get(Number(rawGw))
            // null = did not feature. Recording it as 0 would be a different
            // claim, and would corrupt any per-game average computed later.
            if (!gameweekId || points === null) continue
            await db.playerGameweekPoints.upsert({
                where: { playerId_gameweekId: { playerId, gameweekId } },
                update: { points },
                create: { playerId, gameweekId, points },
            })
            n += 1
        }
    }
    return n
}

/**
 * Pull all three feeds and reconcile them into the database.
 *
 * Each feed is independent: one failing or arriving malformed does not stop the
 * others, and an INVALID or UNCHANGED result leaves existing rows untouched.
 */
export async function syncGameZone(year: number): Promise<SyncSummary> {
    const summary: SyncSummary = {
        squads: 0,
        players: 0,
        gameweeks: 0,
        matches: 0,
        points: 0,
        skipped: [],
    }

    const squads = await fetchFeed('squads')
    if (squads.status === 'OK') summary.squads = await syncSquads(squads.items as Squad[])
    else summary.skipped.push(`squads:${squads.status}`)

    const gameweeks = await fetchFeed('gameweeks')
    if (gameweeks.status === 'OK') {
        const r = await syncGameweeks(gameweeks.items as FeedGameweek[], year)
        summary.gameweeks = r.gameweeks
        summary.matches = r.matches
    } else summary.skipped.push(`gameweeks:${gameweeks.status}`)

    const players = await fetchFeed('players')
    if (players.status === 'OK') {
        summary.players = await syncPlayers(players.items as FeedPlayer[], year)
        summary.points = await syncPoints(players.items as FeedPlayer[])
    } else summary.skipped.push(`players:${players.status}`)

    logger.info(
        fileName,
        `sync complete: ${summary.players} players, ${summary.gameweeks} gameweeks, ` +
            `${summary.matches} matches, ${summary.points} point rows` +
            (summary.skipped.length ? ` (skipped ${summary.skipped.join(', ')})` : ''),
    )
    return summary
}
