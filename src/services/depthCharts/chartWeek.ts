// Which week a depth chart is FOR, read from what the club publishes.
//
// A chart used to be stamped with the week it was first SEEN. That is right
// for a chart caught within the half-hour, and wrong for every chart caught
// late: the November 2026 backfill (the club sites moved platform in
// September/October and the scrapers broke) stamped six weeks of charts as
// the week the fixed scraper found them.
//
// Every club prints the game a chart is for somewhere — a date in the link
// text (eight clubs), a YYMMDD prefix on the filename (Calgary, whose link
// text has none), and often a week number or the opponent as well. This
// module reads those signals and maps them onto the schedule. PURE: the
// schedule is passed in, so the same code runs in the sweep, the repair
// script and the tests.
//
// Precedence, strongest first:
//   1. fixture       the printed game date (±1 day, for club typos) matches one
//                    of the club's scheduled matches → that match's gameweek
//   2. gameweek      the printed date falls in a gameweek's date range; before
//                    the first is preseason, after the last counts on in
//                    7-day steps (semi-finals 22, finals 23, Grey Cup 24)
//   3. printed-week  "Week 14" / "WK16" / "W5" in the link text or filename
//   4. date-math     the printed date through getDepthChartInfo's hardcoded
//                    boundaries — only when the season has no gameweeks
//   (5. first-seen   not here: the caller's fallback when this returns null)
//
// A preseason marker ("Preseason", "PRE-SEASON", "PS Week 1") wins outright:
// season 'pre', week 1 — the value a chart caught live in May has always got.

import { getDepthChartInfo, type DepthChartInfo } from './season.server'

export type ChartSeason = DepthChartInfo['season']

export type ChartWeekSource = 'preseason' | 'fixture' | 'gameweek' | 'printed-week' | 'date-math'

export type ChartWeek = DepthChartInfo & {
    source: ChartWeekSource
    /** Human-readable: what was read and what it matched. */
    evidence: string
}

/** A gameweek with its 1-based ordinal (seasonGameweeks' `week`). */
export type ScheduleGameweek = {
    week: number
    startDate: Date | null
    endDate: Date | null
}

/** One scheduled match, by team abbreviation; `week` is its gameweek's ordinal. */
export type ScheduleMatch = {
    home: string | null
    away: string | null
    date: Date
    week: number
}

export type ChartSchedule = {
    gameweeks: ScheduleGameweek[]
    matches: ScheduleMatch[]
}

export type ChartInput = {
    /** The chart's own club. */
    team: string
    year: number
    title: string
    href: string
    /** articleList clubs: the article the PDF came from. */
    page?: string | null
}

export type ChartSignals = {
    date: { day: number; text: string; from: 'title' | 'filename' | 'page' } | null
    printedWeek: { week: number; text: string; from: 'title' | 'filename' } | null
    opponent: string | null
    stage: 'pre' | 'post' | null
}

const DAY_MS = 24 * 60 * 60 * 1000

// --- dates as whole days ----------------------------------------------------
// Everything is compared as a calendar day number (days since the epoch). A
// printed date is a local calendar date; a kickoff is a UTC instant, and an
// evening game out west is already the next day in UTC — so kickoffs are
// converted to the Eastern calendar day first. No CFL kickoff is late enough
// for that to move the Eastern date.

const dayOf = (year: number, month: number, day: number): number | null => {
    const d = new Date(Date.UTC(year, month, day))
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) {
        return null
    }
    return d.getTime() / DAY_MS
}

const EASTERN = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
})

/** The Eastern calendar day an instant falls on. */
export function easternDay(at: Date): number {
    const [y, m, d] = EASTERN.format(at).split('-').map(Number)
    return Date.UTC(y, m - 1, d) / DAY_MS
}

export const dayToIso = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10)

// --- reading the signals ----------------------------------------------------

