import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { TEAMS } from '~/data/teams'
import {
    deriveChartWeek,
    easternDay,
    firstSeenWeek,
    readChartSignals,
    type ChartSchedule,
    type ScheduleGameweek,
} from '~/services/depthCharts/chartWeek'
import { extract, type Doc, type Strategy } from '~/services/depthCharts/scrape/extractors'

// The 2026 calendar as Tuesday–Monday gameweeks: week 1 is June 2–8 (the
// season opened Thursday June 4), week 14 ends on Labour Day, week 21 is
// October 20–26. Every week number a club prints agrees with it (asserted
// below), which is what makes it a fair stand-in for the Game Zone rows.
const GAMEWEEKS_2026: ScheduleGameweek[] = Array.from({ length: 21 }, (_, i) => ({
    week: i + 1,
    startDate: new Date(Date.UTC(2026, 5, 2 + 7 * i, 16)),
    endDate: new Date(Date.UTC(2026, 5, 8 + 7 * i, 23)),
}))
const BY_DATE: ChartSchedule = { gameweeks: GAMEWEEKS_2026, matches: [] }

const load = (slug: string): Doc =>
    parseHTML(readFileSync(`test/fixtures/depth-charts/${slug}.html`, 'utf8'))
        .document as unknown as Doc

const label = (w: { season: string; week: number }) =>
    w.season === 'regular' ? String(w.week) : `${w.season} ${w.week}`

// What every committed club page derives to, chart by chart in page order.
// Read off the link text, and for Calgary the filename. Preseason is week 1
// (what a chart caught live in May has always got); the playoffs count on
// from week 21: semi-finals 22, division finals 23.
const EXPECTED: Record<string, { signal: string; weeks: string[] }> = {
    SSK: {
        signal: 'title date + "Week N" + "Preseason"/"Semi-Final"',
        weeks: [
            'pre 1',
            'pre 1',
            ...'2 3 4 5 6 8 9 10 11 12 13 14 15 17 18 19 20 21'.split(' '),
            'post 22',
        ],
    },
    BC: {
        signal: 'title date; "Week N" in the filename; preseason only by date',
        weeks: [
            'pre 1',
            'pre 1',
            ...'2 3 4 5 7 8 9 10 11 12 13 14 15 17 18 19 20 21'.split(' '),
            'post 23',
        ],
    },
    EDM: {
        signal: 'MM.DD.YYYY in the title (newest first); preseason only by date',
        weeks: ['post 23', ...'21 20 19 17 16 15 14 12 11 10 9 8 6 5 4 3 1'.split(' '), 'pre 1'],
    },
    CGY: {
        signal: 'no date in the link text — YYMMDD prefix on the filename',
        weeks: '1 3 4 5 6 7 8 9 10 11 13 14 15 16 17 18 19 20'.split(' '),
    },
    MTL: {
        signal: 'title date + "Preseason"/"Eastern Final"',
        weeks: [
            'pre 1',
            'pre 1',
            ...'1 2 3 4 6 7 8 9 10 12 13 14 15 16 18 19 20 21'.split(' '),
            'post 23',
        ],
    },
    WPG: {
        signal: 'title date + "PS Week"/"Semi-Final"/"FInal"',
        weeks: [
            'pre 1',
            'pre 1',
            ...'1 2 4 5 6 7 8 9 11 14 15 17 18 19 20 21'.split(' '),
            'post 22',
            'post 23',
        ],
    },
    HAM: {
        signal: 'title date; "W<N>" in the early filenames',
        weeks: '1 2 3 5 6 7 8 9 10 14 16 17 18 19 21'.split(' '),
    },
    TOR: {
        signal: 'title date + "Week N" + "Preseason"/"Semi-Final"',
        weeks: [
            'pre 1',
            'pre 1',
            ...'2 3 4 5 6 7 8 10 11 12 13 14 15 16 17 18 20 21'.split(' '),
            'post 22',
        ],
    },
    OTT: {
        signal: 'title date + "WEEK N" + "PRE-SEASON"',
        weeks: ['pre 1', 'pre 1', ...'1 3 4 5 6 7 9 16 18 20 21'.split(' ')],
    },
}

describe.each(TEAMS.map((t) => [t.abbreviation, t] as const))('%s chart weeks', (abbr, team) => {
    const items = extract(
        load(team.slug),
        team.strategy as Strategy,
        team.config,
        new URL(team.depthChartUrl).origin,
    )
    const derived = items.map((i) =>
        deriveChartWeek(
            { team: abbr, year: 2026, title: i.title, href: i.href, page: i.page },
            BY_DATE,
        ),
    )

    it(`reads every chart's game (${EXPECTED[abbr].signal})`, () => {
        // Not one chart falls back to the week it was first seen.
        expect(derived.every((d) => d !== null)).toBe(true)
        expect(derived.map((d) => label(d!))).toEqual(EXPECTED[abbr].weeks)
    })

    it('never contradicts a week number the club printed', () => {
        for (const d of derived) expect(d!.evidence).not.toContain('DISAGREES')
    })
})

