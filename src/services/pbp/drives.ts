// Drive assembly and the expected-points training label. PURE — no database.
//
// Split from parsePlays.server.ts on purpose: this is the logic most worth
// testing exhaustively and least worth booting Postgres for.

import { parseDescription } from './parseDescription'

export type RawPlay = {
    id: string
    teamId: string
    type: string
    subType: string | null
    description: string
    clock: string
    timestamp: number
    phase: string
    phaseQualifier: string
    isScoring: boolean
    playStartPosition: string
}

/** A half is the unit a scoring search may not cross. Overtime is its own. */
export const halfKey = (phase: string, quarter: string): string => {
    if (phase === 'Overtime') return 'OT'
    return Number(quarter) <= 2 ? 'H1' : 'H2'
}

/**
 * Plays oldest-first.
 *
 * THE FEED SERVES THEM NEWEST FIRST — verified on all 40 fixtures of the 2026
 * season, every one of them descending. 3DF's parser walked the array as given
 * and so built its drives, its "previous play" links and its next-score chain
 * backwards.
 */
export function chronological(plays: RawPlay[]): RawPlay[] {
    const key = (p: RawPlay): [number, number] => {
        const [drive, number] = p.id.split('-').map(Number)
        return [drive, number]
    }
    return [...plays].sort((a, b) => {
        const [ad, an] = key(a)
        const [bd, bn] = key(b)
        return ad === bd ? an - bn : ad - bd
    })
}

export type GroupedDrive = {
    number: number
    geniusTeamId: string
    startQuarter: number
    half: string
    plays: RawPlay[]
}

/**
 * Group chronological plays into drives.
 *
 * A drive id is the first half of the play id (`"14-3"` is drive 14, play 3).
 * Every drive belongs to exactly one team — verified across the whole corpus —
 * so the first play's team is the drive's team.
 *
 * Kickoffs form their OWN single-play drives, owned by the kicking team. They
 * are kept rather than skipped as 3DF did, because a kickoff can score: a kick
 * through the end zone is a single, which is precisely the play class the 2026
 * rule change narrowed.
 */
export function groupIntoDrives(plays: RawPlay[]): GroupedDrive[] {
    const byNumber = new Map<number, GroupedDrive>()
    for (const play of plays) {
        const number = Number(play.id.split('-')[0])
        if (Number.isNaN(number)) continue
        let drive = byNumber.get(number)
        if (!drive) {
            drive = {
                number,
                geniusTeamId: play.teamId,
                startQuarter: Number(play.phaseQualifier) || 1,
                half: halfKey(play.phase, play.phaseQualifier),
                plays: [],
            }
            byNumber.set(number, drive)
        }
        drive.plays.push(play)
    }
    return [...byNumber.values()].sort((a, b) => a.number - b.number)
}

export type DriveOutcome = {
    points: number | null
    isScoring: boolean
}

/**
 * Points a drive scored, as the plain sum of what its own plays scored.
 *
 * This only sums correctly because a play is worth its own points and nothing
 * else — a touchdown 6, its convert 1 or 2, separately. See pointsForPlay.
 */
export function driveOutcome(drive: GroupedDrive): DriveOutcome {
    let total: number | null = null
    for (const play of drive.plays) {
        const { points } = parseDescription(play.description, play.type, play.subType)
        if (points !== null) total = (total ?? 0) + points
    }
    return { points: total, isScoring: total !== null && total !== 0 }
}

/**
 * The expected-points training label, per drive.
 *
 * `nextPointOutcome` is the points scored on the next scoring drive, signed from
 * THIS drive's point of view: positive if this drive's team scored them,
 * negative if the opponent did. That is the value an expected-points model
 * regresses (down, distance, yard line) onto.
 *
 * Two rules matter and both are easy to get wrong:
 *
 *  - The search STOPS AT THE HALF. A drive that ends in a punt late in the
 *    second quarter is not "rewarded" by a touchdown after the break, because
 *    the possession did not carry across it.
 *  - NULL IS NOT ZERO. Null means "no further score this half" — an unusable
 *    training row that must be dropped. Recording it as 0 would teach the model
 *    that a first-and-ten at midfield is worth nothing.
 *
 * A drive that scores is its own next scoring drive, which is why the scan
 * starts at `i` rather than `i + 1`.
 */
export function nextPointOutcomes(drives: GroupedDrive[]): (number | null)[] {
    const outcomes = drives.map(driveOutcome)
    return drives.map((drive, i) => {
        for (let j = i; j < drives.length; j++) {
            if (drives[j].half !== drive.half) return null
            const { points, isScoring } = outcomes[j]
            if (!isScoring || points === null) continue
            return drives[j].geniusTeamId === drive.geniusTeamId ? points : -points
        }
        return null
    })
}