const MONTHS: [RegExp, number][] = [
    [/^jan/i, 0],
    [/^feb/i, 1],
    [/^mar/i, 2],
    [/^apr/i, 3],
    [/^may/i, 4],
    [/^jun/i, 5],
    [/^jul/i, 6],
    [/^aug/i, 7],
    [/^sep/i, 8],
    [/^oct/i, 9],
    [/^nov/i, 10],
    [/^dec/i, 11],
]

// Spelled-out months only — a bare prefix would read "Mar" out of "Marlon".
const MONTH_DAY =
    /(?<![a-z])(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*(\d{1,2})(?!\d)/i

/** "Sunday, Sept 6" / "Sat, Aug. 8" / "JUNE 5" → a day in `year`. */
function monthDay(s: string, year: number): { day: number; text: string } | null {
    const m = s.match(MONTH_DAY)
    if (!m) return null
    const month = MONTHS.find(([re]) => re.test(m[1]))![1]
    const day = dayOf(year, month, Number(m[2]))
    return day === null ? null : { day, text: m[0] }
}

/** "11.07.2026" / "08-8-2026" (month first) or "2026.05.22" — only in `year`. */
function numericDate(s: string, year: number): { day: number; text: string } | null {
    const mdy = s.match(/(?<!\d)(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})(?!\d)/)
    if (mdy && Number(mdy[3]) === year) {
        const day = dayOf(year, Number(mdy[1]) - 1, Number(mdy[2]))
        if (day !== null) return { day, text: mdy[0] }
    }
    const ymd = s.match(/(?<!\d)(\d{4})[.\-_](\d{1,2})[.\-_](\d{1,2})(?!\d)/)
    if (ymd && Number(ymd[1]) === year) {
        const day = dayOf(year, Number(ymd[2]) - 1, Number(ymd[3]))
        if (day !== null) return { day, text: ymd[0] }
    }
    return null
}

/** Calgary: "260605-vsWPG-position-chart.pdf" — YYMMDD leading the filename. */
function yymmdd(file: string, year: number): { day: number; text: string } | null {
    const m = file.match(/^(\d{2})(\d{2})(\d{2})(?!\d)/)
    if (!m || Number(m[1]) !== year % 100) return null
    const day = dayOf(year, Number(m[2]) - 1, Number(m[3]))
    return day === null ? null : { day, text: m[0] }
}

/** The last path segment, decoded, with separators turned into spaces. */
function fileWords(url: string): string {
    let last = url.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? ''
    try {
        last = decodeURIComponent(last)
    } catch {
        // A malformed escape is still worth scanning as-is.
    }
    return last.replace(/\.pdf$/i, '').replace(/[_\-+]+/g, ' ')
}

