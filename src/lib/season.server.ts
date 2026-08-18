// The CFL season runs June to November. "Current year" for ingestion purposes is
// simply the calendar year — the off-season months still belong to the season
// just played, which is what we want to keep writing snapshots against.
export const currentSeasonYear = (now: Date = new Date()): number => now.getUTCFullYear()

/**
 * The rule era a season belongs to. See docs/memory/project-cfl-rule-eras.md.
 *
 * 2026 modified the rouge (a missed field goal wide and out of bounds, or a
 * punt/kickoff through the back or sides untouched, no longer scores a single).
 * 2027 shortens the field 110 -> 100 yards, end zones 20 -> 15, and moves the
 * goalposts to the back of the end zone.
 *
 * These matter because expected points is fitted on (down, distance, yard line)
 * against the next scoring outcome: 2026 changes the label distribution, and
 * 2027 changes the yard-line domain itself. Never pool eras in one fitted model.
 */
export type RuleEra = 'PRE_2026' | 'E2026' | 'E2027'

export function ruleEraForYear(year: number): RuleEra {
    if (year >= 2027) return 'E2027'
    if (year === 2026) return 'E2026'
    return 'PRE_2026'
}
