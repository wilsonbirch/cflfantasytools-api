/**
 * Save each club's depth-chart markup as a test fixture.
 *
 * Only the elements the extractors actually read are kept — a club page is
 * 150-800KB of navigation and marketing, and committing that to assert a cell
 * index would be absurd. Re-run this when a club redesigns: the diff in the
 * fixture is the evidence of what changed, and the failing test tells you which
 * config needs updating.
 *
 *   npx tsx scripts/captureScrapeFixtures.ts [ABBR]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { TEAMS } from '~/data/teams'
import { fetchPage } from '~/services/depthCharts/scrape/fetchPage.server'

const DIR = 'test/fixtures/depth-charts'
mkdirSync(DIR, { recursive: true })

const only = process.argv[2]?.toUpperCase()
const targets = only ? TEAMS.filter((t) => t.abbreviation === only) : TEAMS

for (const team of targets) {
    try {
        const doc = await fetchPage(team.depthChartUrl, team.requiresBrowser)
        const selector =
            team.strategy === 'cardList'
                ? ((team.config as { cardSelector: string }).cardSelector ?? '.depth-card')
                : 'table'
        const nodes = [
            ...(doc.querySelectorAll(selector) as unknown as Iterable<{ outerHTML: string }>),
        ]
        const html =
            `<!-- ${team.abbreviation} — trimmed from ${team.depthChartUrl} -->\n` +
            `<!-- captured ${new Date().toISOString().slice(0, 10)}; ${nodes.length} node(s) -->\n` +
            nodes.map((n) => n.outerHTML).join('\n')
        writeFileSync(`${DIR}/${team.slug}.html`, html)
        console.log(`${team.abbreviation.padEnd(4)} ${nodes.length} node(s), ${html.length} bytes`)
    } catch (err) {
        console.error(`${team.abbreviation}: ${err instanceof Error ? err.message : err}`)
    }
}
