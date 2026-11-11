import { db } from '~/lib/db.server'
import { seasonGameweeks } from '~/services/gamezone/gameweeks.server'
import {
    deriveChartWeek,
    firstSeenWeek,
    type ChartSchedule,
    type ChartSeason,
    type ChartWeekSource,
    type ScheduleGameweek,
} from './chartWeek'
import type { DepthChartItem } from './scrape/extractors'
import type { DepthChartInfo } from './season.server'

/**
 * A season's gameweeks (with ordinals and status) and every scheduled match
 * with a date, as deriveChartWeek wants them. Both come from the Game Zone
 * feed; a season it has not given us yet is simply empty.
 */
export async function loadChartSchedule(
    year: number,
): Promise<ChartSchedule & { gameweeks: (ScheduleGameweek & { status: string })[] }> {
    const gameweeks = await seasonGameweeks(year)
    const ordinal = new Map(gameweeks.map((g) => [g.id, g.week]))
    const matches = await db.match.findMany({
        where: { year, date: { not: null } },
        select: {
            date: true,
            gameweekId: true,
            HomeTeam: { select: { abbreviation: true } },
            AwayTeam: { select: { abbreviation: true } },
        },
    })
    return {
        gameweeks,
        matches: matches.flatMap((m) => {
            const week = ordinal.get(m.gameweekId)
            return week === undefined
                ? []
                : [
                      {
                          home: m.HomeTeam?.abbreviation ?? null,
                          away: m.AwayTeam?.abbreviation ?? null,
                          date: m.date!,
                          week,
                      },
                  ]
        }),
    }
}

/**
 * Season and week for each newly found chart, in order: what the chart says
 * about its game, else the week it was first seen.
 */
export async function weeksForNewCharts(
    teamId: number,
    year: number,
    items: DepthChartItem[],
    now = new Date(),
): Promise<DepthChartInfo[]> {
    if (items.length === 0) return []
    const schedule = await loadChartSchedule(year)
    const { abbreviation: team } = await db.team.findUniqueOrThrow({
        where: { id: teamId },
        select: { abbreviation: true },
    })
    const seen = firstSeenWeek(schedule.gameweeks, now)
    return items.map((item) => {
        const derived = deriveChartWeek(
            { team, year, title: item.title, href: item.href, page: item.page },
            schedule,
        )
        return derived ? { season: derived.season, week: derived.week } : seen
    })
}

export type RederivedChart = {
    id: number
    team: string
    title: string
    old: { season: string; week: number }
    /** Null when the chart says nothing usable: it is left as it is. */
    new: { season: ChartSeason; week: number } | null
    source: ChartWeekSource | null
    evidence: string
    changed: boolean
}

/**
 * Recompute season and week for a season's stored charts from their titles
 * and hrefs. Writes only when `apply` is set, and then only the rows that
 * change — DepthChart and the week copied onto its DepthChartPosition rows,
 * one transaction per chart.
 */
export async function rederiveChartWeeks(opts: {
    year: number
    team?: string
    apply: boolean
}): Promise<RederivedChart[]> {
    const schedule = await loadChartSchedule(opts.year)
    const charts = await db.depthChart.findMany({
        where: {
            year: opts.year,
            ...(opts.team ? { Team: { abbreviation: opts.team } } : {}),
        },
        select: {
            id: true,
            title: true,
            value: true,
            year: true,
            season: true,
            week: true,
            Team: { select: { abbreviation: true } },
        },
        orderBy: [{ teamId: 'asc' }, { publishedAt: 'asc' }, { id: 'asc' }],
    })

    const out: RederivedChart[] = []
    for (const c of charts) {
        const derived = deriveChartWeek(
            { team: c.Team.abbreviation, year: c.year, title: c.title, href: c.value },
            schedule,
        )
        const changed = derived !== null && (derived.week !== c.week || derived.season !== c.season)
        out.push({
            id: c.id,
            team: c.Team.abbreviation,
            title: c.title,
            old: { season: c.season, week: c.week },
            new: derived && { season: derived.season, week: derived.week },
            source: derived?.source ?? null,
            evidence: derived?.evidence ?? 'no date, week or preseason marker; left as is',
            changed,
        })
        if (opts.apply && changed && derived) {
            await db.$transaction([
                db.depthChart.update({
                    where: { id: c.id },
                    data: { week: derived.week, season: derived.season },
                }),
                db.depthChartPosition.updateMany({
                    where: { depthChartId: c.id },
                    data: { week: derived.week },
                }),
            ])
        }
    }
    return out
}
