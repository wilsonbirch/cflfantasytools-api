// Play-description parsing. PURE — no database, no network, no clock.
//
// The BetGenius widget hands us a prose description per play. It is highly
// regular, and it carries considerably more than 3DF ever extracted: the target
// zone the whole receiving model is built on, the catch point (so air yards and
// yards-after-catch are recoverable), the formation, and penalty detail.
//
// Grammar, from 5,912 real 2026 plays across 40 fixtures:
//
//   Shotgun #10 B.Schager pass complete short left to #75 P.Boersch
//     caught at CGY38, for 13 yards to the CGY20 (#24 O.Ruest), 1ST DOWN
//   Shotgun #20 D.McMahon rush middle for 12 yards gain to the CGY39 (#28 M.Straker)
//   Shotgun #11 J.Criswell sacked for loss of 1 yard to the CGY39 (#97 K.Charles)
//   #70 D.Hodge punt 42 yards to the SSK34 #87 D.Wiebe return 6 yards to the SSK40 (...)
//   #11 A.Hale field goal attempt from 56 yards NO GOOD (H: #71 O.Chapman, LS: #53 R.Hughes)
//   PENALTY CGY Procedure, General (#68 D.Buford) 5 yards from CGY32 to CGY27. NO PLAY
//
// Where 3DF's regexes were wrong they are NOT reproduced here:
//   - its tackler pattern `\(#\d+ [A-Z][a-z]+\.[A-Z][a-z]+\)` never matched a
//     real tackler, because names are `O.Ruest`, not `Ol.Ruest`
//   - its name patterns dropped `V.Adams Jr.` and `A.Miller-Melancon`
//   - it stored kick returners in `receiver`, inflating reception counts

/** `#10 B.Schager`, `#3 V.Adams Jr.`, `#39 A.Miller-Melancon`, `#00 Q.Conley`. */
const PLAYER = String.raw`#\d{1,3}\s[A-Z][a-z]?\.[A-Za-z'’-]+(?:\s(?:Jr\.|Sr\.|III|II|IV|I)(?![A-Za-z]))?`

/** A yard-line token as it appears INSIDE a description: `CGY38`, `SSK-01`. */
const SPOT = String.raw`([A-Z]{2,4})(-?\d{1,3})`

const player = (flags = '') => new RegExp(PLAYER, flags)

export type PassDepth = 'SHORT' | 'DEEP'
export type PassDirection = 'LEFT' | 'MIDDLE' | 'RIGHT'

export type TargetZone = {
    depth: PassDepth
    direction: PassDirection
}

export type ParsedPenalty = {
    team: string | null
    name: string | null
    yards: number | null
    isNoPlay: boolean
}

export type ParsedDescription = {
    formation: string | null
    passer: string | null
    rusher: string | null
    receiver: string | null
    returner: string | null
    kicker: string | null
    defense: string | null
    brokenUpBy: string | null
    targetDepth: PassDepth | null
    targetDirection: PassDirection | null
    yardsGained: number | null
    airYards: number | null
    yardsAfterCatch: number | null
    puntYards: number | null
    returnYards: number | null
    kickDistance: number | null
    kickIsGood: boolean | null
    isComplete: boolean | null
    isFirstDown: boolean
    isTurnover: boolean
    /** Who fumbled, kept only when their team LOST the ball. Play-text name. */
    fumbleLostBy: string | null
    isNoPlay: boolean
    penaltyTeam: string | null
    penaltyName: string | null
    penaltyYards: number | null
    points: number | null
}

// ---------------------------------------------------------------------------
// Field position
// ---------------------------------------------------------------------------

export type ParsedStartPosition = {
    down: number | null
    distance: string | null
    yardLine: number | null
}

const DOWN_DISTANCE = /^(\d)(?:st|nd|rd|th)\s*&\s*(\d+)/
const AT_SPOT = /\bat\s+([A-Z]{2,4})\s+(\d{1,3})\s*$/

