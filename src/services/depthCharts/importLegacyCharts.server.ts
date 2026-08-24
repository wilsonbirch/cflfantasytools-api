// Import 2024/2025 depth-chart records from the legacy 3 Down Fantasy database.
//
// The dump holds 344 chart hrefs across 18 team-seasons — including 2025, a
// season the play-by-play feed cannot recover. Like the games import, this is
// a SCRIPT concern: the legacy Postgres is only reachable from a machine with
// a local restore (scripts/importLegacyDepthCharts.ts). PDF bytes are NOT
// fetched here — the caller runs archiveChartFiles/parseChartPositions after,
// so one archive path owns every PDF ever stored.
//
// `publishedAt` matters more than it looks: gameAlignments() matches a chart
// to a game through a ten-day window before kickoff, so a wrong publishedAt
// silently removes the chart from every alignment. The 2024 rows were
// backfilled into 3DF in one batch (createdAt = 2024-11-27, months after the
// season), so createdAt is unusable there and the date is derived instead:
// from the game date in the title where one is printed, else from the team's
// Nth game of the season ("Game 14, SSK, CGY" — Calgary titles carry no date),
// else createdAt as the last resort (fine for 2025, which was scraped live).

import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'

const fileName = 'services/depthCharts/importLegacyCharts'

export type LegacyChartRow = {
    id: number
    teamId: number
    title: string
    value: string
    year: number
    season: string
    week: number
    createdAt: Date
}

export type LegacyChartData = {
    teams: { id: number; geniusTeamId: string }[]
    lists: { teamId: number; year: number; value: string }[]
    charts: LegacyChartRow[]
}

/** Injected so the logic is testable without a second Postgres. */
export type LegacyChartReader = () => Promise<LegacyChartData>

const MONTHS: Record<string, number> = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
}

/**
 * The game date printed in a chart title, if any: "Week 5, Sat. July 6," /
 * "WEEK 2, FRI JUN 13 7:30 PM EDT, MTL @ OTT" / "3, Jun 20, 2024". The year
 * comes from the chart row — titles rarely print it. PURE.
 */
export function titleDate(title: string, year: number): Date | null {
    const m = title.match(
        /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i,
    )
    if (!m) return null
    const day = Number(m[2])
    if (day < 1 || day > 31) return null
    // Noon UTC: the exact hour never matters, only which day it lands on.
    return new Date(Date.UTC(year, MONTHS[m[1].toLowerCase()], day, 12))
}

/** "Game 14, SSK, CGY" / "Pre-Season Game 1, BC, CGY" -> the team game number. */
export function gameNumber(title: string): { n: number; pre: boolean } | null {
    const m = title.match(/\b(pre-season\s+)?game\s+(\d{1,2})\b/i)
    return m ? { n: Number(m[2]), pre: m[1] !== undefined } : null
}

export type ChartImportSummary = {
    read: number
    imported: number
    skippedExisting: number
    unknownTeam: number
    datedFromTitle: number
    datedFromGame: number
    datedFromCreatedAt: number
}

/**
 * Copy legacy chart records into DepthChartList/DepthChart. Idempotent: a
 * chart whose href already exists for the team is left alone, so re-running
 * after a partial failure never duplicates, and a chart the sweep already
 * found is never overwritten.
 */
