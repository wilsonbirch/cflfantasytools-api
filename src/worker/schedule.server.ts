export type ScheduleRule = {
    kind: string
    // Recurring interval: due when the last enqueue is at least this old.
    everyMs?: number
    // Daily anchor: due during the UTC hour, guarded by minGapMs so yesterday's
    // late run doesn't suppress today's early one (or double-fire within a day).
    atUtcHour?: number
    minGapMs?: number
}

const HOUR_MS = 60 * 60 * 1000

// The Job table itself is the last-run record (jobLastCreatedAt) — no state
// table, no cron daemon. The worker checks these once per boot, so a rule fires
// on the first boot at-or-after its moment, not at the exact minute.
//
// 3DF had a node-schedule rule that no code ever called, so depth-chart checks
// only ever ran when an admin clicked a button. Rules land here as their
// handlers ship.
export const SCHEDULES: ScheduleRule[] = [
    // Hourly. Most runs cost one conditional GET per feed and write nothing,
    // because an unchanged payload short-circuits on its sha256. The reason to
    // run this often is that player salaries and projections are PERISHABLE —
    // the feed exposes only the current value, so an unrecorded week's price
    // movement is gone permanently. 3DF lost the entire 2025 season this way.
    { kind: 'gamezone-sync', everyMs: HOUR_MS },
]

const isDue = (rule: ScheduleRule, now: Date, lastCreated: Date | null): boolean => {
    if (!lastCreated) return true
    const age = now.getTime() - lastCreated.getTime()
    if (rule.everyMs !== undefined) return age >= rule.everyMs
    if (rule.atUtcHour !== undefined) {
        return now.getUTCHours() === rule.atUtcHour && age >= (rule.minGapMs ?? 20 * HOUR_MS)
    }
    return false
}

export const dueScheduledKinds = (
    now: Date,
    lastCreated: Record<string, Date | null>,
    schedules: ScheduleRule[] = SCHEDULES,
): string[] =>
    schedules.filter((rule) => isDue(rule, now, lastCreated[rule.kind] ?? null)).map((r) => r.kind)
