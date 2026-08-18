import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { TEAMS } from '~/data/teams'
import {
    extract,
    normalizeHref,
    normalizeTitle,
    type Doc,
    type Strategy,
} from '~/services/depthCharts/scrape/extractors'

// Golden tests over real club markup. 3DF's nine scrapers ran inside
// page.evaluate(), where they could not be tested at all — this is the same code
// that runs in production, against a saved copy of the same page.
//
// When a club redesigns, the failing test names it and the fixture diff shows
// what changed. Refresh with: npx tsx scripts/captureScrapeFixtures.ts <ABBR>
const load = (slug: string): Doc =>
    parseHTML(readFileSync(`test/fixtures/depth-charts/${slug}.html`, 'utf8'))
        .document as unknown as Doc

describe.each(TEAMS.map((t) => [t.abbreviation, t] as const))('%s', (abbr, team) => {
    const items = extract(
        load(team.slug),
        team.strategy as Strategy,
        team.config,
        new URL(team.depthChartUrl).origin,
    )

    it('extracts a plausible number of charts', () => {
        // Roughly one per game played, plus preseason. Zero means the config is
        // broken; hundreds means it is matching unrelated links.
        expect(items.length).toBeGreaterThan(3)
        expect(items.length).toBeLessThan(40)
    })

    it('gives every chart an absolute href and a non-empty title', () => {
        for (const item of items) {
            expect(item.href).toMatch(/^https?:\/\//)
            expect(item.title.length).toBeGreaterThan(0)
        }
    })

    it('produces no duplicate hrefs', () => {
        // Several clubs link the same PDF twice; counting it twice would look
        // like two separate postings.
        expect(new Set(items.map((i) => i.href)).size).toBe(items.length)
    })

    it('strips query strings, so a cache buster is not a new chart', () => {
        for (const item of items) expect(item.href).not.toContain('?')
    })
})

describe('Hamilton specifics', () => {
    const ham = TEAMS.find((t) => t.abbreviation === 'HAM')!
    const items = extract(load(ham.slug), 'tableRowCells', ham.config, 'https://www.ticats.ca')

    it('skips the prior-season table kept on the same page', () => {
        // That table's rows link 2015-era uploads and are titled "CLICK HERE".
        expect(items.some((i) => i.href.includes('/2015/'))).toBe(false)
        expect(items.some((i) => i.title.includes('CLICK HERE'))).toBe(false)
    })

    it('rejects a link wrapped in a redirector', () => {
        // An Outlook safelink carries the real .pdf in its query string, so
        // filtering the raw href would let it through.
        expect(items.some((i) => i.href.includes('safelinks'))).toBe(false)
    })

    it('keeps only PDFs', () => {
        for (const item of items) expect(item.href).toMatch(/\.pdf$/i)
    })
})

describe('normalizeHref', () => {
    it('resolves a relative href against the club origin', () => {
        expect(normalizeHref('https://x.test', '/a/b.pdf')).toBe('https://x.test/a/b.pdf')
    })

    it('drops query and fragment so identity is stable', () => {
        expect(normalizeHref('https://x.test', '/a.pdf?v=2#page=3')).toBe('https://x.test/a.pdf')
    })

    it('returns null for something unparseable rather than throwing', () => {
        expect(normalizeHref('not a url', 'also not a url')).toBeNull()
    })
})

describe('normalizeTitle', () => {
    it('collapses whitespace and drops empty parts', () => {
        expect(normalizeTitle(['  Week   1 ', '', ' Sat '])).toBe('Week 1, Sat')
    })
})
