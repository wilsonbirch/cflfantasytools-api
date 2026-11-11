// Repairs for the 2023/24 legacy payloads. PURE — no database.
//
// WHY THIS EXISTS: summed play by play, 89 of the 190 legacy games did not reach
// their own official final (`scoreboardInfo`) — the "~45% of games stamped with
// the wrong team" in the backlog. The parser was not misreading the rows: the
// rows themselves are wrong, in the feed, in the ways below. With them repaired
// 150 of the 190 reach the final. Of the 40 that do not, 12 contain a safety,
// which the parser does not score in any era; most of the rest are a point or
// two out, on rows the feed never recorded.
//
//  1. GHOST COPIES. Genius re-sequenced drives after the game (the copies share
//     one post-game timestamp), and the old rows stayed in `playByPlayInfo.ALL`.
//     A run of drive N+1's plays reappears at the end of drive N, under the SAME
//     play numbers (`2-4..2-7` duplicating `3-4..3-7`) and stamped with drive N's
//     team. That is the "wrong team" stamp: Zach Collaros completing passes for
//     Ottawa. 614 such rows in 38 games of 2023, 9 in 2 games of 2024. They score
//     twice, and they hand the other team's plays — and its touchdowns — to the
//     wrong drive, which corrupts the expected-points label of every drive in
//     that half. A field goal or convert keyed twice in a row is the same fault
//     inside one drive.
//  2. A `Touchdown` subtype on a play whose text is an ordinary gain ("rush
//     middle for 2 yards gain to the BC52"). The description was corrected and
//     the subtype was not. 11 rows, all 2023.
//  3. A field goal still scored though its text says the score was "nullified
//     by penalty" or wiped as NO PLAY: a `Success` worth 3, or a missed kick
//     returned for a touchdown worth 6. 10 rows.
//  4. A missed field goal that conceded a single ("NO GOOD ... SINGLE") arrives
//     as `Failed`, and so scored nothing. 43 rows, 20 in 2023 and 23 in 2024.
//
// The play TEXT is the authority throughout: it is what the official final
// agrees with. Every rule here fires only on a row whose own text contradicts
// its own fields, or on an exact duplicate, so a clean payload passes through
// untouched — but it is still applied to the PRE_2026 era only (see
// parsePlays.server.ts), because that is the only corpus it was measured on.

import type { RawPlay } from './drives'
import { leadPlayerOf } from './parseDescription'

export type LegacyRepairSummary = {
    /** Ghost copies removed. */
    duplicatesDropped: number
    /** `Touchdown` rows whose text shows no touchdown, cleared. */
    touchdownsCleared: number
    /** Field-goal plays still scored though their text says the score was wiped. */
    fieldGoalsNullified: number
    /** Missed field goals that conceded a single, rescored as `Single`. */
    missedFieldGoalSingles: number
}

export type LegacyRepair = {
    plays: RawPlay[]
    dropped: RawPlay[]
    summary: LegacyRepairSummary
}

const driveOf = (p: RawPlay): number => Number(p.id.split('-')[0])

/**
 * Everything that makes two rows the same snap. Two real plays never share all
 * of it: a play is described with its clock, quarter and start position, and even
 * a re-run after a penalty changes the down or the text.
 *
 * `1ST DOWN` is dropped from the text first: it is the one annotation a ghost
 * and its original have been seen to disagree on (a touchdown, 9889320).
 */
const contentKey = (p: RawPlay): string =>
    [
        p.phase,
        p.phaseQualifier,
        p.clock,
        p.description.replace(/,? 1ST DOWN/g, ''),
        p.playStartPosition,
    ].join('\u0001')

/**
 * Game time as one increasing number, or null when the row carries no clock.
 * The clock counts DOWN within a period, so elapsed time is its complement.
 */
function elapsed(p: RawPlay): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(p.clock)
    if (!m) return null
    const period =
        p.phase === 'Overtime' ? 4 + (Number(p.phaseQualifier) || 1) : Number(p.phaseQualifier)
    if (!Number.isFinite(period)) return null
    return period * 900 + (900 - (Number(m[1]) * 60 + Number(m[2])))
}

/**
 * Split identical rows into clusters of copies.
 *
 * Copies sit in the same drive or in adjacent ones — that is how the fault
 * produces them. Identical text further apart is two real plays, which does
 * happen: a convert keyed without a clock reads the same every time its kicker
 * takes one.
 */
function duplicateClusters(chrono: RawPlay[]): RawPlay[][] {
    const byKey = new Map<string, RawPlay[]>()
    for (const p of chrono) {
        const k = contentKey(p)
        const list = byKey.get(k)
        if (list) list.push(p)
        else byKey.set(k, [p])
    }
    const clusters: RawPlay[][] = []
    for (const list of byKey.values()) {
        if (list.length < 2) continue
        let current: RawPlay[] = [list[0]]
        for (let i = 1; i < list.length; i++) {
            if (driveOf(list[i]) - driveOf(list[i - 1]) <= 1) current.push(list[i])
            else {
                if (current.length > 1) clusters.push(current)
                current = [list[i]]
            }
        }
        if (current.length > 1) clusters.push(current)
    }
    return clusters
}

/**
 * Each named player's team, learned from the rows that are NOT duplicated.
 *
 * A passer, ball carrier or kicker plays for one side all game, so the rows the
 * fault did not touch say which side that is — and therefore which copy of a
 * duplicated row carries the right team id. Penalty-only rows are skipped: the
 * one name on them is the offender, who may be on either side.
 */
