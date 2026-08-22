import type { PassDepth, PassDirection, Prisma } from '~/generated/prisma/client'

// Pure aggregation over parsed plays: the box score and per-player lines behind
// Game.boxScore, Game.playerStats and Query.playerSeasonStats. Callers select
// STAT_PLAY_SELECT and pass the rows in; nothing here touches the database.
//
// NO-PLAYS ARE THE CALLER'S JOB to exclude (`where: { isNoPlay: false }`), so
// the same rows can feed every aggregate without a second filter.

export const STAT_PLAY_SELECT = {
    gameId: true,
    geniusTeamId: true,
    type: true,
    description: true,
    passer: true,
    rusher: true,
    receiver: true,
    isComplete: true,
    isTurnover: true,
    isFirstDown: true,
    yardsGained: true,
    epa: true,
    targetDepth: true,
    targetDirection: true,
    points: true,
} as const satisfies Prisma.PlaySelect

export type StatPlay = Prisma.PlayGetPayload<{ select: typeof STAT_PLAY_SELECT }>

export type TeamBoxScore = {
    geniusTeamId: string
    points: number
    plays: number
    passAttempts: number
    completions: number
    passingYards: number
    rushAttempts: number
    rushingYards: number
    totalYards: number
    turnovers: number
    firstDowns: number
    epa: number
}

export type ZoneTargets = {
    depth: PassDepth
    direction: PassDirection
    targets: number
    receptions: number
    yards: number
    epa: number
}

export type PlayerLine = {
    player: string
    geniusTeamId: string
    games: number
    passAttempts: number
    completions: number
    passingYards: number
    passingTouchdowns: number
    interceptions: number
    rushAttempts: number
    rushingYards: number
    rushingTouchdowns: number
    targets: number
    receptions: number
    receivingYards: number
    receivingTouchdowns: number
    // EPA of every play the player threw, carried or was targeted on.
    epa: number
    targetsByZone: ZoneTargets[]
}

const round = (n: number): number => Math.round(n * 1000) / 1000

/**
 * Team totals, one entry per team that has a play in the input. Points come
 * from Play.points, which is signed for the play's own team: a -6 on team A's
 * play is six points for the OTHER team in the game.
 */
export function teamBoxScores(plays: StatPlay[]): TeamBoxScore[] {
    const byTeam = new Map<string, TeamBoxScore>()
    const get = (id: string): TeamBoxScore => {
        let b = byTeam.get(id)
        if (!b) {
            b = {
                geniusTeamId: id,
                points: 0,
                plays: 0,
                passAttempts: 0,
                completions: 0,
                passingYards: 0,
                rushAttempts: 0,
                rushingYards: 0,
                totalYards: 0,
                turnovers: 0,
                firstDowns: 0,
                epa: 0,
            }
            byTeam.set(id, b)
        }
        return b
    }
    const teams = [...new Set(plays.map((p) => p.geniusTeamId))]
    teams.forEach(get)

    for (const p of plays) {
        const b = get(p.geniusTeamId)
        const pts = p.points ?? 0
        if (pts > 0) b.points += pts
        // ponytail: a return score credits every OTHER team in the input; a game
        // has exactly two, so this is exact there and meaningless across games.
        if (pts < 0) for (const t of teams) if (t !== p.geniusTeamId) get(t).points -= pts
        b.epa += p.epa ?? 0
        if (p.isTurnover) b.turnovers += 1
        if (p.isFirstDown) b.firstDowns += 1
        if (p.type === 'Pass' && p.passer) {
            b.plays += 1
            b.passAttempts += 1
            if (p.isComplete) {
                b.completions += 1
                b.passingYards += p.yardsGained ?? 0
            }
        } else if (p.type === 'Run' && p.rusher) {
            b.plays += 1
            b.rushAttempts += 1
            b.rushingYards += p.yardsGained ?? 0
        }
    }
    for (const b of byTeam.values()) {
        b.totalYards = b.passingYards + b.rushingYards
        b.epa = round(b.epa)
    }
    return [...byTeam.values()]
}