export async function importLegacyCharts(read: LegacyChartReader): Promise<ChartImportSummary> {
    const data = await read()
    const summary: ChartImportSummary = {
        read: data.charts.length,
        imported: 0,
        skippedExisting: 0,
        unknownTeam: 0,
        datedFromTitle: 0,
        datedFromGame: 0,
        datedFromCreatedAt: 0,
    }

    const ourTeams = await db.team.findMany({ select: { id: true, geniusTeamId: true } })
    const ourByGenius = new Map(
        ourTeams.flatMap((t) => (t.geniusTeamId ? [[t.geniusTeamId, t.id] as const] : [])),
    )
    const legacyToOurs = new Map(
        data.teams.flatMap((t) => {
            const ours = ourByGenius.get(t.geniusTeamId)
            return ours === undefined ? [] : [[t.id, ours] as const]
        }),
    )

    // Every game each club played, by year, kickoff ascending — the fallback
    // axis for titles that carry a game number instead of a date.
    const years = [...new Set(data.charts.map((c) => c.year))]
    const games = await db.game.findMany({
        where: { year: { in: years }, startedAt: { not: null } },
        select: { year: true, startedAt: true, homeGeniusTeamId: true, awayGeniusTeamId: true },
        orderBy: { startedAt: 'asc' },
    })
    const gamesOf = new Map<string, Date[]>()
    for (const g of games) {
        for (const genius of [g.homeGeniusTeamId, g.awayGeniusTeamId]) {
            if (!genius) continue
            const key = `${genius}|${g.year}`
            gamesOf.set(key, [...(gamesOf.get(key) ?? []), g.startedAt!])
        }
    }

    // How many preseason games a team-season's chart set numbers, so that
    // "Game N" (regular) is the (pre + N)th game chronologically.
    const preCount = new Map<string, number>()
    for (const c of data.charts) {
        const g = gameNumber(c.title)
        if (!g?.pre) continue
        const key = `${c.teamId}|${c.year}`
        preCount.set(key, Math.max(preCount.get(key) ?? 0, g.n))
    }

    const publishedAtFor = (
        chart: LegacyChartRow,
        geniusTeamId: string,
    ): { at: Date; source: 'title' | 'game' | 'createdAt' } => {
        const fromTitle = titleDate(chart.title, chart.year)
        if (fromTitle) return { at: fromTitle, source: 'title' }
        const g = gameNumber(chart.title)
        const kickoffs = gamesOf.get(`${geniusTeamId}|${chart.year}`) ?? []
        if (g) {
            const index = g.pre
                ? g.n - 1
                : (preCount.get(`${chart.teamId}|${chart.year}`) ?? 0) + g.n - 1
            const kickoff = kickoffs[index]
            if (kickoff) {
                // The day before kickoff, which is when clubs post charts.
                return { at: new Date(kickoff.getTime() - 24 * 60 * 60 * 1000), source: 'game' }
            }
        }
        return { at: chart.createdAt, source: 'createdAt' }
    }

    const legacyListValue = new Map(data.lists.map((l) => [`${l.teamId}|${l.year}`, l.value]))
    const listIds = new Map<string, number>()
    const listIdFor = async (legacyTeamId: number, ourTeamId: number, year: number) => {
        const key = `${ourTeamId}|${year}`
        const known = listIds.get(key)
        if (known !== undefined) return known
        let value: unknown = []
        try {
            value = JSON.parse(legacyListValue.get(`${legacyTeamId}|${year}`) ?? '[]')
        } catch {
            // A list snapshot that does not parse is cosmetic — the charts matter.
        }
        const list = await db.depthChartList.upsert({
            where: { teamId_year: { teamId: ourTeamId, year } },
            update: {},
            create: { teamId: ourTeamId, year, value: value as object },
        })
        listIds.set(key, list.id)
        return list.id
    }

    for (const chart of data.charts) {
        const ourTeamId = legacyToOurs.get(chart.teamId)
        if (ourTeamId === undefined) {
            summary.unknownTeam += 1
            logger.warn(fileName, `chart ${chart.id}: legacy team ${chart.teamId} is unknown here`)
            continue
        }
        const existing = await db.depthChart.findFirst({
            where: { teamId: ourTeamId, value: chart.value },
            select: { id: true },
        })
        if (existing) {
            summary.skippedExisting += 1
            continue
        }
        const genius = ourTeams.find((t) => t.id === ourTeamId)!.geniusTeamId!
        const { at, source } = publishedAtFor(chart, genius)
        summary[
            source === 'title'
                ? 'datedFromTitle'
                : source === 'game'
                  ? 'datedFromGame'
                  : 'datedFromCreatedAt'
        ] += 1
        await db.depthChart.create({
            data: {
                teamId: ourTeamId,
                depthChartListId: await listIdFor(chart.teamId, ourTeamId, chart.year),
                title: chart.title,
                value: chart.value,
                year: chart.year,
                season: chart.season,
                week: chart.week,
                publishedAt: at,
            },
        })
        summary.imported += 1
    }

    logger.info(
        fileName,
        `imported ${summary.imported} of ${summary.read} legacy chart(s): ` +
            `${summary.skippedExisting} already present, ${summary.unknownTeam} unknown team; ` +
            `publishedAt from title ${summary.datedFromTitle}, game ${summary.datedFromGame}, ` +
            `createdAt ${summary.datedFromCreatedAt}`,
    )
    return summary
}
