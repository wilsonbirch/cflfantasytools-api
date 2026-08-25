// CFL Game Zone fantasy scoring. PURE — the one place the rules live.
//
// Source: the published rules table in the CFL Fantasy app
// (https://fantasy.cfl.ca — the "League rules" page; gamezone.cfl.ca/fantasy/help
// redirects there as of 2026-08-23): passing 25 yds/pt, passing TD 4, rushing
// and receiving 10 yds/pt, TD 6, 2-pt convert 2, return TD 6.
//
// Two values were VERIFIED AGAINST THE FEED rather than taken from that page,
// because the weekly salary-cap game scores them differently from the league
// product: receptions are worth 1 (the page says 0.5) and interceptions -2
// (the page says -1). Reconstructing 2026 season totals from players.json's
// own stat lines with the numbers below matches Game Zone's `points` exactly
// for 139 of 166 players and 643 of 771 player-gameweeks from play-by-play;
// the remainder are quarterbacks a few points high (an unmodelled negative
// term, most likely fumbles lost) and returners (return yards). Re-verify
// each season the same way — the feed is the authority, not this file.
//
// The official "How to Play" rules (provided by Wilson 2026-08-24, archived in
// docs/cfl-fantasy-rules.md in the parent repo) confirm fumbles lost at -2,
// receptions at 1 and interceptions at -2, and price return yards at 1 per 20
// — the return-yards term is still unmodelled here because return yardage is
// not tracked per player.

export type ScoringLine = {
    passingYards: number
    passingTouchdowns: number
    interceptions: number
    rushingYards: number
    rushingTouchdowns: number
    receptions: number
    receivingYards: number
    receivingTouchdowns: number
    fumblesLost?: number
    twoPointConversions?: number
    returnTouchdowns?: number
}

export const SCORING = {
    passingYardsPerPoint: 25,
    passingTouchdown: 4,
    interception: -2,
    rushingYardsPerPoint: 10,
    rushingTouchdown: 6,
    reception: 1,
    receivingYardsPerPoint: 10,
    receivingTouchdown: 6,
    fumbleLost: -2,
    twoPointConversion: 2,
    returnTouchdown: 6,
} as const

/** Fantasy points for a stat line, rounded to a tenth as the feed reports them. */
export function fantasyPoints(s: ScoringLine): number {
    const pts =
        s.passingYards / SCORING.passingYardsPerPoint +
        s.passingTouchdowns * SCORING.passingTouchdown +
        s.interceptions * SCORING.interception +
        s.rushingYards / SCORING.rushingYardsPerPoint +
        s.rushingTouchdowns * SCORING.rushingTouchdown +
        s.receptions * SCORING.reception +
        s.receivingYards / SCORING.receivingYardsPerPoint +
        s.receivingTouchdowns * SCORING.receivingTouchdown +
        (s.fumblesLost ?? 0) * SCORING.fumbleLost +
        (s.twoPointConversions ?? 0) * SCORING.twoPointConversion +
        (s.returnTouchdowns ?? 0) * SCORING.returnTouchdown
    return Math.round(pts * 10) / 10
}
