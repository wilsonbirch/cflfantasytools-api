// Fit the projection model from stored plays and write a gameweek's projections.
//
// The model itself is pure (model.ts). This module does the joins it needs:
// plays -> per-player lines per game, play-text names -> Game Zone players,
// charts -> receiver roles, coaching staff -> who was calling plays, and the
// schedule -> who plays whom next. Everything is rebuilt from stored rows on
// every run, so a model change is a refit, never a data loss.

import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import { ruleEraForYear, type RuleEra } from '~/lib/season.server'
import { alignmentFor, splitPlayText } from '~/services/stats/alignment'
import { gameAlignments } from '~/services/stats/alignment.server'
import { playerLines, STAT_PLAY_SELECT, type PlayerLine } from '~/services/stats/playStats'
import { currentGameweek, seasonGameweeks } from '~/services/gamezone/gameweeks.server'
import {
    fitModel,
    project,
    STAT_KEYS,
    zeroLine,
    type ObservedGame,
    type StatLine,
    type TeamGame,
} from './model'

const fileName = 'services/projections/fitProjections'

// A player is projected only if they appeared in one of their team's last
// RECENT_GAMES games: a season-long mean for someone who has not dressed in a
// month is a projection for a player who will not play.
const RECENT_GAMES = 3

export type ProjectionRow = {
    playerId: number
    gameweekId: number
    opponentTeamId: number | null
    alignment: string | null
    games: number
} & StatLine

const letters = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '')

type PlayerRef = { id: number; firstName: string; lastName: string; position: string }

/**
 * "#6 T.Philpot" on team X -> the Game Zone player with that surname and first
 * initial on team X. Null when nobody or more than one matches; play text has
 * no stable id, so ambiguity is left unresolved rather than guessed.
 */