const rawFile = (url: string): string => url.split(/[?#]/)[0].split('/').pop() ?? ''

// "Week 14", "WEEK 1", "WK16", "W5", "Week14MTL" — the digits may run straight
// into an opponent code, so the end is "not another digit", not a word boundary.
const PRINTED_WEEK = /(?<![a-z])(?:week|wk|w)\s*(\d{1,2})(?!\d)/i

function printedWeek(s: string): { week: number; text: string } | null {
    const m = s.match(PRINTED_WEEK)
    if (!m) return null
    const week = Number(m[1])
    return week >= 1 && week <= 30 ? { week, text: m[0] } : null
}

const PRESEASON = /(?<![a-z])(pre[\s-]?season|ps)(?![a-z])/i
const POSTSEASON =
    /(?<![a-z])(semi[\s-]?final|(?:eastern|western|east|west|division(?:al)?)\s+final|grey\s+cup|playoffs?|esf|wsf)(?![a-z])/i

// Every way a club names another club in its link text.
const TEAM_ALIASES: [string, string[]][] = [
    ['SSK', ['SSK', 'SASK', 'Saskatchewan', 'Roughriders', 'Riders']],
    ['BC', ['BC', 'B\\.C\\.?', 'British Columbia', 'Lions']],
    ['EDM', ['EDM', 'Edmonton', 'Elks']],
    ['CGY', ['CGY', 'CAL', 'Calgary', 'Stampeders', 'Stamps']],
    ['MTL', ['MTL', 'Montr[eé]al', 'Alouettes']],
    ['WPG', ['WPG', 'Winnipeg', 'Blue Bombers', 'Bombers']],
    ['HAM', ['HAM', 'Hamilton', 'Tiger-Cats', 'Ticats']],
    ['TOR', ['TOR', 'Toronto', 'Argonauts', 'Argos']],
    ['OTT', ['OTT', 'Ottawa', 'REDBLACKS']],
]
const TEAM_PATTERNS = TEAM_ALIASES.map(
    ([abbr, names]) =>
        [abbr, new RegExp(`(?<![a-z])(?:${names.join('|')})(?![a-z])`, 'i')] as const,
)

/** The one other club the title names, or null when it names none or several. */
function opponentIn(title: string, team: string): string | null {
    const named = TEAM_PATTERNS.filter(([abbr, re]) => abbr !== team && re.test(title))
    return named.length === 1 ? named[0][0] : null
}

/** Everything a chart's link text, filename and article URL say about its game. PURE. */
export function readChartSignals(input: ChartInput): ChartSignals {
    const { title, href, page, year } = input
    const file = fileWords(href)

    let date: ChartSignals['date'] = null
    const fromTitle = monthDay(title, year) ?? numericDate(title, year)
    if (fromTitle) date = { ...fromTitle, from: 'title' }
    else {
        const fromFile =
            yymmdd(rawFile(href), year) ?? numericDate(rawFile(href), year) ?? monthDay(file, year)
        if (fromFile) date = { ...fromFile, from: 'filename' }
        else if (page) {
            const fromPage = numericDate(rawFile(page), year)
            if (fromPage) date = { ...fromPage, from: 'page' }
        }
    }

    const wTitle = printedWeek(title)
    const wFile = wTitle ? null : printedWeek(file)
    const pw: ChartSignals['printedWeek'] = wTitle
        ? { ...wTitle, from: 'title' }
        : wFile
          ? { ...wFile, from: 'filename' }
          : null

    const stage =
        PRESEASON.test(title) || PRESEASON.test(file)
            ? 'pre'
            : POSTSEASON.test(title) || POSTSEASON.test(file)
              ? 'post'
              : null

    return { date, printedWeek: pw, opponent: opponentIn(title, input.team), stage }
}

// --- mapping onto the schedule ---------------------------------------------

type Range = { week: number; start: number; end: number }

const ranges = (gameweeks: ScheduleGameweek[]): Range[] =>
    gameweeks
        .filter((g) => g.startDate)
        .map((g) => {
            const start = easternDay(g.startDate!)
            return { week: g.week, start, end: g.endDate ? easternDay(g.endDate) : start + 6 }
        })
        .sort((a, b) => a.start - b.start)

/** The week a day falls in, by gameweek date ranges. Null before the first. */
function weekByDate(
    day: number,
    gameweeks: Range[],
): { week: number; season: ChartSeason; how: string } | null {
    const first = gameweeks[0]
    const last = gameweeks.at(-1)!
    // A day of slack either side absorbs a club printing the wrong date.
    if (day < first.start - 1) return null
    const inside = gameweeks.find((g) => day >= g.start && day <= g.end)
    if (inside)
        return { week: inside.week, season: 'regular', how: `inside gameweek ${inside.week}` }
    if (day > last.end + 1) {
        // Past the regular season: the playoffs are not gameweeks, so count on
        // from the last one — semi-finals a week later, and so on.
        const week = last.week + Math.max(1, Math.floor((day - last.start) / 7))
        return {
            week,
            season: 'post',
            how: `${week - last.week} week(s) after gameweek ${last.week}`,
        }
    }
    // In the gap between two gameweeks, or within the slack day: the nearest
    // start or end wins; a tie goes to the upcoming week.
    const nearest = [...gameweeks].sort(
        (a, b) =>
            Math.min(Math.abs(day - a.start), Math.abs(day - a.end)) -
                Math.min(Math.abs(day - b.start), Math.abs(day - b.end)) || b.start - a.start,
    )[0]
    return { week: nearest.week, season: 'regular', how: `nearest gameweek ${nearest.week}` }
}

const describeMatch = (m: ScheduleMatch): string =>
    `${m.away ?? '?'} @ ${m.home ?? '?'} ${dayToIso(easternDay(m.date))}`

/**
 * The season and week a chart is for, from what it says about its game, or
 * null when it says nothing usable — the caller then falls back to the week it
 * was first seen. PURE.
 */
export function deriveChartWeek(input: ChartInput, schedule: ChartSchedule): ChartWeek | null {
    const signals = readChartSignals(input)
    const { date, printedWeek: pw, opponent, stage } = signals
    const notes: string[] = []
    if (date) notes.push(`date "${date.text}" (${date.from}) = ${dayToIso(date.day)}`)
    if (pw) notes.push(`printed "${pw.text}" (${pw.from})`)
    if (opponent) notes.push(`opponent ${opponent}`)
    const done = (week: number, season: ChartSeason, source: ChartWeekSource, how: string) => {
        if (pw && source !== 'printed-week' && source !== 'preseason' && pw.week !== week) {
            notes.push(`printed week ${pw.week} DISAGREES`)
        }
        return { week, season, source, evidence: [...notes, how].join('; ') }
    }

    if (stage === 'pre') return done(1, 'pre', 'preseason', 'preseason marker → week 1')

    const gws = ranges(schedule.gameweeks)

    if (date) {
        // 1. The club's own fixture on that date.
        const ours = schedule.matches
            .filter((m) => m.home === input.team || m.away === input.team)
            .map((m) => ({ m, off: Math.abs(easternDay(m.date) - date.day) }))
            .filter((c) => c.off <= 1)
        const against = opponent
            ? ours.filter((c) => c.m.home === opponent || c.m.away === opponent)
            : []
        const pick = (against.length ? against : ours).sort((a, b) => a.off - b.off)[0]
        if (pick) {
            const vs = pick.m.home === input.team ? pick.m.away : pick.m.home
            if (opponent && vs !== opponent)
                notes.push(`fixture opponent is ${vs}, title says ${opponent}`)
            const season: ChartSeason =
                stage === 'post' || (gws.length && date.day > gws.at(-1)!.end + 1)
                    ? 'post'
                    : 'regular'
            return done(
                pick.m.week,
                season,
                'fixture',
                `fixture ${describeMatch(pick.m)} → gameweek ${pick.m.week}`,
            )
        }

        // 2. The gameweek whose dates it falls in.
        if (gws.length) {
            const byDate = weekByDate(date.day, gws)
            if (!byDate) return done(1, 'pre', 'gameweek', 'before the first gameweek → preseason')
            const season = stage === 'post' ? 'post' : byDate.season
            return done(byDate.week, season, 'gameweek', `${byDate.how} → week ${byDate.week}`)
        }
    }

    // 3. The week number the club printed.
    if (pw) {
        return done(pw.week, stage ?? 'regular', 'printed-week', `printed week → ${pw.week}`)
    }

    // 4. The printed date through the hardcoded season boundaries.
    if (date) {
        const info = getDepthChartInfo(new Date(date.day * DAY_MS + 12 * 60 * 60 * 1000))
        return done(
            info.week,
            stage ?? info.season,
            'date-math',
            `no gameweeks for ${input.year}; date math → week ${info.week}`,
        )
    }

    return null
}

/**
 * The week a chart is first SEEN — the old rule, now only the fallback for a
 * chart that says nothing about its game: the first gameweek not yet complete,
 * else the season's last; date math when the season has no gameweeks.
 */
export function firstSeenWeek(
    gameweeks: (ScheduleGameweek & { status: string })[],
    now: Date,
): DepthChartInfo {
    const info = getDepthChartInfo(now)
    const ordered = [...gameweeks].sort((a, b) => a.week - b.week)
    const current = ordered.find((g) => g.status !== 'complete') ?? ordered.at(-1)
    return { season: info.season, week: current?.week ?? info.week }
}
