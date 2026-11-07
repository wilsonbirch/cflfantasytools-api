import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { TEAMS } from '~/data/teams'
import {
    extract,
    findArticlePdf,
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

const html = (markup: string): Doc =>
    parseHTML(`<html><body>${markup}</body></html>`).document as unknown as Doc

describe('Hamilton specifics (2026 platform: season table + newest-game cards)', () => {
    const ham = TEAMS.find((t) => t.abbreviation === 'HAM')!
    const items = extract(load(ham.slug), 'composite', ham.config, 'https://ticats.ca')

    it('finds the season table carried only in the page payload', () => {
        expect(items.some((i) => i.href.endsWith('HAM-Depth-Roster-W1-v-MTL-June-4.pdf'))).toBe(
            true,
        )
    })

    it('finds Game 18, which exists only as a card linked "Depth & Roster"', () => {
        expect(items.some((i) => i.title.startsWith('Game 18'))).toBe(true)
    })

    it("tracks Hamilton's chart only — never the opponent's or the game notes", () => {
        // Every card links all three; picking the wrong one would double the
        // count and file other clubs' charts under Hamilton.
        expect(items).toHaveLength(15)
        expect(items.some((i) => /Gm_Notes|Game_Notes/i.test(i.href))).toBe(false)
        expect(
            items.some((i) => /^(OTT|Week_14_TOR)_Depth/.test(i.href.split('/').pop() ?? '')),
        ).toBe(false)
    })
})

describe('Ottawa specifics', () => {
    const ott = TEAMS.find((t) => t.abbreviation === 'OTT')!
    const items = extract(load(ott.slug), 'cardList', ott.config, 'https://ottawaredblacks.com')

    it('finds every chart whatever the button says that week', () => {
        // "Download Depth Chart" until July, then "Depth Chart" and "Download".
        expect(items).toHaveLength(13)
        expect(items.at(-1)?.href).toMatch(/WK21\.DEPTHCHART\.pdf$/)
    })

    it('needs no browser any more', () => {
        expect(ott.requiresBrowser).toBe(false)
    })
})

describe('tableRowCells options', () => {
    const row = (title: string, href: string) =>
        `<tr><td>${title}</td><td>d</td><td>t</td><td>x</td><td><a href="${href}">c</a></td></tr>`
    const cfg = {
        titleCells: [0, 1, 2],
        linkCell: 4,
        minCells: 5,
        hrefMustMatch: '\\.pdf$',
        skipHeaderMatch: ['Prior Season'],
    }

    it('skips a table whose header marks it as another season', () => {
        const doc = html(
            `<table><thead><tr><th>Prior Season</th></tr></thead><tbody>${row('Old', '/2015/a.pdf')}</tbody></table>` +
                `<table><thead><tr><th>2026</th></tr></thead><tbody>${row('New', '/2026/b.pdf')}</tbody></table>`,
        )
        expect(extract(doc, 'tableRowCells', cfg, 'https://x.test').map((i) => i.href)).toEqual([
            'https://x.test/2026/b.pdf',
        ])
    })

    it('rejects a link wrapped in a redirector, whose query string carries the .pdf', () => {
        const safelink =
            'https://nam.safelinks.protection.outlook.com/?url=https%3A%2F%2Fx.test%2Fa.pdf'
        const doc = html(`<table><tbody>${row('Wrapped', safelink)}</tbody></table>`)
        expect(extract(doc, 'tableRowCells', cfg, 'https://x.test')).toEqual([])
    })
})

describe('cardList link selection', () => {
    const card = (links: string) => `<div class="card"><h3>Week 1</h3>${links}</div>`

    it('takes the first link when nothing narrows it', () => {
        const doc = html(
            card('<a href="/preview">Game Preview</a><a href="/c.pdf">Depth Chart</a>'),
        )
        const items = extract(
            doc,
            'cardList',
            { cardSelector: '.card', titleSelectors: ['h3'] },
            'https://x.test',
        )
        expect(items[0].href).toBe('https://x.test/preview')
    })

    it('picks the link whose text matches, skipping "Game Preview" and the opponent', () => {
        const doc = html(
            card(
                '<a href="/preview">Game Preview</a><a href="/opp.pdf">Opponent Depth &amp; Roster</a>' +
                    '<a href="/ham.pdf">Hamilton Depth &amp; Roster</a>',
            ),
        )
        const items = extract(
            doc,
            'cardList',
            {
                cardSelector: '.card',
                titleSelectors: ['h3'],
                linkTextMatch: '^(Hamilton )?Depth & Roster',
            },
            'https://x.test',
        )
        expect(items).toEqual([{ title: 'Week 1', href: 'https://x.test/ham.pdf' }])
    })

    it('picks the link whose href matches, and skips a card without one', () => {
        const doc = html(
            card('<a href="/preview">Preview</a><a href="/c.pdf?v=2">Download</a>') +
                card('<a href="/nav">Depth Charts</a>'),
        )
        const items = extract(
            doc,
            'cardList',
            { cardSelector: '.card', titleSelectors: ['h3'], linkHrefMatch: '\\.pdf$' },
            'https://x.test',
        )
        expect(items).toEqual([{ title: 'Week 1', href: 'https://x.test/c.pdf' }])
    })
})

describe('composite', () => {
    const doc = html(
        '<table><tr><td>G1</td><td>a</td><td>b</td><td>c</td><td><a href="/g1.pdf">x</a></td></tr></table>' +
            '<div class="card"><h3>G1 again</h3><a href="/g1.pdf">Depth</a></div>' +
            '<div class="card"><h3>G2</h3><a href="/g2.pdf">Depth</a></div>',
    )
    const table = {
        strategy: 'tableRowCells',
        config: { titleCells: [0], linkCell: 4, minCells: 5 },
    }
    const cards = {
        strategy: 'cardList',
        config: { cardSelector: '.card', titleSelectors: ['h3'] },
    }

    it('unions its parts, the first part winning a chart both find', () => {
        expect(extract(doc, 'composite', { parts: [table, cards] }, 'https://x.test')).toEqual([
            { title: 'G1', href: 'https://x.test/g1.pdf' },
            { title: 'G2', href: 'https://x.test/g2.pdf' },
        ])
    })

    it('ignores a nested composite rather than recursing', () => {
        const nested = { strategy: 'composite', config: { parts: [cards] } }
        expect(extract(doc, 'composite', { parts: [nested] }, 'https://x.test')).toEqual([])
    })
})

describe('articleList', () => {
    const cfg = {
        linkHrefMatch: '/article/[^/]*depth-chart',
        titleSelector: 'p.t',
        pdfHrefMatch: '\\.pdf$',
    }

    it('yields each matching article, keeping it as the page to resolve', () => {
        const doc = html(
            '<a href="/article/11-07-2026-depth-chart-vs-bc"><p class="tag">Depth</p><p class="t">Depth Chart: VS BC</p></a>' +
                '<a href="/article/some-recap">Recap</a>',
        )
        expect(extract(doc, 'articleList', cfg, 'https://goelks.com')).toEqual([
            {
                title: 'Depth Chart: VS BC',
                href: 'https://goelks.com/article/11-07-2026-depth-chart-vs-bc',
                page: 'https://goelks.com/article/11-07-2026-depth-chart-vs-bc',
            },
        ])
    })

    it('finds the PDF inside an article, or null when there is none', () => {
        const article = html(
            '<a href="/x">Share</a><a href="https://static.cfl.ca/a.pdf">View Depth Chart</a>',
        )
        expect(findArticlePdf(article, cfg, 'https://goelks.com')).toBe(
            'https://static.cfl.ca/a.pdf',
        )
        expect(findArticlePdf(html('<p>no chart</p>'), cfg, 'https://goelks.com')).toBeNull()
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
