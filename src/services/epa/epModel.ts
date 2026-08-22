// The expected-points surface and the EPA of a play. PURE — no database.
//
// EP is the average number of points the NEXT score is worth to the team holding
// the ball, given the game state. EPA is what one play did to that number.
//
// v1 IS A MEAN OVER BINS, NOT A LEARNED MODEL. That is a deliberate choice, not
// a placeholder apology: with roughly 14k plays a season the honest thing is a
// surface whose every cell can be read off and checked, carrying the sample it
// was built from. Its weaknesses are then measurable, which is the prerequisite
// for justifying anything heavier.

import type { RuleEra } from '~/lib/season.server'

/**
 * Which fitted era serves which era of play.
 *
 * 2026 did NOT change the field, so the 2023/24 surface remains a usable
 * structural prior for the current season — the geometry a state is worth is
 * identical. What 2026 changed is the label distribution, by narrowing the
 * rouge, so the prior is slightly generous about ones and should be refitted on
 * 2026 drives once a season of them exists.
 *
 * 2027 MAPS TO NOTHING. The field goes 110 -> 100 yards, the end zones 20 -> 15,
 * and the goalposts move to the back of the end zone, adding about 15 yards to
 * every field goal attempt. The yard-line axis is a different axis, and
 * field-position value is not linear, so there is no rescaling that rescues the
 * old surface. It must be refitted from 2027 plays, and until those exist the
 * correct answer is no EPA at all rather than a plausible wrong one.
 */
export const EP_SOURCE_ERA: Record<RuleEra, RuleEra | null> = {
    PRE_2026: 'PRE_2026',
    E2026: 'PRE_2026',
    E2027: null,
}

/**
 * Smallest sample a cell may be read from directly.
 *
 * Below this the lookup pools into a coarser bin instead. A mean of nine plays
 * is not an expected-points estimate, and the places it happens — third and long
 * inside your own ten — are exactly where a wrong number is most expensive.
 */
export const MIN_SAMPLE = 50

export const DISTANCE_BUCKETS = ['1-3', '4-6', '7-10', '11+'] as const
export type DistanceBucket = (typeof DISTANCE_BUCKETS)[number]

/** Yards to go, bucketed. The raw value is far too sparse to average on. */
export function distanceBucket(distance: number): DistanceBucket {
    if (distance <= 3) return '1-3'
    if (distance <= 6) return '4-6'
    if (distance <= 10) return '7-10'
    return '11+'
}

/**
 * Field position in 10-yard bands from the possessing team's own goal line.
 *
 * Bucket 0 is backed up against your own end zone; bucket 10 is on the
 * opponent's goal line. Clamped at both ends so a yard line outside the field —
 * which the feed does produce, on returns logged past the goal line — lands in a
 * real bucket instead of creating a phantom one.
 */
export function yardLineBucket(yardsFromOwnGoal: number, fieldLength = 110): number {
    const bands = Math.ceil(fieldLength / 10)
    return Math.max(0, Math.min(bands - 1, Math.floor(yardsFromOwnGoal / 10)))
}

/** One binned state, with the label the drive it belonged to eventually produced. */
export type TrainingRow = {
    down: number
    distance: number
    yardsFromOwnGoal: number
    nextPointOutcome: number
}

export type EpCell = {
    down: number
    distanceBucket: string
    yardLineBucket: number
    expectedPoints: number
    sampleSize: number
}

const cellKey = (down: number, distance: string, yardLine: number): string =>
    `${down}|${distance}|${yardLine}`

/**
 * Fit the surface: the mean label in every occupied bin.
 *
 * Cells below MIN_SAMPLE are still emitted. They are kept because they are real
 * observations that pooling should be able to use, and because a cell that is
 * thin is worth being able to SEE — dropping it would hide where the corpus is
 * empty. The lookup, not the fit, decides what is too thin to read directly.
 */
export function fitCells(rows: TrainingRow[], fieldLength = 110): EpCell[] {
    const totals = new Map<
        string,
        { sum: number; n: number; cell: Omit<EpCell, 'expectedPoints' | 'sampleSize'> }
    >()

    for (const row of rows) {
        const distance = distanceBucket(row.distance)
        const yardLine = yardLineBucket(row.yardsFromOwnGoal, fieldLength)
        const key = cellKey(row.down, distance, yardLine)
        const entry = totals.get(key) ?? {
            sum: 0,
            n: 0,
            cell: { down: row.down, distanceBucket: distance, yardLineBucket: yardLine },
        }
        entry.sum += row.nextPointOutcome
        entry.n += 1
        totals.set(key, entry)
    }

    return [...totals.values()]
        .map(({ sum, n, cell }) => ({ ...cell, expectedPoints: sum / n, sampleSize: n }))
        .sort(
            (a, b) =>
                a.down - b.down ||
                a.yardLineBucket - b.yardLineBucket ||
                a.distanceBucket.localeCompare(b.distanceBucket),
        )
}

