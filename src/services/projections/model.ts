// Projection model v1. PURE — no database.
//
// Per stat, a player's expected per-game production is
//
//     role baseline + player term + role baseline × (OC offset + DC offset)
//
// Four ADDITIVE effects, each pooled toward the league, and never a raw
// OC × DC × role cell: a coordinator pair meets two to four times a season, so
// any cell is n = 1-3 and pure noise (docs/backlog.md item 6). Here every term
// is estimated from the whole era and shrunk by its own sample size:
//
//   - role baseline   mean over every player-game in the role (QB, RB, or a
//                     receiver slot in Wilson's vocabulary — WR:1S, WR:2WK …)
//   - player term     the player's mean minus the role baseline, shrunk by
//                     n / (n + PLAYER_PRIOR_GAMES) so a one-game sample is half
//                     baseline and a full season is nearly all the player
//   - OC offset       the offensive coordinator's team totals as a fraction
//                     above or below the league per-game mean, shrunk by games
//   - DC offset       the same for what opponents produced against the
//                     defensive coordinator
//
// Offsets are fractions of the role baseline rather than raw yards, so the same
// "this offence throws 12% more" applies sensibly to a 1S and a third-string
// back. Negative projections are floored at zero.
//
// ERA-SCOPED. Callers fit on one rule era's games only (docs/memory/
// project-cfl-rule-eras.md); 2027 starts from nothing.

export const STAT_KEYS = [
    'passAttempts',
    'passingYards',
    'passingTouchdowns',
    'interceptions',
    'rushAttempts',
    'rushingYards',
    'rushingTouchdowns',
    'targets',
    'receptions',
    'receivingYards',
    'receivingTouchdowns',
    'fumblesLost',
    'epa',
] as const
export type StatKey = (typeof STAT_KEYS)[number]
export type StatLine = Record<StatKey, number>

/** One player's line in one game. */
export type ObservedGame = {
    gameId: number
    playerKey: string
    role: string
    stats: StatLine
}

/** One team's totals in one game, with who was calling the plays on each side. */
export type TeamGame = {
    gameId: number
    teamKey: string
    ocKey: string
    /** The OPPONENT's defensive coordinator. */
    dcKey: string
    stats: StatLine
}

export type Target = {
    playerKey: string
    role: string
    ocKey: string
    dcKey: string
}

// Prior weights, in games. A player term is half-trusted after one game; a
// coordinator offset after six. Re-tuned 2026-08-24 on the same 2026 hold-out
// (weeks 9-11, fitted on the weeks before each, scripts/evalProjections.ts)
// after QB/RB baselines split starters from backups: priors of 1, 2, 3 and 4
// gave MAE 5.31, 5.42, 5.49 and 5.54 against 5.42 for a plain season-average.
// The split itself was worth ~0.2 (5.50 -> 5.31 at prior 1) and is what put
// the model AHEAD of the season-average baseline for the first time. The
// coordinator offsets were worth about 0.1 when last isolated. Revisit with
// more seasons.
export const PLAYER_PRIOR_GAMES = 1
export const COORD_PRIOR_GAMES = 6

export const zeroLine = (): StatLine => Object.fromEntries(STAT_KEYS.map((k) => [k, 0])) as StatLine

const add = (a: StatLine, b: StatLine): void => {
    for (const k of STAT_KEYS) a[k] += b[k]
}
const scale = (a: StatLine, f: number): StatLine =>
    Object.fromEntries(STAT_KEYS.map((k) => [k, a[k] * f])) as StatLine

type Mean = { n: number; sum: StatLine }
const meanOf = (m: Mean | undefined): StatLine | null =>
    m && m.n > 0 ? scale(m.sum, 1 / m.n) : null

function accumulate<K>(map: Map<K, Mean>, key: K, stats: StatLine): void {
    let m = map.get(key)
    if (!m) map.set(key, (m = { n: 0, sum: zeroLine() }))
    m.n += 1
    add(m.sum, stats)
}

export type Model = {
    roleMeans: Map<string, StatLine>
    /** Fallback when a role has no sample: the position group's mean (WR:* → WR). */
    groupMeans: Map<string, StatLine>
    players: Map<string, { games: number; mean: StatLine }>
    leagueTeamMean: StatLine
    /** Shrunk fractional offsets per coordinator, per stat. */
    oc: Map<string, StatLine>
    dc: Map<string, StatLine>
}

export const roleGroup = (role: string): string => role.split(':')[0]

/** Shrink a fractional deviation by its sample: n / (n + prior). */
const shrunkFraction = (m: Mean | undefined, league: StatLine, prior: number): StatLine | null => {
    const mean = meanOf(m)
    if (!mean || !m) return null
    const w = m.n / (m.n + prior)
    return Object.fromEntries(
        STAT_KEYS.map((k) => [k, league[k] > 0 ? (w * (mean[k] - league[k])) / league[k] : 0]),
    ) as StatLine
}

export function fitModel(observed: ObservedGame[], teamGames: TeamGame[]): Model {
    const roles = new Map<string, Mean>()
    const groups = new Map<string, Mean>()
    const players = new Map<string, Mean>()
    for (const o of observed) {
        accumulate(roles, o.role, o.stats)
        accumulate(groups, roleGroup(o.role), o.stats)
        accumulate(players, o.playerKey, o.stats)
    }

    const league: Mean = { n: 0, sum: zeroLine() }
    const ocs = new Map<string, Mean>()
    const dcs = new Map<string, Mean>()
    for (const g of teamGames) {
        league.n += 1
        add(league.sum, g.stats)
        accumulate(ocs, g.ocKey, g.stats)
        accumulate(dcs, g.dcKey, g.stats)
    }
    const leagueTeamMean = meanOf(league) ?? zeroLine()

    const fractions = (src: Map<string, Mean>): Map<string, StatLine> => {
        const out = new Map<string, StatLine>()
        for (const [k, m] of src) {
            const f = shrunkFraction(m, leagueTeamMean, COORD_PRIOR_GAMES)
            if (f) out.set(k, f)
        }
        return out
    }

    return {
        roleMeans: new Map([...roles].map(([k, m]) => [k, meanOf(m)!])),
        groupMeans: new Map([...groups].map(([k, m]) => [k, meanOf(m)!])),
        players: new Map([...players].map(([k, m]) => [k, { games: m.n, mean: meanOf(m)! }])),
        leagueTeamMean,
        oc: fractions(ocs),
        dc: fractions(dcs),
    }
}

/**
 * Project one player. Null when the role has no baseline at all (an era with
 * no games yet) — a projection must come from data, not from zeros.
 */
export function project(
    model: Model,
    target: Target,
    playerPrior: number = PLAYER_PRIOR_GAMES,
): { stats: StatLine; games: number } | null {
    const baseline =
        model.roleMeans.get(target.role) ?? model.groupMeans.get(roleGroup(target.role))
    if (!baseline) return null
    const player = model.players.get(target.playerKey)
    const games = player?.games ?? 0
    const w = games / (games + playerPrior)
    const oc = model.oc.get(target.ocKey)
    const dc = model.dc.get(target.dcKey)
    const stats = zeroLine()
    for (const k of STAT_KEYS) {
        const playerTerm = player ? w * (player.mean[k] - baseline[k]) : 0
        const offsets = (oc?.[k] ?? 0) + (dc?.[k] ?? 0)
        const v = baseline[k] + playerTerm + baseline[k] * offsets
        // EPA is signed; production is not.
        stats[k] = k === 'epa' ? v : Math.max(0, v)
    }
    return { stats, games }
}