/**
 * Per-player lines keyed by (team, name as printed in the play text). Sorted by
 * involvement — targets + pass attempts + rush attempts — descending, then name,
 * so the list a client shows first is the players who touched the ball most.
 */
export function playerLines(plays: StatPlay[]): PlayerLine[] {
    const lines = new Map<string, PlayerLine & { gameIds: Set<number> }>()
    const get = (player: string, geniusTeamId: string) => {
        const key = `${geniusTeamId}|${player}`
        let l = lines.get(key)
        if (!l) {
            l = {
                player,
                geniusTeamId,
                games: 0,
                gameIds: new Set(),
                passAttempts: 0,
                completions: 0,
                passingYards: 0,
                passingTouchdowns: 0,
                interceptions: 0,
                rushAttempts: 0,
                rushingYards: 0,
                rushingTouchdowns: 0,
                targets: 0,
                receptions: 0,
                receivingYards: 0,
                receivingTouchdowns: 0,
                epa: 0,
                targetsByZone: [],
            }
            lines.set(key, l)
        }
        return l
    }
    const zones = new Map<string, Map<string, ZoneTargets>>()

    for (const p of plays) {
        const td = p.points === 6
        const yards = p.yardsGained ?? 0
        const epa = p.epa ?? 0
        if (p.type === 'Pass' && p.passer) {
            const l = get(p.passer, p.geniusTeamId)
            l.gameIds.add(p.gameId)
            l.passAttempts += 1
            l.epa += epa
            if (p.isComplete) {
                l.completions += 1
                l.passingYards += yards
                if (td) l.passingTouchdowns += 1
            }
            if (/intercept/i.test(p.description)) l.interceptions += 1
        }
        if (p.type === 'Run' && p.rusher) {
            const l = get(p.rusher, p.geniusTeamId)
            l.gameIds.add(p.gameId)
            l.rushAttempts += 1
            l.rushingYards += yards
            l.epa += epa
            if (td) l.rushingTouchdowns += 1
        }
        if (p.type === 'Pass' && p.receiver) {
            const l = get(p.receiver, p.geniusTeamId)
            l.gameIds.add(p.gameId)
            l.targets += 1
            l.epa += epa
            if (p.isComplete) {
                l.receptions += 1
                l.receivingYards += yards
                if (td) l.receivingTouchdowns += 1
            }
            if (p.targetDepth && p.targetDirection) {
                const key = `${p.geniusTeamId}|${p.receiver}`
                let byZone = zones.get(key)
                if (!byZone) zones.set(key, (byZone = new Map()))
                const zk = `${p.targetDepth}|${p.targetDirection}`
                let z = byZone.get(zk)
                if (!z) {
                    z = {
                        depth: p.targetDepth,
                        direction: p.targetDirection,
                        targets: 0,
                        receptions: 0,
                        yards: 0,
                        epa: 0,
                    }
                    byZone.set(zk, z)
                }
                z.targets += 1
                z.epa += epa
                if (p.isComplete) {
                    z.receptions += 1
                    z.yards += yards
                }
            }
        }
    }

    const out: PlayerLine[] = []
    for (const [key, { gameIds, ...l }] of lines) {
        const byZone = [...(zones.get(key)?.values() ?? [])]
            .map((z) => ({ ...z, epa: round(z.epa) }))
            .sort(
                (a, b) => a.depth.localeCompare(b.depth) || a.direction.localeCompare(b.direction),
            )
        out.push({ ...l, games: gameIds.size, epa: round(l.epa), targetsByZone: byZone })
    }
    const involvement = (l: PlayerLine) => l.targets + l.passAttempts + l.rushAttempts
    return out.sort((a, b) => involvement(b) - involvement(a) || a.player.localeCompare(b.player))
}
