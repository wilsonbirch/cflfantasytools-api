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
import type { Doc } from '~/services/depthCharts/scrape/extractors'
import { fetchPage } from '~/services/depthCharts/scrape/fetchPage.server'

const DIR = 'test/fixtures/depth-charts'
mkdirSync(DIR, { recursive: true })

type Node = { outerHTML: string; getAttribute(name: string): string | null }
type Part = { strategy: string; config: unknown }

/** The elements a strategy reads — everything else on the page is noise. */
function keptNodes(doc: Doc, strategy: string, config: unknown): Node[] {
    const all = (sel: string) => [...(doc.querySelectorAll(sel) as unknown as Iterable<Node>)]
    switch (strategy) {
        case 'cardList':
            return all((config as { cardSelector: string }).cardSelector)
        case 'articleList': {
            const match = new RegExp((config as { linkHrefMatch: string }).linkHrefMatch, 'i')
            return all('a').filter((a) => match.test(a.getAttribute('href') ?? ''))
        }
        case 'composite':
            return [
                ...new Set(
                    (config as { parts: Part[] }).parts.flatMap((p) =>
                        keptNodes(doc, p.strategy, p.config),
                    ),
                ),
            ]
        default:
            return all('table')
    }
}

const only = process.argv[2]?.toUpperCase()
const targets = only ? TEAMS.filter((t) => t.abbreviation === only) : TEAMS

for (const team of targets) {
    try {
        // fetchPage inlines payload-only HTML (Hamilton's season table), so the
        // fixture holds exactly what the extractor saw.
        const doc = await fetchPage(team.depthChartUrl)
        const nodes = keptNodes(doc, team.strategy, team.config)
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