// --- the fixture path -------------------------------------------------------

const kickoff = (iso: string) => new Date(iso)
const SCHEDULE: ChartSchedule = {
    gameweeks: GAMEWEEKS_2026,
    matches: [
        // 7:00 PM Pacific on Friday Sept 25 is already Saturday in UTC.
        { home: 'BC', away: 'SSK', date: kickoff('2026-09-26T02:00:00Z'), week: 17 },
        { home: 'SSK', away: 'WPG', date: kickoff('2026-09-06T20:00:00Z'), week: 14 },
        { home: 'WPG', away: 'SSK', date: kickoff('2026-09-12T23:00:00Z'), week: 15 },
        // A playoff game the feed does carry, under its own gameweek.
        { home: 'BC', away: 'SSK', date: kickoff('2026-10-31T23:00:00Z'), week: 22 },
    ],
}
const ssk = (title: string, href = 'https://riderville.com/x.pdf') => ({
    team: 'SSK',
    year: 2026,
    title,
    href,
})

describe('deriveChartWeek against the schedule', () => {
    it("matches a western evening kickoff on the club's own calendar day", () => {
        const d = deriveChartWeek(ssk('Week 17, Friday, Sept 25, SSK @ BC'), SCHEDULE)!
        expect(d).toMatchObject({ week: 17, season: 'regular', source: 'fixture' })
        expect(d.evidence).toContain('SSK @ BC 2026-09-25')
    })

    it('absorbs a date the club printed a day out', () => {
        const d = deriveChartWeek(ssk('Saturday, Sept 13, SSK @ WPG'), SCHEDULE)!
        expect(d).toMatchObject({ week: 15, source: 'fixture' })
    })

    it('uses a playoff fixture when the feed carries one, and marks it post', () => {
        const d = deriveChartWeek(ssk('Western Semi-Final, Oct 31, SSK @ BC'), SCHEDULE)!
        expect(d).toMatchObject({ week: 22, season: 'post', source: 'fixture' })
    })

    it('prefers the fixture against the named opponent', () => {
        const twoGames: ChartSchedule = {
            gameweeks: GAMEWEEKS_2026,
            matches: [
                { home: 'SSK', away: 'WPG', date: kickoff('2026-09-06T20:00:00Z'), week: 14 },
                { home: 'SSK', away: 'TOR', date: kickoff('2026-09-07T20:00:00Z'), week: 99 },
            ],
        }
        const d = deriveChartWeek(ssk('Sunday, Sept 7, TOR @ SSK'), twoGames)!
        expect(d.week).toBe(99)
        const nearest = deriveChartWeek(ssk('Sunday, Sept 7'), twoGames)!
        expect(nearest.week).toBe(99)
        const fallback = deriveChartWeek(ssk('Sunday, Sept 6, EDM @ SSK'), twoGames)!
        expect(fallback.week).toBe(14)
        expect(fallback.evidence).toContain('fixture opponent is WPG, title says EDM')
    })

    it('notes a printed week that disagrees with the schedule', () => {
        const d = deriveChartWeek(ssk('Week 9, Sunday, Sept 6, WPG @ SSK'), SCHEDULE)!
        expect(d.week).toBe(14)
        expect(d.evidence).toContain('printed week 9 DISAGREES')
    })

    it('falls back to the gameweek dates when the club has no fixture that day', () => {
        const d = deriveChartWeek(ssk('Thursday, Aug 20'), SCHEDULE)!
        expect(d).toMatchObject({ week: 12, source: 'gameweek' })
    })
})

describe('deriveChartWeek by gameweek dates', () => {
    const gappy: ChartSchedule = {
        gameweeks: [
            {
                week: 1,
                startDate: new Date('2026-06-04T23:00:00Z'),
                endDate: new Date('2026-06-07T23:00:00Z'),
            },
            {
                week: 2,
                startDate: new Date('2026-06-11T23:00:00Z'),
                endDate: new Date('2026-06-14T23:00:00Z'),
            },
            // No dates: ignored rather than guessed.
            { week: 3, startDate: null, endDate: null },
        ],
        matches: [],
    }
    const on = (title: string) => deriveChartWeek(ssk(title), gappy)!

    it('takes the nearer gameweek for a midweek date, the upcoming one on a tie', () => {
        expect(on('Monday, June 8').week).toBe(1)
        expect(on('Wednesday, June 10').week).toBe(2)
        expect(on('Tuesday, June 9')).toMatchObject({ week: 2, season: 'regular' })
    })

    it('allows a day of slack before the first gameweek', () => {
        expect(on('Wednesday, June 3')).toMatchObject({ week: 1, season: 'regular' })
        expect(on('Tuesday, June 2')).toMatchObject({ week: 1, season: 'pre' })
    })

    it('counts playoff weeks on from the last gameweek', () => {
        expect(on('Saturday, June 20')).toMatchObject({ week: 3, season: 'post' })
        expect(on('Saturday, June 27')).toMatchObject({ week: 4, season: 'post' })
    })

    it('treats a gameweek with no end date as seven days long', () => {
        const d = deriveChartWeek(ssk('Thursday, June 10'), {
            gameweeks: [{ week: 1, startDate: new Date('2026-06-04T23:00:00Z'), endDate: null }],
            matches: [],
        })!
        expect(d).toMatchObject({ week: 1, season: 'regular' })
    })
})

