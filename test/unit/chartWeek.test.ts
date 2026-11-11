import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { TEAMS } from '~/data/teams'
import {
    deriveChartWeek,
    easternDay,
    firstSeenWeek,
    readChartSignals,
    seasonSpan,
    weekWindows,
    type ChartSchedule,
} from '~/services/depthCharts/chartWeek'
import { extract, type Doc, type Strategy } from '~/services/depthCharts/scrape/extractors'

// The real 2026 Game Zone schedule (gameweeks.json, trimmed): 21 gameweeks, 81
// dated regular-season matches, no playoffs. Its shape is the point — a
// gameweek's startDate is one of its kickoffs (week 1 "starts" Saturday June 6;
// the opener was Thursday June 4) and its endDate is the close-out, usually the
// Tuesday after. Ordinals by start date, exactly as seasonGameweeks() gives them.
type FeedGameweek = {
    startDate: string
    endDate: string
    matches: { homeSquad: { abbr: string }; awaySquad: { abbr: string }; date: string }[]
}
const FEED = (
    JSON.parse(readFileSync('test/fixtures/gamezone/gameweeks-2026.json', 'utf8')) as FeedGameweek[]
).sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate))

const REAL: ChartSchedule = {
    gameweeks: FEED.map((g, i) => ({
        week: i + 1,
        startDate: new Date(g.startDate),
        endDate: new Date(g.endDate),
    })),
    matches: FEED.flatMap((g, i) =>
        g.matches.map((m) => ({
            home: m.homeSquad.abbr,
            away: m.awaySquad.abbr,
            date: new Date(m.date),
            week: i + 1,
        })),
    ),
}
// The same season with the matches missing: only the gameweek rows to go on.
const GAMEWEEKS_ONLY: ChartSchedule = { gameweeks: REAL.gameweeks, matches: [] }

const load = (slug: string): Doc =>
    parseHTML(readFileSync(`test/fixtures/depth-charts/${slug}.html`, 'utf8'))
        .document as unknown as Doc

const label = (w: { season: string; week: number }) =>
    w.season === 'regular' ? String(w.week) : `${w.season} ${w.week}`

const chartsOf = (abbr: string) => {
    const team = TEAMS.find((t) => t.abbreviation === abbr)!
    return extract(
        load(team.slug),
        team.strategy as Strategy,
        team.config,
        new URL(team.depthChartUrl).origin,
    )
}

const derive = (abbr: string, title: string, href = 'https://x/a.pdf', page?: string) =>
    deriveChartWeek({ team: abbr, year: 2026, title, href, page }, REAL)

// What every committed club page derives to, chart by chart in page order.
// Preseason is week 1 (what a chart caught live in May has always got); the
// playoffs count on from week 21: semi-finals 22, division finals 23.
const EXPECTED: Record<string, { signal: string; weeks: string }> = {
    SSK: {
        signal: 'title date + "Week N" + "Preseason"/"Semi-Final"',
        weeks: 'pre 1|pre 1|2|3|4|5|6|8|9|10|11|12|13|14|15|17|18|19|20|21|post 22',
    },
    BC: {
        signal: 'title date; "Week N" in the filename; preseason only by date',
        weeks: 'pre 1|pre 1|2|3|4|5|7|8|9|10|11|12|13|14|15|17|18|19|20|21|post 23',
    },
    EDM: {
        signal: 'MM.DD.YYYY in the title (newest first); preseason and playoff only by date',
        weeks: 'post 23|21|20|19|17|16|15|14|12|11|10|9|8|6|5|4|3|1|pre 1',
    },
    CGY: {
        signal: 'no date in the link text — YYMMDD prefix on the filename',
        weeks: '1|3|4|5|6|7|8|9|10|11|13|14|15|16|17|18|19|20',
    },
    MTL: {
        signal: 'title date + "Preseason"/"Eastern Final"',
        weeks: 'pre 1|pre 1|1|2|3|4|6|7|8|9|10|12|13|14|15|16|18|19|20|21|post 23',
    },
    WPG: {
        signal: 'title date + "PS Week"/"Semi-Final"/"FInal"',
        weeks: 'pre 1|pre 1|1|2|4|5|6|7|8|9|11|14|15|17|18|19|20|21|post 22|post 23',
    },
    HAM: {
        signal: 'title date; "W<N>" in the early filenames',
        weeks: '1|2|3|5|6|7|8|9|10|14|16|17|18|19|21',
    },
    TOR: {
        signal: 'title date + "Week N" + "Preseason"/"Semi-Final"',
        weeks: 'pre 1|pre 1|2|3|4|5|6|7|8|10|11|12|13|14|15|16|17|18|20|21|post 22',
    },
    OTT: {
        signal: 'title date + "WEEK N" + "PRE-SEASON"',
        weeks: 'pre 1|pre 1|1|3|4|5|6|7|9|16|18|20|21',
    },
}