function matchPlayer(playText: string, candidates: PlayerRef[]): PlayerRef | null {
    const { surname } = splitPlayText(playText)
    const initial = playText.replace(/^#?\d+\s+/, '')[0]?.toLowerCase()
    const hits = candidates.filter(
        (p) => letters(p.lastName) === surname && p.firstName[0]?.toLowerCase() === initial,
    )
    return hits.length === 1 ? hits[0] : null
}

type Staff = { teamId: number; role: string; person: string; from: Date; to: Date | null }

/** Who held a role at a club on a date; falls back to the team itself. */
function coordinatorKey(staff: Staff[], teamId: number, role: 'OC' | 'DC', at: Date): string {
    const row = staff.find(
        (s) =>
            s.teamId === teamId && s.role === role && s.from <= at && (s.to === null || s.to >= at),
    )
    return row ? `${role}:${row.person}` : `${role}:team-${teamId}`
}

const lineStats = (l: PlayerLine): StatLine => ({
    passAttempts: l.passAttempts,
    passingYards: l.passingYards,
    passingTouchdowns: l.passingTouchdowns,
    interceptions: l.interceptions,
    rushAttempts: l.rushAttempts,
    rushingYards: l.rushingYards,
    rushingTouchdowns: l.rushingTouchdowns,
    targets: l.targets,
    receptions: l.receptions,
    receivingYards: l.receivingYards,
    receivingTouchdowns: l.receivingTouchdowns,
    fumblesLost: l.fumblesLost,
    epa: l.epa,
})

// QB and RB baselines separate the game's starter (led the team in pass or
// rush attempts) from everyone else: a pooled QB mean is diluted by backups,
// which drags every starter's shrunk projection down (docs/backlog.md, phase-3
// accuracy notes). roleGroup() still folds QB:1 and QB:2 to QB for fallback.
const roleOf = (position: string, alignment: string | null, isStarter: boolean): string =>
    position === 'QUARTERBACK'
        ? `QB:${isStarter ? 1 : 2}`
        : position === 'RUNNING_BACK'
          ? `RB:${isStarter ? 1 : 2}`
          : `WR:${alignment ?? '?'}`

export type TrainingSet = {
    observed: ObservedGame[]
    teamGames: TeamGame[]
    /** Newest play-text name per player id, for matching against a chart. */
    playText: Map<number, string>
    /** Game ids per team id, newest first. */
    teamGameIds: Map<number, number[]>
    /** Player ids seen per game id. */
    playersInGame: Map<number, Set<number>>
    /** Each player's role in their MOST RECENT game (QB:1 vs QB:2, ...). */
    lastRole: Map<number, string>
}

/**
 * Every parsed game of the era that kicked off before `asOf`, as player lines
 * and team totals. `asOf` is what makes a hold-out honest: fitting for week 10
 * sees nothing from week 10 on.
 */
export async function trainingSet(era: RuleEra, asOf: Date): Promise<TrainingSet> {
    const [teams, players, staffRows] = await Promise.all([
        db.team.findMany({ select: { id: true, geniusTeamId: true } }),
        db.player.findMany({
            where: { position: { not: 'OTHER' } },
            select: { id: true, firstName: true, lastName: true, teamId: true, position: true },
        }),
        db.coachingStaff.findMany({
            select: {
                teamId: true,
                role: true,
                person: true,
                effectiveFrom: true,
                effectiveTo: true,
            },
        }),
    ])
    const teamByGenius = new Map(
        teams.flatMap((t) => (t.geniusTeamId ? [[t.geniusTeamId, t.id]] : [])),
    )
    const playersByTeam = new Map<number, PlayerRef[]>()
    for (const p of players) {
        if (p.teamId === null) continue
        playersByTeam.set(p.teamId, [...(playersByTeam.get(p.teamId) ?? []), p])
    }
    const staff: Staff[] = staffRows.map((s) => ({
        teamId: s.teamId,
        role: s.role,
        person: s.person,
        from: s.effectiveFrom,
        to: s.effectiveTo,
    }))

    // Only fixtures Game Zone schedules: preseason games are parsed too, but
    // starters sit and the fantasy game does not score them.
    const fixtures = await db.match.findMany({
        where: { geniusFixtureId: { not: null } },
        select: { geniusFixtureId: true },
    })
    const games = await db.game.findMany({
        where: {
            id: { in: fixtures.map((m) => m.geniusFixtureId!) },
            ruleEra: era,
            playCount: { gt: 0 },
            startedAt: { lt: asOf },
        },
        select: { id: true, startedAt: true, homeGeniusTeamId: true, awayGeniusTeamId: true },
        orderBy: { startedAt: 'asc' },
    })

    const set: TrainingSet = {
        observed: [],
        teamGames: [],
        playText: new Map(),
        teamGameIds: new Map(),
        playersInGame: new Map(),
        lastRole: new Map(),
    }
    for (const g of games) {
        const plays = await db.play.findMany({
            where: { gameId: g.id, isNoPlay: false },
            select: STAT_PLAY_SELECT,
        })
        const lines = playerLines(plays)
        const geniusIds = [...new Set(lines.map((l) => l.geniusTeamId))]
        const charts = await gameAlignments(g.startedAt, geniusIds)
        const totals = new Map<string, StatLine>()
        const seen = new Set<number>()
        const matched: {
            geniusTeamId: string
            player: PlayerRef
            alignment: string | null
            stats: StatLine
        }[] = []
        for (const l of lines) {
            const teamId = teamByGenius.get(l.geniusTeamId)
            const stats = lineStats(l)
            const t = totals.get(l.geniusTeamId) ?? zeroLine()
            for (const k of STAT_KEYS) t[k] += stats[k]
            totals.set(l.geniusTeamId, t)
            if (teamId === undefined) continue
            const player = matchPlayer(l.player, playersByTeam.get(teamId) ?? [])
            if (!player) continue
            const alignment = alignmentFor(l.player, charts.get(l.geniusTeamId) ?? [])
            matched.push({ geniusTeamId: l.geniusTeamId, player, alignment, stats })
            set.playText.set(player.id, l.player)
            seen.add(player.id)
        }
        // The game's starters, per team: the QB who led in pass attempts and
        // the RB who led in rush attempts.
        const leader = (genius: string, position: string, key: 'passAttempts' | 'rushAttempts') =>
            matched
                .filter(
                    (m) =>
                        m.geniusTeamId === genius &&
                        m.player.position === position &&
                        m.stats[key] > 0,
                )
                .sort((a, b) => b.stats[key] - a.stats[key])[0]?.player.id
        const starters = new Set<number>()
        for (const genius of geniusIds) {
            const qb1 = leader(genius, 'QUARTERBACK', 'passAttempts')
            const rb1 = leader(genius, 'RUNNING_BACK', 'rushAttempts')
            if (qb1 !== undefined) starters.add(qb1)
            if (rb1 !== undefined) starters.add(rb1)
        }
        for (const m of matched) {
            const role = roleOf(m.player.position, m.alignment, starters.has(m.player.id))
            set.observed.push({
                gameId: g.id,
                playerKey: String(m.player.id),
                role,
                stats: m.stats,
            })
            set.lastRole.set(m.player.id, role)
        }
        set.playersInGame.set(g.id, seen)
        // Team totals need both sides present to name the opposing DC.
        const at = g.startedAt ?? asOf
        for (const [genius, stats] of totals) {
            const teamId = teamByGenius.get(genius)
            const oppGenius =
                genius === g.homeGeniusTeamId ? g.awayGeniusTeamId : g.homeGeniusTeamId
            const oppId = oppGenius ? teamByGenius.get(oppGenius) : undefined
            if (teamId === undefined || oppId === undefined) continue
            set.teamGames.push({
                gameId: g.id,
                teamKey: String(teamId),
                ocKey: coordinatorKey(staff, teamId, 'OC', at),
                dcKey: coordinatorKey(staff, oppId, 'DC', at),
                stats,
            })
            set.teamGameIds.set(teamId, [g.id, ...(set.teamGameIds.get(teamId) ?? [])])
        }
    }
    return set
}

/**
 * Projections for every fixture of one gameweek, from games before `asOf`
 * (default: now). Returns rows without writing them. `playerPrior` overrides
 * PLAYER_PRIOR_GAMES — only scripts/evalProjections.ts sweeps it.
 */
export async function fitGameweek(
    gameweekId: number,
    asOf = new Date(),
    playerPrior?: number,
): Promise<ProjectionRow[]> {
    const gw = await db.gameweek.findUniqueOrThrow({
        where: { id: gameweekId },
        select: {
            id: true,
            year: true,
            matches: { select: { homeTeamId: true, awayTeamId: true, date: true } },
        },
    })
    const era = ruleEraForYear(gw.year)
    const set = await trainingSet(era, asOf)
    const model = fitModel(set.observed, set.teamGames)

    const staffRows = await db.coachingStaff.findMany({
        select: { teamId: true, role: true, person: true, effectiveFrom: true, effectiveTo: true },
    })
    const staff: Staff[] = staffRows.map((s) => ({
        teamId: s.teamId,
        role: s.role,
        person: s.person,
        from: s.effectiveFrom,
        to: s.effectiveTo,
    }))

    const rows: ProjectionRow[] = []
    for (const m of gw.matches) {
        if (m.homeTeamId === null || m.awayTeamId === null) continue
        const at = m.date ?? asOf
        for (const [teamId, oppId] of [
            [m.homeTeamId, m.awayTeamId],
            [m.awayTeamId, m.homeTeamId],
        ]) {
            const recent = (set.teamGameIds.get(teamId) ?? []).slice(0, RECENT_GAMES)
            const dressed = new Set(recent.flatMap((id) => [...(set.playersInGame.get(id) ?? [])]))
            // The team's newest parsed chart as of the fit, for receiver roles.
            const chart = await db.depthChart.findFirst({
                where: { teamId, parseStatus: 'OK', publishedAt: { lt: asOf } },
                orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
                select: {
                    positions: {
                        select: { position: true, player: true, jersey: true, depth: true },
                    },
                },
            })
            const players = await db.player.findMany({
                where: { teamId, isActive: true, position: { not: 'OTHER' } },
                select: { id: true, position: true },
            })
            const ocKey = coordinatorKey(staff, teamId, 'OC', at)
            const dcKey = coordinatorKey(staff, oppId, 'DC', at)
            for (const p of players) {
                if (!dressed.has(p.id)) continue
                const text = set.playText.get(p.id)
                const alignment = text && chart ? alignmentFor(text, chart.positions) : null
                // A QB or RB is projected as the starter only if they were the
                // starter in their most recent game — the chart PDFs carry no
                // QB/RB depth, so usage is the freshest signal there is.
                const role =
                    p.position === 'QUARTERBACK' || p.position === 'RUNNING_BACK'
                        ? (set.lastRole.get(p.id) ?? roleOf(p.position, null, false))
                        : roleOf(p.position, alignment, false)
                const out = project(
                    model,
                    {
                        playerKey: String(p.id),
                        role,
                        ocKey,
                        dcKey,
                    },
                    playerPrior,
                )
                if (!out) continue
                rows.push({
                    playerId: p.id,
                    gameweekId: gw.id,
                    opponentTeamId: oppId,
                    alignment,
                    games: out.games,
                    ...out.stats,
                })
            }
        }
    }
    return rows
}

/**
 * The scheduled job: project the gameweek lineups are being set for and the
 * one after it, and store the rows under one fittedAt.
 */
export async function runProjectionsFit(
    year: number,
    now = new Date(),
): Promise<{ gameweeks: number; rows: number }> {
    const current = await currentGameweek(year)
    if (!current) {
        logger.warn(fileName, `projections-fit: no gameweeks for ${year}, nothing projected`)
        return { gameweeks: 0, rows: 0 }
    }
    const season = await seasonGameweeks(year)
    const targets = season.filter((g) => g.week === current.week || g.week === current.week + 1)

    const fittedAt = now
    let total = 0
    const parts: string[] = []
    for (const gw of targets) {
        const rows = await fitGameweek(gw.id, now)
        if (rows.length > 0) {
            await db.projection.createMany({ data: rows.map((r) => ({ ...r, fittedAt })) })
        }
        total += rows.length
        parts.push(`week ${gw.week}=${rows.length}`)
    }
    const line = `projections-fit: ${total} projections across ${targets.length} gameweek(s) [${parts.join(', ')}]`
    if (total === 0) logger.warn(fileName, `${line} — NOTHING PROJECTED`)
    else logger.info(fileName, line)
    return { gameweeks: targets.length, rows: total }
}