describe('deriveChartWeek without a usable date', () => {
    it("uses the club's printed week", () => {
        const d = deriveChartWeek(
            { team: 'BC', year: 2026, title: 'Game 12', href: 'https://x/Depth_Week14MTL.pdf' },
            SCHEDULE,
        )!
        expect(d).toMatchObject({ week: 14, season: 'regular', source: 'printed-week' })
    })

    it('keeps a playoff marker on a printed week', () => {
        const d = deriveChartWeek(ssk('Western Final, Week 23'), { gameweeks: [], matches: [] })!
        expect(d).toMatchObject({ week: 23, season: 'post', source: 'printed-week' })
    })

    it('falls back to date math only when the season has no gameweeks', () => {
        const d = deriveChartWeek(ssk('Saturday, June 13, BC @ SSK'), {
            gameweeks: [],
            matches: [],
        })!
        expect(d).toMatchObject({ week: 1, season: 'regular', source: 'date-math' })
        expect(d.evidence).toContain('no gameweeks for 2026')
    })

    it('returns null when the chart says nothing about its game', () => {
        expect(deriveChartWeek(ssk('Depth chart'), SCHEDULE)).toBeNull()
    })
})

describe('readChartSignals', () => {
    const read = (title: string, href = 'https://x/a.pdf', page?: string) =>
        readChartSignals({ team: 'EDM', year: 2026, title, href, page })

    it("reads Edmonton's date from the article URL when the title has none", () => {
        const s = read('Depth Chart', 'https://x/a.pdf', 'https://goelks.com/article/10-24-2026-x')
        expect(s.date).toMatchObject({ from: 'page', text: '10-24-2026' })
    })

    it('reads YYYY.MM.DD from a filename (Ottawa)', () => {
        expect(read('x', 'https://x/2026.10.16.OTTvsTOR.WK20.pdf').date?.from).toBe('filename')
    })

    it('reads a month name from a filename (Winnipeg)', () => {
        const s = read('x', 'https://x/WINNIPEG_AT_BC_OCTOBER_23.pdf')
        expect(s.date?.text).toBe('OCTOBER 23')
    })

    it('ignores dates from another year and impossible dates', () => {
        expect(read('x', 'https://x/250605-vsWPG.pdf').date).toBeNull()
        expect(read('02.30.2026 | Depth Chart').date).toBeNull()
        expect(read('June 31').date).toBeNull()
        expect(read('x', 'https://x/261340-vsWPG.pdf').date).toBeNull()
        expect(read('11.07.2025 | Depth Chart').date).toBeNull()
    })

    it('does not read a month out of a longer word', () => {
        expect(read('Marlon 12').date).toBeNull()
    })

    it('ignores week numbers out of range, and "Game N" is not a week', () => {
        expect(read('Week 0').printedWeek).toBeNull()
        expect(read('Week 45').printedWeek).toBeNull()
        expect(read('Game 14, SSK, CGY').printedWeek).toBeNull()
    })

    it('names the opponent only when exactly one other club is named', () => {
        expect(read('VS Blue Bombers').opponent).toBe('WPG')
        expect(read('EDM @ B.C.').opponent).toBe('BC')
        expect(read('Depth Chart').opponent).toBeNull()
        expect(read('Riders and Lions').opponent).toBeNull()
    })

    it('scans a malformed percent-escape as-is', () => {
        expect(read('x', 'https://x/x_Week_7_%E0%A4%A.pdf').printedWeek?.week).toBe(7)
    })
})

describe('firstSeenWeek (the fallback)', () => {
    const gws = [
        { week: 1, startDate: null, endDate: null, status: 'complete' },
        { week: 2, startDate: null, endDate: null, status: 'playing' },
    ]

    it('is the first gameweek not yet complete', () => {
        expect(firstSeenWeek(gws, new Date('2026-06-12T12:00:00Z'))).toEqual({
            season: 'regular',
            week: 2,
        })
    })

    it("is the season's last once every gameweek is complete", () => {
        const done = gws.map((g) => ({ ...g, status: 'complete' }))
        expect(firstSeenWeek(done, new Date('2026-11-08T12:00:00Z')).week).toBe(2)
    })

    it('is date math when the season has no gameweeks', () => {
        expect(firstSeenWeek([], new Date('2026-06-14T12:00:00Z'))).toEqual({
            season: 'regular',
            week: 2,
        })
    })
})

describe('easternDay', () => {
    it('puts a late western kickoff on the Eastern calendar day', () => {
        expect(easternDay(new Date('2026-09-26T02:00:00Z'))).toBe(
            Date.UTC(2026, 8, 25) / 86_400_000,
        )
    })
})
