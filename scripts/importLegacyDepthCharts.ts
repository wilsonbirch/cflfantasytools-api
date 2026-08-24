/**
 * Import the 344 legacy 3DF depth-chart records (2024/2025), then fetch and
 * parse their PDFs through the same archive path the sweep uses.
 *
 * Needs LEGACY_DATABASE_URL (the local dump restore) and DATABASE_URL (the
 * target — prod via the tunnel, or a local database). PDF fetching hits
 * static.cfl.ca once per chart without an archived copy; pass --no-fetch to
 * import the records only.
 *
 *   npx tsx --env-file-if-exists=/dev/null scripts/importLegacyDepthCharts.ts [--no-fetch]
 */
import { Client } from 'pg'
import { db } from '~/lib/db.server'
import { archiveChartFiles } from '~/services/depthCharts/archiveFiles.server'
import {
    importLegacyCharts,
    type LegacyChartData,
} from '~/services/depthCharts/importLegacyCharts.server'
import { parseChartPositions } from '~/services/depthCharts/parsePositions.server'

const legacyUrl = process.env.LEGACY_DATABASE_URL
const targetUrl = process.env.DATABASE_URL

if (!legacyUrl) {
    console.error('LEGACY_DATABASE_URL is not set (see .env.example)')
    process.exit(1)
}
if (!targetUrl) {
    console.error('DATABASE_URL is not set — nothing to import into')
    process.exit(1)
}

const sameHost = (a: string, b: string): boolean => {
    try {
        const ua = new URL(a)
        const ub = new URL(b)
        return ua.host === ub.host && ua.pathname === ub.pathname
    } catch {
        return false
    }
}
if (sameHost(legacyUrl, targetUrl)) {
    console.error('LEGACY_DATABASE_URL and DATABASE_URL point at the same database — refusing')
    process.exit(1)
}

const noFetch = process.argv.includes('--no-fetch')

async function readLegacy(): Promise<LegacyChartData> {
    const client = new Client({ connectionString: legacyUrl })
    await client.connect()
    try {
        const teams = await client.query<{ id: number; geniusTeamId: string }>(
            'SELECT id, "geniusTeamId" FROM "Team"',
        )
        const lists = await client.query<{ teamId: number; year: number; value: string }>(
            'SELECT "teamId", year, value FROM "DepthChartList"',
        )
        const charts = await client.query(
            'SELECT id, "teamId", title, value, year, season, week, "createdAt" FROM "DepthChart" ORDER BY id',
        )
        return { teams: teams.rows, lists: lists.rows, charts: charts.rows }
    } finally {
        await client.end()
    }
}

async function main(): Promise<void> {
    const summary = await importLegacyCharts(readLegacy)
    console.log(JSON.stringify(summary))

    if (noFetch) {
        console.log('--no-fetch: records imported, PDFs not fetched')
        process.exit(0)
    }

    // Archive and parse per team-season, exactly as the sweep does for the
    // current year. Sequential on purpose — one polite pass over static.cfl.ca.
    // Scoped to the legacy years: the sweep owns the current season.
    const seasons = await db.depthChart.groupBy({
        by: ['teamId', 'year'],
        where: { year: { lt: 2026 } },
    })
    for (const s of seasons.sort((a, b) => a.teamId - b.teamId || a.year - b.year)) {
        const archived = await archiveChartFiles(s.teamId, s.year)
        const parsed = await parseChartPositions(s.teamId, s.year)
        console.log(
            `team ${s.teamId} year ${s.year}: fetched ${archived.fetched}, archived ${archived.archived}, ` +
                `failed ${archived.failed}; parsed ${parsed.parsed}, ok ${parsed.ok}, ` +
                `unsupported ${parsed.unsupported}, failed ${parsed.failed}`,
        )
    }
    process.exit(0)
}

void main()