describe.each(TEAMS.map((t) => [t.abbreviation] as const))(
    '%s against the real schedule',
    (abbr) => {
        const items = chartsOf(abbr)
        const weeksAgainst = (schedule: ChartSchedule) =>
            items.map((i) =>
                deriveChartWeek(
                    { team: abbr, year: 2026, title: i.title, href: i.href, page: i.page },
                    schedule,
                ),
            )
        const derived = weeksAgainst(REAL)

        it(`reads every chart's game (${EXPECTED[abbr].signal})`, () => {
            // Not one chart falls back to the week it was first seen.
            expect(derived.every((d) => d !== null)).toBe(true)
            expect(derived.map((d) => label(d!)).join('|')).toBe(EXPECTED[abbr].weeks)
        })

        it('ties every regular-season chart to one of its own fixtures', () => {
            for (const d of derived) {
                if (d!.season === 'regular') expect(d!.source).toBe('fixture')
            }
        })

        it('never contradicts a week number the club printed', () => {
            for (const d of derived) expect(d!.evidence).not.toContain('DISAGREES')
        })

        it('gets the same weeks from the gameweek rows alone, with no matches', () => {
            expect(
                weeksAgainst(GAMEWEEKS_ONLY)
                    .map((d) => label(d!))
                    .join('|'),
            ).toBe(EXPECTED[abbr].weeks)
        })
    },
)

describe('playoffs: both sides of every game land in the same week', () => {
    const playoff = (abbr: string, pick: (title: string) => boolean) => {
        const item = chartsOf(abbr).find((i) => pick(i.title))!
        return label(
            deriveChartWeek(
                { team: abbr, year: 2026, title: item.title, href: item.href, page: item.page },
                REAL,
            )!,
        )
    }

    it('Western Semi-Final, SSK @ BC (only SSK posted)', () => {
        expect(playoff('SSK', (t) => t.startsWith('Western Semi-Final'))).toBe('post 22')
    })

    it('Eastern Semi-Final, WPG @ TOR', () => {
        expect(playoff('WPG', (t) => t.startsWith('Eastern Semi-Final'))).toBe('post 22')
        expect(playoff('TOR', (t) => t.startsWith('Eastern Semi-Final'))).toBe('post 22')
    })

    it('Western Final, BC @ EDM — BC prints Nov 06, EDM prints 11.07 and no round', () => {
        expect(playoff('BC', (t) => t.startsWith('Western Final'))).toBe('post 23')
        expect(playoff('EDM', (t) => t.startsWith('11.07.2026'))).toBe('post 23')
    })

    it('Eastern Final, WPG @ MTL — WPG prints November 6, MTL November 7', () => {
        expect(playoff('WPG', (t) => /^Eastern FInal/i.test(t))).toBe('post 23')
        expect(playoff('MTL', (t) => t.startsWith('Eastern Final'))).toBe('post 23')
    })

    it('reads the round, not the date: a Grey Cup chart dated the Friday before is 24', () => {
        expect(derive('CGY', 'Grey Cup, Friday, Nov 13')).toMatchObject({
            season: 'post',
            week: 24,
            source: 'playoff-round',
        })
        expect(derive('BC', 'Western Semi-Final, Sun, Nov 1')!.week).toBe(22)
        expect(derive('BC', 'Western Final, Sun, Nov 8')!.week).toBe(23)
    })

    it('rounds an unmarked post-season date to whole weeks past the last games', () => {
        // Week 21's last games were Saturday Oct 24.
        expect(label(derive('SSK', 'Saturday, Oct 31')!)).toBe('post 22')
        expect(label(derive('SSK', 'Friday, Nov 6')!)).toBe('post 23')
        expect(label(derive('SSK', 'Friday, Nov 13')!)).toBe('post 24')
        expect(label(derive('SSK', 'Monday, Oct 26')!)).toBe('post 22')
    })

    it('does not read bare "playoff" as a round', () => {
        expect(derive('TOR', 'Playoff push: Week 20, Oct 16 at Ottawa')).toMatchObject({
            season: 'regular',
            week: 20,
        })
    })
})

