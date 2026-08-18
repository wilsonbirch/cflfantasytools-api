// Season/week derivation for stamping a newly posted chart.
//
// Ported from 3DF's getDepthChartInfo. The boundaries are hardcoded dates, which
// is wrong in principle — the schedule moves year to year, and the 2026 season
// opened on June 4 rather than June 5. It is kept as-is here to avoid changing
// behaviour during the port; the correct fix is to derive both from the Gameweek
// rows the Game Zone feed already gives us, which is a follow-up.
const REGULAR_SEASON_START = { month: 5, day: 5 } // June 5, zero-indexed month
const POST_SEASON_START = { month: 9, day: 31 } // October 31

export type DepthChartInfo = {
    season: 'pre' | 'regular' | 'post'
    week: number
}

const at = (year: number, m: { month: number; day: number }): Date =>
    new Date(Date.UTC(year, m.month, m.day))

/** The first Sunday on or after a date — weeks are counted from there. */
function firstSundayOnOrAfter(d: Date): Date {
    const out = new Date(d)
    out.setUTCDate(out.getUTCDate() + ((7 - out.getUTCDay()) % 7))
    return out
}

export function getDepthChartInfo(now: Date): DepthChartInfo {
    const year = now.getUTCFullYear()
    const regularStart = at(year, REGULAR_SEASON_START)
    const postStart = at(year, POST_SEASON_START)

    const boundary = now < regularStart ? null : now > postStart ? postStart : regularStart
    const season: DepthChartInfo['season'] =
        now < regularStart ? 'pre' : now > postStart ? 'post' : 'regular'

    if (boundary === null) return { season, week: 1 }

    const from = firstSundayOnOrAfter(boundary)
    const elapsedMs = now.getTime() - from.getTime()
    const week = elapsedMs < 0 ? 1 : Math.floor(elapsedMs / (7 * 24 * 60 * 60 * 1000)) + 1
    return { season, week }
}