/**
 * Parse `3rd & 10 at CGY 33`.
 *
 * `yardLine` is SIGNED, carrying 3DF's convention forward: negative means the
 * yard line belongs to the team with the ball (its own half), positive means
 * the opponent's. That single number is what an expected-points model needs —
 * "CGY 33" is worth completely different things to Calgary and to its opponent.
 *
 * Kickoffs and converts arrive with an empty string, which is not an error:
 * they have no down and no line of scrimmage.
 */
export function parseStartPosition(
    startPosition: string,
    possessingTeamAbbr: string | null,
): ParsedStartPosition {
    const empty: ParsedStartPosition = { down: null, distance: null, yardLine: null }
    if (!startPosition) return empty

    const dd = startPosition.match(DOWN_DISTANCE)
    const spot = startPosition.match(AT_SPOT)

    let yardLine: number | null = null
    if (spot) {
        const [, abbr, yards] = spot
        const n = Number(yards)
        // Unknown possessing team: record the magnitude rather than guess a sign.
        yardLine = possessingTeamAbbr === null ? n : abbr === possessingTeamAbbr ? -n : n
    }

    return {
        down: dd ? Number(dd[1]) : null,
        distance: dd ? dd[2] : null,
        yardLine,
    }
}

/**
 * Absolute distance from the possessing team's own goal line, 0-110.
 *
 * The signed yard line is ambiguous for modelling because -33 and +33 are 44
 * yards apart on a 110-yard field. This flattens it onto one axis so binning
 * works. Era-dependent: the field is 110 yards until 2027, then 100.
 */