describe('deriveChartWeek against the fixtures', () => {
    it("matches a western evening kickoff on the club's own calendar day", () => {
        // 7 PM Pacific on Friday Sept 25 is already Saturday in UTC.
        const d = derive('SSK', 'Week 17, Friday, Sept 25, SSK @ BC')!
        expect(d).toMatchObject({ week: 17, source: 'fixture' })
        expect(d.evidence).toContain('SSK @ BC 2026-09-25')
    })

    it('absorbs a date a day out against any opponent, three days out against the named one', () => {
        expect(derive('BC', 'Game 5, Fri, June 26, BC vs CGY')).toMatchObject({
            week: 4,
            source: 'fixture',
        })
        // The real game was Thursday July 30.
        expect(derive('WPG', 'Week 9, Tuesday, July 28, BC at WPG')).toMatchObject({
            week: 9,
            source: 'fixture',
        })
        // The real opener was Thursday June 4: a regular-season game, not preseason.
        expect(derive('HAM', 'Thursday, June 2 vs MTL')).toMatchObject({
            week: 1,
            season: 'regular',
            source: 'fixture',
        })
    })

    it('takes the fixture by date over a title naming the wrong opponent, and says so', () => {
        // Edmonton's June 6 article says "AT Alouettes"; that day it played at Ottawa.
        const d = derive('EDM', '06.06.2026 | Depth Chart: AT Alouettes')!
        expect(d).toMatchObject({ week: 1, source: 'fixture' })
        expect(d.evidence).toContain('fixture opponent is OTT, title says MTL')
    })

    it('prefers the fixture against the named opponent when two are near', () => {
        const twoGames: ChartSchedule = {
            gameweeks: REAL.gameweeks,
            matches: [
                { home: 'SSK', away: 'WPG', date: new Date('2026-09-06T20:00:00Z'), week: 14 },
                { home: 'SSK', away: 'TOR', date: new Date('2026-09-07T20:00:00Z'), week: 99 },
            ],
        }
        const on = (title: string) =>
            deriveChartWeek({ team: 'SSK', year: 2026, title, href: 'https://x/a.pdf' }, twoGames)!
                .week
        expect(on('Sunday, Sept 6, TOR @ SSK')).toBe(99)
        expect(on('Monday, Sept 7, WPG @ SSK')).toBe(14)
        expect(on('Monday, Sept 7')).toBe(99)
    })

    it('notes a printed week that disagrees with the schedule', () => {
        const d = derive('SSK', 'Week 9, Sunday, Sept 6, WPG @ SSK')!
        expect(d.week).toBe(14)
        expect(d.evidence).toContain('printed week 9 DISAGREES')
    })

    it('does not let a bare "PS" override a matching fixture', () => {
        expect(
            derive('TOR', 'Week 12, Aug 22 vs Hamilton', 'https://x/TOR-vs-HAM-PS.pdf'),
        ).toMatchObject({ season: 'regular', week: 12, source: 'fixture' })
        expect(derive('TOR', 'Week 12 Depth Chart - PS additions, Aug 22')).toMatchObject({
            season: 'regular',
            week: 12,
        })
    })
})

describe('deriveChartWeek edge cases', () => {
    it('takes the season from a matched fixture, not from round words in the title', () => {
        expect(derive('HAM', 'Week 1, Grey Cup rematch, Thu June 4 vs MTL')).toMatchObject({
            season: 'regular',
            week: 1,
            source: 'fixture',
        })
    })

    it('calls a date well before the opener preseason, whatever week the filename prints', () => {
        expect(
            derive('BC', 'Game 2, Fri, May 30', 'https://x/Depth-and-Roster-Week2EDM.pdf'),
        ).toMatchObject({ season: 'pre', week: 1 })
    })

    it('reads "PS-1" in a title as preseason', () => {
        expect(derive('MTL', 'PS-1, Friday, May 22, Ottawa')).toMatchObject({
            season: 'pre',
            week: 1,
            source: 'preseason',
        })
    })

    it('lets the printed week choose between two games against the named opponent', () => {
        // SSK @ MTL on Oct 12 (week 19) and MTL @ SSK on Oct 17 (week 20).
        const d = derive('SSK', 'Week 20, Oct 14, MTL @ SSK')!
        expect(d).toMatchObject({ week: 20, source: 'fixture' })
        expect(d.evidence).not.toContain('DISAGREES')
    })
})

