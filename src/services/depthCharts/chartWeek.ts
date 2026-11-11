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
// text has none), and often a week number, the opponent, or the playoff round
// as well. This module reads those signals and maps them onto the schedule.
// PURE: the schedule is passed in, so the same code runs in the sweep, the
// repair script and the tests.
//
// Precedence, strongest first:
//   1. fixture        the printed date matches one of the club's own scheduled
//                     matches — within a day, or within three against the
//                     opponent the chart names — → that match's gameweek
//   2. preseason      "Preseason" / "PRE-SEASON" / "PS Week 1" / "PS-1"
//                     → season 'pre', week 1 (what a chart caught live in May
//                     has always got)
//   3. playoff-round  "Semi-Final" / "Western Final" / "Grey Cup" → 1, 2 or 3
//                     weeks after the last gameweek. The Game Zone feed has no
//                     playoff matches, and clubs print playoff dates a day out
//                     either way, so the round is the reliable signal
//   4. printed-week   "Week 14" / "WK16" / "W5" in the link text or filename
//   5. gameweek       the printed date against each gameweek's match days;
//                     well before the first is preseason, after the last
//                     rounds to whole weeks past it
//   6. date-math      the printed date through getDepthChartInfo's hardcoded
//                     boundaries — only when the season has no gameweeks
//   (7. first-seen    not here: the caller's fallback when this returns null)

import { getDepthChartInfo, type DepthChartInfo } from './season.server'

export type ChartSeason = DepthChartInfo['season']

export type ChartWeekSource =
    'fixture' | 'preseason' | 'playoff-round' | 'printed-week' | 'gameweek' | 'date-math'

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

/** Playoff rounds, counted in weeks after the regular season's last gameweek. */
export type PlayoffRound = 1 | 2 | 3