export function yardsFromOwnGoal(yardLine: number | null, fieldLength = 110): number | null {
    if (yardLine === null) return null
    return yardLine < 0 ? -yardLine : fieldLength - yardLine
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

const FORMATION = /^(No Huddle-Shotgun|No Huddle|Shotgun)\s/
// Direction is OPTIONAL: a small number of plays are logged as "pass complete
// short to ..." with the depth but no direction. Requiring it dropped both the
// zone and the receiver on those plays.
const ZONE = /pass (?:complete|incomplete)\s+(short|deep)(?:\s+(left|middle|right))?/i
const TARGET = new RegExp(
    String.raw`(?:short|deep)(?:\s+(?:left|middle|right))?\s+to\s+(${PLAYER})`,
)
const CAUGHT_AT = new RegExp(String.raw`caught at ${SPOT}`)
const THROWN_TO = new RegExp(String.raw`thrown to ${SPOT}`)

// `for 13 yards to the`, `for 12 yards gain`, `for 1 yard loss`, `for 0 yards to`.
const YARDS = /for (\d+) yards?(?:\s+(gain|loss))?/
// `sacked for loss of 1 yard`, `return for loss of 5 yards`.
const LOSS_OF = /for loss of (\d+) yards?/

const TACKLER = new RegExp(String.raw`\((${PLAYER})\)`)
const BROKEN_UP = new RegExp(String.raw`broken up by\s+(${PLAYER})`)
const INTERCEPTED = new RegExp(String.raw`intercepted by\s+(${PLAYER})`)
const RETURNER = new RegExp(String.raw`(${PLAYER})\s+return\b`)
const RETURN_YARDS = /return (\d+) yards?/
const RECOVERED_BY = new RegExp(String.raw`recovered by [A-Z]{2,4}\s+(${PLAYER})`)

// "fumbled by #45 A.Ouellette", "fumble by #7 C.Fajardo" (sacks), "muffed by
// #13 L.Whitehead" (punts), "#51 S.McEwen fumbled snap".
const FUMBLED_BY = new RegExp(String.raw`(?:fumbled?|muffed) by\s+(${PLAYER})`)
const FUMBLED_SNAP = new RegExp(String.raw`(${PLAYER}) fumbled snap`)
// The recovering TEAM. Global: a ball fumbled twice is recovered twice, and the
// last recovery is the one that decides possession.
const RECOVERY_TEAM = /recovered by ([A-Z]{2,4})\s*#/g

const PUNT_YARDS = /punt (\d+) yards?/
const KICKOFF_YARDS = /kickoff (\d+) yards?/
const FG_FROM = /field goal attempt from (\d+) yards?/

const PENALTY = /PENALTY\s+([A-Z]{2,4})\s+([^(]+?)\s*(?:\((?:#\d)|(\d+) yards? from|$)/
// Anchored on "from <spot>" rather than scanning forward from PENALTY: the
// offending player's name contains a period, so any dot-excluding scan stops
// dead at "D.Buford" and never reaches the yardage.
const PENALTY_YARDS = /(\d+) yards? from [A-Z]{2,4}-?\d+/

const first = (s: string, re: RegExp): string | null => {
    const m = s.match(re)
    return m ? (m[1] ?? m[0]).trim() : null
}

/**
 * Numeric capture, or null when the pattern does not match at all.
 *
 * Deliberately not `Number(x) || null`: a BLOCKED punt is "punt 0 yards", and a
 * truthy test would turn that real zero into "no data".
 */
const num = (s: string, re: RegExp): number | null => {
    const m = s.match(re)
    if (!m) return null
    const n = Number(m[1])
    return Number.isNaN(n) ? null : n
}

/** Signed yardage from either phrasing, or null when the description has none. */
function parseYards(description: string): number | null {
    const loss = description.match(LOSS_OF)
    if (loss) return -Number(loss[1])
    const m = description.match(YARDS)
    if (!m) return null
    const n = Number(m[1])
    return m[2] === 'loss' ? -n : n
}

/**
 * A touchdown, read from the text: the ball REACHING A GOAL LINE ("return 84
 * yards to the TOR00 TOUCHDOWN"), not the mere presence of the word. That
 * distinction matters: descriptions also say TOUCHDOWN when one was called
 * back, and matching the word alone would invent scores that never counted.
 *
 * The captured token is WHOSE goal line — the feed is not consistent about the
 * abbreviation ("SSK00", "SASK00", "Ottawa00" all occur), so it is matched
 * against the club's abbreviation or the start of its name.
 */
const GOAL_LINE_TOUCHDOWN = /to the ([A-Za-z]{2,})00 TOUCHDOWN/

/** Enough of a club to recognise its own goal line in play text. */
export type TeamIdentity = { abbreviation: string; name: string }

const isOwnGoalLine = (token: string, own: TeamIdentity): boolean => {
    const t = token.toUpperCase()
    return t === own.abbreviation.toUpperCase() || own.name.toUpperCase().startsWith(t)
}

/**
 * Points scored ON THIS PLAY, signed positive for the play's own team.
 *
 * 3DF's table was wrong in a way that silently corrupted every drive total: it
 * scored `OnePoint/Success` as 7 and `TwoPoints/Success` as 8, treating the
 * convert as if it carried the touchdown with it. But the convert is a SEPARATE
 * play in this feed, so a touchdown drive summed to 6 + 7 = 13.
 *
 * Here each play is worth only what it scored itself, so a drive total is a
 * plain sum. `Single` is the rouge — the play class the 2026 rule change cut
 * down, and the reason a model must never pool eras.
 *
 * WHO SCORED A TOUCHDOWN IS READ FROM WHOSE GOAL LINE THE BALL REACHED, not
 * from the row's team id. The feed is inconsistent there: a pick-six is stamped
 * sometimes with the team that threw it and sometimes with the team that ran it
 * back (37 vs 6 in the 2023/24 corpus), and a 2026 game (MTL–OTT, 13419716)
 * came out 34–22 instead of 46–16 on the row ids alone. A touchdown at the play
 * team's OWN goal line was scored by the opponent: -6. Without a team to compare
 * against, a `Touchdown` row is taken at face value and a return touchdown
 * (punt, kickoff, missed field goal, strip-sack — `subType` null) as -6, since
 * those are always scored by the side without the ball.
 *
 * A touchdown under a flag (`subType` Penalty) counted unless the text says it
 * was "nullified" or the snap was "NO PLAY" — roughness after the score is
 * enforced on the kickoff and the six stand. Checked against the scoreboard
 * finals of the 2023/24 corpus: each of these two rules on its own moves more
 * games onto the official score, and both together move the most.
 */
export function pointsForPlay(
    type: string,
    subType: string | null,
    description = '',
    ownTeam?: TeamIdentity,
): number | null {
    const goalLine = description.match(GOAL_LINE_TOUCHDOWN)
    const own = goalLine !== null && ownTeam !== undefined && isOwnGoalLine(goalLine[1], ownTeam)
    const six = own ? -6 : 6

    if (subType === 'Touchdown') return six
    if (subType === 'Single') return 1
    if (subType === 'Success') {
        if (type === 'FieldGoal') return 3
        if (type === 'OnePoint') return 1
        if (type === 'TwoPoints') return 2
        return null
    }
    if (goalLine === null) return null
    if (subType === 'Penalty') return /nullified|NO PLAY/.test(description) ? null : six
    return ownTeam === undefined ? -6 : six
}

/** Detached so the penalty branch stays readable; `NO PLAY` wipes the snap. */
function parsePenalty(description: string): ParsedPenalty {
    if (!description.includes('PENALTY')) {
        return { team: null, name: null, yards: null, isNoPlay: false }
    }
    const m = description.match(PENALTY)
    const yards = description.match(PENALTY_YARDS)
    return {
        team: m ? m[1] : null,
        // Trailing punctuation varies: "Offside declined", "Procedure, General".
        name: m ? m[2].replace(/[.,]\s*$/, '').trim() || null : null,
        yards: yards ? Number(yards[1]) : null,
        isNoPlay: /NO PLAY/i.test(description),
    }
}

/**
 * Everything the description carries, for one play.
 *
 * `type`/`subType` come from the feed's own fields rather than being inferred
 * from prose, so this only has to read what the feed does not already model.
 */
export function parseDescription(
    description: string,
    type: string,
    subType: string | null,
    fieldLength = 110,
    ownTeam?: TeamIdentity,
): ParsedDescription {
    const isPass = type === 'Pass'
    const isKick = type === 'Punt' || type === 'Kickoff' || type === 'FieldGoal'
    const penalty = parsePenalty(description)

    const zone = description.match(ZONE)
    const intercepted = first(description, INTERCEPTED)

    // The first player token is the ball carrier for every play type that has
    // one. On a penalty-only play there is no carrier — the only token is the
    // offending player, which must not become a passer.
    const leadPlayer = type === 'Penalty' ? null : first(description, player())

    const caught = description.match(CAUGHT_AT)
    const yardsGained = parseYards(description)

    // Air yards need the catch point relative to the line of scrimmage, which
    // this function does not have. What IS available is the completion's total
    // and the spot: for a completion, gained = air + YAC, and the catch spot
    // versus the end spot gives YAC directly.
    let airYards: number | null = null
    let yardsAfterCatch: number | null = null
    if (subType === 'CompletePass' && caught && yardsGained !== null) {
        const endSpot = description.match(/to the ([A-Z]{2,4})(-?\d{1,3})/)
        if (endSpot) {
            // Both spots onto ONE axis before subtracting. A completion very
            // often crosses midfield ("caught at SSK55 ... to the CGY45"), and
            // comparing the raw numbers there is meaningless — 55 and 45 are ten
            // yards apart only once both are measured from the same goal line.
            const from = Number(caught[2])
            const to =
                endSpot[1] === caught[1] ? Number(endSpot[2]) : fieldLength - Number(endSpot[2])
            yardsAfterCatch = Math.abs(to - from)
            // Air yards fall out of the identity gained = air + YAC. Negative is
            // legitimate and expected: a screen is caught behind the line.
            airYards = yardsGained - yardsAfterCatch
        }
    }

    const rawReturner = first(description, RETURNER) ?? first(description, RECOVERED_BY)
    const returner = isKick || subType === 'Interception' ? rawReturner : null

    // Fumbles. The fumbler is charged only when their TEAM lost the ball, and
    // the last recovery in the text is the one that decides possession. The
    // fumbler is on the play's own team — except a returner (kick plays,
    // interceptions), who is on the other side, so which recovery loses the
    // ball flips. Without a team identity the loser is undecidable, and the
    // old subtype rule is kept for isTurnover rather than guessing.
    const fumbler = first(description, FUMBLED_SNAP) ?? first(description, FUMBLED_BY)
    let fumbleLostBy: string | null = null
    let fumbleTurnover = type === 'Fumble' && /recovered by/.test(description)
    if (fumbler && ownTeam) {
        const recoveries = [...description.matchAll(RECOVERY_TEAM)]
        const lastTeam = recoveries[recoveries.length - 1]?.[1]
        if (lastTeam === undefined) {
            // No recovery in the text (out of bounds): the ball stays.
            fumbleTurnover = false
        } else {
            const ownRecovered = isOwnGoalLine(lastTeam, ownTeam)
            const fumblerIsReturner = fumbler === returner
            const lost = fumblerIsReturner ? ownRecovered : !ownRecovered
            if (lost) fumbleLostBy = fumbler
            // A returner losing the ball is a takeaway FOR the play's team,
            // not a turnover against it.
            fumbleTurnover = lost && !fumblerIsReturner
        }
    }

    return {
        formation: first(description, FORMATION),
        passer: isPass || type === 'Sack' ? leadPlayer : null,
        rusher: type === 'Run' || type === 'Kneel' ? leadPlayer : null,
        receiver: isPass ? first(description, TARGET) : null,
        returner,
        kicker: isKick ? leadPlayer : null,
        // On an interception the defensive "tackler" in parentheses is whoever
        // stopped the RETURN, so the interceptor is the meaningful defender.
        defense: intercepted ?? first(description, TACKLER),
        brokenUpBy: first(description, BROKEN_UP),
        targetDepth: zone ? (zone[1].toUpperCase() as PassDepth) : null,
        targetDirection: zone?.[2] ? (zone[2].toUpperCase() as PassDirection) : null,
        // An incomplete pass gains nothing; the yardage in its text is the spot
        // the ball was thrown to, not a gain.
        yardsGained: subType === 'IncompletePass' ? 0 : yardsGained,
        airYards,
        yardsAfterCatch,
        puntYards: type === 'Punt' ? num(description, PUNT_YARDS) : null,
        returnYards: num(description, RETURN_YARDS),
        kickDistance:
            type === 'FieldGoal'
                ? num(description, FG_FROM)
                : type === 'Kickoff'
                  ? num(description, KICKOFF_YARDS)
                  : type === 'Punt'
                    ? num(description, PUNT_YARDS)
                    : null,
        kickIsGood:
            type === 'FieldGoal' || type === 'OnePoint'
                ? /\bGOOD\b/.test(description) && !/NO GOOD/.test(description)
                : null,
        // Read from the TEXT, not from subType.
        //
        // A caught touchdown is subType "Touchdown", and a completion on a play
        // that also drew a flag is subType "Penalty" — neither is
        // "CompletePass". Counting receptions off the subtype alone drops 222 of
        // 1,858 completions in a 40-game sample (12%), every touchdown catch
        // among them, which would quietly understate exactly the players the
        // fantasy surface is about.
        isComplete: isPass ? /pass complete/.test(description) : null,
        isFirstDown: /1ST DOWN/.test(description),
        isTurnover:
            subType === 'Interception' || /TURNOVER ON DOWNS/i.test(description) || fumbleTurnover,
        fumbleLostBy,
        isNoPlay: penalty.isNoPlay,
        penaltyTeam: penalty.team,
        penaltyName: penalty.name,
        penaltyYards: penalty.yards,
        points: pointsForPlay(type, subType, description, ownTeam),
    }
}

/** `thrown to` / `caught at` spot, for callers that want the raw catch point. */
export function parseCatchPoint(description: string): { team: string; yard: number } | null {
    const m = description.match(CAUGHT_AT) ?? description.match(THROWN_TO)
    return m ? { team: m[1], yard: Number(m[2]) } : null
}