describe('deriveChartWeek without a fixture', () => {
    // A club with no matches in the schedule, so only dates and words count.
    const nofix = (title: string, href = 'https://x/a.pdf') =>
        deriveChartWeek({ team: 'XXX', year: 2026, title, href }, REAL)

    it('lets a printed week win over the date', () => {
        expect(nofix('Updated Sept 4: Week 14, Sunday, Sept 6')).toMatchObject({
            week: 14,
            source: 'printed-week',
        })
    })

    it("places a midweek date by the nearer week's games, the upcoming one on a tie", () => {
        // Week 8's games ran July 23–26, week 9's July 30–August 1.
        expect(nofix('Monday, July 27')!.week).toBe(8)
        expect(nofix('Tuesday, July 28')).toMatchObject({ week: 9, source: 'gameweek' })
        expect(nofix('Wednesday, July 29')!.week).toBe(9)
    })

    it('calls only a date well before the opener preseason', () => {
        expect(label(nofix('Tuesday, June 2')!)).toBe('1')
        expect(label(nofix('Sunday, May 31')!)).toBe('pre 1')
    })

    it('uses the gameweek dates when a week has no matches, never the close-out', () => {
        const d = deriveChartWeek(
            { team: 'SSK', year: 2026, title: 'Thursday, June 4', href: 'https://x/a.pdf' },
            GAMEWEEKS_ONLY,
        )!
        expect(d).toMatchObject({ week: 1, source: 'gameweek' })
    })

    it('ignores a gameweek with neither matches nor a start date', () => {
        const windows = weekWindows({
            gameweeks: [...REAL.gameweeks, { week: 22, startDate: null, endDate: null }],
            matches: REAL.matches,
        })
        expect(windows.map((w) => w.week)).not.toContain(22)
    })

    it("uses the club's printed week when there is no date", () => {
        expect(
            deriveChartWeek(
                { team: 'BC', year: 2026, title: 'Game 12', href: 'https://x/Depth_Week14MTL.pdf' },
                REAL,
            ),
        ).toMatchObject({ week: 14, season: 'regular', source: 'printed-week' })
    })

    it('keeps a playoff round on a printed week when there are no gameweeks', () => {
        const d = deriveChartWeek(
            { team: 'SSK', year: 2026, title: 'Western Final, Week 23', href: 'https://x/a.pdf' },
            { gameweeks: [], matches: [] },
        )!
        expect(d).toMatchObject({ week: 23, season: 'post', source: 'printed-week' })
    })

    it('falls back to date math only when the season has no gameweeks', () => {
        const none = { gameweeks: [], matches: [] }
        const on = (title: string) =>
            deriveChartWeek({ team: 'SSK', year: 2026, title, href: 'https://x/a.pdf' }, none)!
        expect(on('Saturday, June 13, BC @ SSK')).toMatchObject({
            week: 1,
            season: 'regular',
            source: 'date-math',
        })
        expect(on('Grey Cup, Sunday, Nov 15').season).toBe('post')
        expect(on('Saturday, June 13').evidence).toContain('no gameweeks for 2026')
    })

    it('returns null when the chart says nothing about its game', () => {
        expect(nofix('Depth chart')).toBeNull()
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

    it("takes Calgary's YYMMDD only inside the season", () => {
        const span = seasonSpan(weekWindows(REAL), 2026)
        const cgy = (file: string) =>
            readChartSignals(
                { team: 'CGY', year: 2026, title: 'Game 12', href: `https://x/${file}` },
                span,
            ).date
        expect(cgy('260907-vsEDM-position-chart.pdf')?.text).toBe('260907')
        expect(cgy('260518-vsBC.pdf')?.text).toBe('260518') // preseason
        expect(cgy('261115-GC.pdf')?.text).toBe('261115') // Grey Cup
        expect(cgy('260117-roster.pdf')).toBeNull()
        expect(cgy('261231-vsEDM.pdf')).toBeNull()
        expect(cgy('250605-vsWPG.pdf')).toBeNull()
        expect(cgy('261340-vsWPG.pdf')).toBeNull()
        expect(cgy('2609071-vsEDM.pdf')).toBeNull()
    })

    it('ignores impossible dates and other years', () => {
        expect(read('02.30.2026 | Depth Chart').date).toBeNull()
        expect(read('June 31').date).toBeNull()
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

    it('reads preseason only from "Preseason" or "PS" with a number', () => {
        expect(read('PS Week 1, Saturday, May 23').preseason).toBe(true)
        expect(read('x', 'https://x/PS-1-MONTREAL-DEPTH-CHART.pdf').preseason).toBe(true)
        expect(read('PRE-SEASON 2').preseason).toBe(true)
        expect(read('Depth Chart: PS at Lions').preseason).toBe(false)
        expect(read('x', 'https://x/TOR-vs-HAM-PS.pdf').preseason).toBe(false)
    })

    it('reads the playoff round', () => {
        expect(read('Western Semi-Final').round).toBe(1)
        expect(read('x', 'https://x/2026_Positional_Chart_-_WSF_at_BC_1.pdf').round).toBe(1)
        expect(read('Eastern FInal').round).toBe(2)
        expect(read('x', 'https://x/EAST_FINAL_MONTREAL_DEPTH_CHART.pdf').round).toBe(2)
        expect(read('Grey Cup').round).toBe(3)
        expect(read('Playoff push').round).toBeNull()
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