export type ChartSignals = {
    date: { day: number; text: string; from: 'title' | 'filename' | 'page' } | null
    printedWeek: { week: number; text: string; from: 'title' | 'filename' } | null
    opponent: string | null
    preseason: boolean
    round: PlayoffRound | null
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

// --- the schedule as windows of match days -----------------------------------
// A Game Zone gameweek's startDate is one of its kickoffs — not the first:
// week 1 2026 starts Saturday June 6, but the opener was Thursday June 4 — and
// its endDate is the close-out, usually the Tuesday after. Neither bounds the
// games, so a week's window is built from its matches' days instead. A week
// with no matches falls back to two days either side of its startDate — the
// span a CFL week's Thursday-to-Monday games cover around any one of them.
// endDate is deliberately unused.

const NO_MATCH_HALF_WIDTH = 2

export type WeekWindow = { week: number; start: number; end: number }

export function weekWindows(schedule: ChartSchedule): WeekWindow[] {
    const days = new Map<number, number[]>()
    for (const m of schedule.matches) {
        days.set(m.week, [...(days.get(m.week) ?? []), easternDay(m.date)])
    }
    for (const g of schedule.gameweeks) {
        if (days.has(g.week) || !g.startDate) continue
        const start = easternDay(g.startDate)
        days.set(g.week, [start - NO_MATCH_HALF_WIDTH, start + NO_MATCH_HALF_WIDTH])
    }
    return [...days]
        .map(([week, d]) => ({ week, start: Math.min(...d), end: Math.max(...d) }))
        .sort((a, b) => a.start - b.start)
}

// Dates a chart can be for: preseason runs a few weeks ahead of the first
// gameweek, the Grey Cup three weeks after the last. Without a schedule, May
// to November.
const SPAN_BEFORE = 35
const SPAN_AFTER = 28

export function seasonSpan(windows: WeekWindow[], year: number): { from: number; to: number } {
    if (windows.length === 0) return { from: dayOf(year, 4, 1)!, to: dayOf(year, 10, 30)! }
    return { from: windows[0].start - SPAN_BEFORE, to: windows.at(-1)!.end + SPAN_AFTER }
}

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

/**
 * Calgary: "260605-vsWPG-position-chart.pdf" — YYMMDD leading the filename.
 * Six bare digits could be anything, so only a date inside the season counts.
 */
function yymmdd(
    file: string,
    year: number,
    span: { from: number; to: number },
): { day: number; text: string } | null {
    const m = file.match(/^(\d{2})(\d{2})(\d{2})(?!\d)/)
    if (!m || Number(m[1]) !== year % 100) return null
    const day = dayOf(year, Number(m[2]) - 1, Number(m[3]))
    return day === null || day < span.from || day > span.to ? null : { day, text: m[0] }
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

// "PS" alone is too short to trust ("PS additions", "TOR-vs-HAM-PS.pdf"); it
// counts only as "PS Week 1" / "PS-1".
const PRESEASON = /pre[\s-]?season|(?<![a-z])ps\s*(?:week\s*)?\d/i
// Bare "playoff" is not a round: "Playoff push: Week 20" is a regular-season game.
const SEMI_FINAL = /semi[\s-]?final|(?<![a-z])(?:esf|wsf)(?![a-z])/i
const DIVISION_FINAL = /(?<![a-z])(?:eastern|western|east|west|division(?:al)?)\s*final/i
const GREY_CUP = /grey\s*cup/i

function playoffRound(...texts: string[]): PlayoffRound | null {
    if (texts.some((t) => SEMI_FINAL.test(t))) return 1
    if (texts.some((t) => DIVISION_FINAL.test(t))) return 2
    if (texts.some((t) => GREY_CUP.test(t))) return 3
    return null
}

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

/**
 * Everything a chart's link text, filename and article URL say about its game.
 * `span` bounds the dates a bare YYMMDD filename prefix may mean. PURE.
 */
export function readChartSignals(
    input: ChartInput,
    span = seasonSpan([], input.year),
): ChartSignals {
    const { title, href, page, year } = input
    const file = fileWords(href)

    let date: ChartSignals['date'] = null
    const fromTitle = monthDay(title, year) ?? numericDate(title, year)
    if (fromTitle) date = { ...fromTitle, from: 'title' }
    else {
        const fromFile =
            yymmdd(rawFile(href), year, span) ??
            numericDate(rawFile(href), year) ??
            monthDay(file, year)
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

    return {
        date,
        printedWeek: pw,
        opponent: opponentIn(title, input.team),
        preseason: PRESEASON.test(title) || PRESEASON.test(file),
        round: playoffRound(title, file),
    }
}

// --- mapping onto the schedule ---------------------------------------------

// How far a printed date may sit from the kickoff and still name that fixture:
// a day for any of the club's games, three when it is against the opponent
// the chart names. A club never plays the same opponent twice in four days.
const FIXTURE_SLACK = 1
const FIXTURE_SLACK_SAME_OPPONENT = 3
// A printed date this many days or more before the first match day is preseason.
const PRESEASON_GAP = 4

/** The week a day falls in, by match-day windows. Null for preseason. */
function weekByDate(
    day: number,
    windows: WeekWindow[],
): { week: number; season: ChartSeason; how: string } | null {
    const first = windows[0]
    const last = windows.at(-1)!
    if (day <= first.start - PRESEASON_GAP) return null
    const inside = windows.find((w) => day >= w.start && day <= w.end)
    if (inside)
        return { week: inside.week, season: 'regular', how: `in week ${inside.week}'s games` }
    if (day > last.end + 1) {
        // Past the regular season, rounded to whole weeks from its last match day.
        const after = Math.max(1, Math.round((day - last.end) / 7))
        return {
            week: last.week + after,
            season: 'post',
            how: `${after} week(s) after week ${last.week}'s games`,
        }
    }
    // Between two weeks' games (or within the slack): the nearer week wins, the
    // upcoming one on a tie — a chart is posted ahead of its game.
    const distance = (w: WeekWindow) => Math.min(Math.abs(day - w.start), Math.abs(day - w.end))
    const nearest = [...windows].sort((a, b) => distance(a) - distance(b) || b.start - a.start)[0]
    return { week: nearest.week, season: 'regular', how: `nearest to week ${nearest.week}'s games` }
}

const describeMatch = (m: ScheduleMatch): string =>
    `${m.away ?? '?'} @ ${m.home ?? '?'} ${dayToIso(easternDay(m.date))}`

/**
 * The season and week a chart is for, from what it says about its game, or
 * null when it says nothing usable — the caller then falls back to the week it
 * was first seen. PURE.
 */
export function deriveChartWeek(input: ChartInput, schedule: ChartSchedule): ChartWeek | null {
    const windows = weekWindows(schedule)
    const last = windows.at(-1)
    const signals = readChartSignals(input, seasonSpan(windows, input.year))
    const { date, printedWeek: pw, opponent, preseason, round } = signals
    const notes: string[] = []
    if (date) notes.push(`date "${date.text}" (${date.from}) = ${dayToIso(date.day)}`)
    if (pw) notes.push(`printed "${pw.text}" (${pw.from})`)
    if (opponent) notes.push(`opponent ${opponent}`)
    if (round) notes.push(['semi-final', 'division final', 'Grey Cup'][round - 1])
    const done = (week: number, season: ChartSeason, source: ChartWeekSource, how: string) => {
        if (pw && source !== 'printed-week' && source !== 'preseason' && pw.week !== week) {
            notes.push(`printed week ${pw.week} DISAGREES`)
        }
        return { week, season, source, evidence: [...notes, how].join('; ') }
    }

    // 1. The club's own fixture on (or about) that date.
    if (date) {
        const candidates = schedule.matches
            .filter((m) => m.home === input.team || m.away === input.team)
            .map((m) => {
                const vs = m.home === input.team ? m.away : m.home
                const named = opponent !== null && vs === opponent
                return { m, vs, named, off: Math.abs(easternDay(m.date) - date.day) }
            })
            .filter(
                (c) => c.off <= FIXTURE_SLACK || (c.named && c.off <= FIXTURE_SLACK_SAME_OPPONENT),
            )
            .sort((a, b) => Number(b.named) - Number(a.named) || a.off - b.off)
        const pick = candidates[0]
        if (pick) {
            if (opponent && pick.vs !== opponent) {
                notes.push(`fixture opponent is ${pick.vs}, title says ${opponent}`)
            }
            const post = round !== null || (last !== undefined && date.day > last.end + 1)
            return done(
                pick.m.week,
                post ? 'post' : 'regular',
                'fixture',
                `fixture ${describeMatch(pick.m)} → week ${pick.m.week}`,
            )
        }
    }

    // 2. A preseason game: not in the feed, always week 1.
    if (preseason) return done(1, 'pre', 'preseason', 'preseason marker → week 1')

    // 3. A playoff round, counted on from the regular season's last week.
    if (round && last) {
        return done(
            last.week + round,
            'post',
            'playoff-round',
            `${round} week(s) after week ${last.week} → week ${last.week + round}`,
        )
    }

    // 4. The week number the club printed.
    if (pw) {
        return done(pw.week, round ? 'post' : 'regular', 'printed-week', `→ week ${pw.week}`)
    }

    if (date) {
        // 5. The week whose games the date falls among.
        if (last) {
            const byDate = weekByDate(date.day, windows)
            if (!byDate) return done(1, 'pre', 'gameweek', 'before the first games → preseason')
            return done(
                byDate.week,
                byDate.season,
                'gameweek',
                `${byDate.how} → week ${byDate.week}`,
            )
        }
        // 6. The printed date through the hardcoded season boundaries.
        const info = getDepthChartInfo(new Date(date.day * DAY_MS + 12 * 60 * 60 * 1000))
        return done(
            info.week,
            round ? 'post' : info.season,
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