export type EpLookup = (down: number, distance: number, yardsFromOwnGoal: number) => number | null

const pool = (cells: EpCell[]): { ep: number; n: number } => {
    let sum = 0
    let n = 0
    for (const c of cells) {
        sum += c.expectedPoints * c.sampleSize
        n += c.sampleSize
    }
    return { ep: n === 0 ? 0 : sum / n, n }
}

/**
 * A lookup over a fitted surface, with a fallback chain for thin cells.
 *
 * Exact cell -> pooled across distance at the same down and field position ->
 * pooled across downs at the same field position -> null. Pooling is weighted by
 * sample, so a coarser bin is the mean of the plays underneath it rather than a
 * mean of means.
 *
 * Returning NULL rather than a league-average guess is the important part. A
 * state the corpus has nothing to say about should produce no EPA, not a number
 * that looks like every other number.
 */
export function buildEpLookup(
    cells: EpCell[],
    minSample = MIN_SAMPLE,
    fieldLength = 110,
): EpLookup {
    const exact = new Map<string, EpCell>()
    const byDownAndYard = new Map<string, EpCell[]>()
    const byYard = new Map<number, EpCell[]>()

    for (const cell of cells) {
        exact.set(cellKey(cell.down, cell.distanceBucket, cell.yardLineBucket), cell)

        const dy = `${cell.down}|${cell.yardLineBucket}`
        byDownAndYard.set(dy, [...(byDownAndYard.get(dy) ?? []), cell])
        byYard.set(cell.yardLineBucket, [...(byYard.get(cell.yardLineBucket) ?? []), cell])
    }

    return (down, distance, yardsFromOwnGoal) => {
        const yardLine = yardLineBucket(yardsFromOwnGoal, fieldLength)
        const distanceKey = distanceBucket(distance)

        const cell = exact.get(cellKey(down, distanceKey, yardLine))
        if (cell && cell.sampleSize >= minSample) return cell.expectedPoints

        const acrossDistance = pool(byDownAndYard.get(`${down}|${yardLine}`) ?? [])
        if (acrossDistance.n >= minSample) return acrossDistance.ep

        const acrossDowns = pool(byYard.get(yardLine) ?? [])
        if (acrossDowns.n >= minSample) return acrossDowns.ep

        return null
    }
}

// ---------------------------------------------------------------------------
// EPA
// ---------------------------------------------------------------------------

/** Everything the EPA calculation reads from one play, in game order. */
export type EpaPlay = {
    /** The team holding the ball — the drive's team, not necessarily the play's. */
    driveTeamId: string
    /** Whose row this is. Differs on a defensive score. */
    playTeamId: string
    half: string
    down: number | null
    distance: number | null
    yardsFromOwnGoal: number | null
    /** Signed for playTeamId. Negative on a return touchdown. */
    points: number | null
    isNoPlay: boolean
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000

/**
 * EPA for every play of a game, in chronological order.
 *
 * EPA is the change in expected points the play caused, always from the point of
 * view of the team that had the ball when it started:
 *
 *   scoring play      points actually scored  -  EP(state before)
 *   ordinary play     EP(state after)         -  EP(state before)
 *
 * where "state after" is the next play that HAS a state, negated when possession
 * has changed hands. Three rules carry most of the correctness:
 *
 *  - THE SEARCH STOPS AT THE HALF. A punt with forty seconds left is not
 *    punished by what happens after the break.
 *  - A SCORE IS TAKEN AT ITS ACTUAL VALUE, not at the expected value of the
 *    state that followed it. This is what makes a touchdown worth what a
 *    touchdown is worth.
 *  - POINTS ARE RESIGNED TO THE POSSESSING TEAM. A pick-six is a large negative
 *    for the offence, not a positive for whoever's row it sits on.
 *
 * Plays with no state get NULL, not zero: converts and kickoffs have no down and
 * no line of scrimmage, and a penalty that wiped the snap ("NO PLAY") did not
 * happen. Null is also what a state the surface cannot price returns, so an EPA
 * of null always means "not measured" and never "measured as neutral".
 */
export function epaForPlays(plays: EpaPlay[], ep: EpLookup): (number | null)[] {
    const epOf = (p: EpaPlay): number | null => {
        if (p.isNoPlay || p.down === null || p.distance === null || p.yardsFromOwnGoal === null) {
            return null
        }
        return ep(p.down, p.distance, p.yardsFromOwnGoal)
    }

    return plays.map((play, i) => {
        const before = epOf(play)
        if (before === null) return null

        if (play.points !== null && play.points !== 0) {
            const scored = play.playTeamId === play.driveTeamId ? play.points : -play.points
            return round3(scored - before)
        }

        for (let j = i + 1; j < plays.length; j++) {
            const next = plays[j]
            if (next.half !== play.half) return null
            const after = epOf(next)
            if (after === null) continue
            const signed = next.driveTeamId === play.driveTeamId ? after : -after
            return round3(signed - before)
        }
        return null
    })
}
