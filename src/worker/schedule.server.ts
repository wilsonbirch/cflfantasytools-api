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
    // Every six hours. Slower than the feed sync because it reads ~80 cfl.ca
    // game pages per run, and because a finished game's play-by-play does not
    // change. Frequent enough that a game is captured well within the window in
    // which the widget still serves it.
    { kind: 'pbp-capture', everyMs: 6 * HOUR_MS },
    // Offset from the capture it feeds on: a 7-hour period drifts against the
    // 6-hour capture rather than racing it every cycle. Cheap when there is
    // nothing new, because a game already parsed since its last capture is
    // skipped outright.
    { kind: 'pbp-parse', everyMs: 7 * HOUR_MS },
    // Clubs post charts on their own schedule through the week, so a 30-minute
    // sweep is the difference between a same-day alert and a next-day one.
    // Only the sweep is scheduled; it enqueues the per-club jobs itself.
    { kind: 'depth-chart-sweep', everyMs: HOUR_MS / 2 },
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