function playerTeams(chrono: RawPlay[], duplicated: Set<RawPlay>): Map<string, string> {
    const votes = new Map<string, Map<string, number>>()
    for (const p of chrono) {
        if (duplicated.has(p) || p.type === 'Penalty') continue
        const who = leadPlayerOf(p.description)
        if (!who) continue
        const tally = votes.get(who) ?? new Map<string, number>()
        tally.set(p.teamId, (tally.get(p.teamId) ?? 0) + 1)
        votes.set(who, tally)
    }
    const teams = new Map<string, string>()
    for (const [who, tally] of votes) {
        const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1])
        // A split vote is no evidence either way.
        if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) teams.set(who, ranked[0][0])
    }
    return teams
}

/**
 * Which copy is the real one. Three tests, in order of how much they can be
 * trusted:
 *
 *  1. THE PLAYER'S TEAM. The ghost is stamped with the team of the drive it was
 *     left in, so when the copies disagree on team id, the copy whose team is
 *     the named player's own is the real play. Measured on the corpus this is
 *     the only test that never contradicts the play text; neither "the older
 *     timestamp" nor "the earlier drive" holds across games.
 *  2. THE GAME CLOCK. A ghost sits out of time: it is followed by a play from
 *     earlier in the quarter, or preceded by one from later. Each copy is
 *     checked against its nearest clocked neighbours that are not themselves
 *     duplicated — a whole run of ghosts must not vouch for itself.
 *  3. THE LATER COPY. The fault copies drive N+1 onto the end of drive N, so
 *     when nothing else separates them the later copy is the original. In
 *     practice this only decides between copies on the same team.
 */
function keeperOf(
    cluster: RawPlay[],
    chrono: RawPlay[],
    duplicated: Set<RawPlay>,
    teamOfPlayer: Map<string, string>,
): RawPlay {
    const who = leadPlayerOf(cluster[0].description)
    const team = cluster[0].type === 'Penalty' || !who ? undefined : teamOfPlayer.get(who)
    const onTeam = team === undefined ? [] : cluster.filter((c) => c.teamId === team)
    const candidates = onTeam.length > 0 ? onTeam : cluster

    const anchor = (from: number, step: 1 | -1): number | null => {
        for (let i = from + step; i >= 0 && i < chrono.length; i += step) {
            const p = chrono[i]
            if (duplicated.has(p)) continue
            const t = elapsed(p)
            if (t !== null) return t
        }
        return null
    }
    let best = candidates[candidates.length - 1]
    let bestScore = -1
    // Walked last-first so that a tie keeps the later copy.
    for (const copy of [...candidates].reverse()) {
        const t = elapsed(copy)
        const at = chrono.indexOf(copy)
        const before = anchor(at, -1)
        const after = anchor(at, 1)
        const score =
            t === null
                ? 0
                : (before === null || before <= t ? 1 : 0) + (after === null || t <= after ? 1 : 0)
        if (score > bestScore) {
            best = copy
            bestScore = score
        }
    }
    return best
}

const WIPED = /nullified|NO PLAY/
const GOAL_LINE_TOUCHDOWN = /to the [A-Za-z]{2,}00 TOUCHDOWN/

/**
 * Repair one legacy game's plays. Takes and returns CHRONOLOGICAL order.
 *
 * Rows are copied, never mutated: the raw payload stays in `Game.response` and
 * is the record of what the feed actually said.
 */
export function repairLegacyPlays(chrono: RawPlay[]): LegacyRepair {
    const summary: LegacyRepairSummary = {
        duplicatesDropped: 0,
        touchdownsCleared: 0,
        fieldGoalsNullified: 0,
        missedFieldGoalSingles: 0,
    }

    const clusters = duplicateClusters(chrono)
    const duplicated = new Set(clusters.flat())
    const teamOfPlayer = playerTeams(chrono, duplicated)
    const dropped = new Set<RawPlay>()
    for (const cluster of clusters) {
        const keep = keeperOf(cluster, chrono, duplicated, teamOfPlayer)
        for (const copy of cluster) if (copy !== keep) dropped.add(copy)
    }
    summary.duplicatesDropped = dropped.size

    const plays: RawPlay[] = []
    for (const p of chrono) {
        if (dropped.has(p)) continue
        if (p.subType === 'Touchdown' && !p.description.includes('TOUCHDOWN')) {
            summary.touchdownsCleared += 1
            plays.push({ ...p, subType: null, isScoring: false })
        } else if (
            p.type === 'FieldGoal' &&
            WIPED.test(p.description) &&
            (p.subType === 'Success' || GOAL_LINE_TOUCHDOWN.test(p.description))
        ) {
            summary.fieldGoalsNullified += 1
            plays.push({ ...p, subType: 'Penalty', isScoring: false })
        } else if (
            p.type === 'FieldGoal' &&
            p.subType === 'Failed' &&
            /\bSINGLE\b/.test(p.description) &&
            !WIPED.test(p.description)
        ) {
            summary.missedFieldGoalSingles += 1
            plays.push({ ...p, subType: 'Single', isScoring: true })
        } else {
            plays.push(p)
        }
    }

    // Play numbers are left as the feed gave them. A ghost run removed from a
    // drive can leave a gap in its numbering, which nothing downstream reads.
    return { plays, dropped: [...dropped], summary }
}
