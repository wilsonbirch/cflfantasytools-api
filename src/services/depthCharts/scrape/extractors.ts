// Extraction strategies for club depth-chart pages.
//
// 3DF had nine hand-written Puppeteer scrapers, ~17KB, with zero tests — the
// biggest DRY violation in that codebase and the part most likely to break
// silently when a club redesigns. Reading all nine, they differ in only four
// ways: the URL, how the DOM is walked, how the title is composed, and how the
// href is resolved. Three strategies cover all of them, parameterised per club
// in the TeamSource table.
//
// Every function here is PURE and takes a Document, so the exact code that runs
// in production also runs against a saved HTML fixture in a test. 3DF ran its
// logic inside page.evaluate(), where it could not be tested at all.

export type DepthChartItem = {
    title: string
    href: string
    // articleList only: the article the PDF was found in. Lets a later sweep
    // reuse the resolved href instead of re-fetching every article.
    page?: string
}

// A minimal structural view of the DOM, so these work identically under
// linkedom (server-side parse) and a real browser.
type El = {
    textContent: string | null
    getAttribute(name: string): string | null
    querySelector(sel: string): El | null
    querySelectorAll(sel: string): ArrayLike<El> & Iterable<El>
}
export type Doc = Pick<El, 'querySelector' | 'querySelectorAll'>

export type Strategy =
    'tableRowCells' | 'tableCellLookback' | 'cardList' | 'articleList' | 'composite'

export const STRATEGIES: readonly Strategy[] = [
    'tableRowCells',
    'tableCellLookback',
    'cardList',
    'articleList',
    'composite',
]

export const isStrategy = (v: unknown): v is Strategy =>
    typeof v === 'string' && (STRATEGIES as readonly string[]).includes(v)

const text = (el: El | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** Collapse whitespace and drop empty parts, so titles compare stably. */
export const normalizeTitle = (parts: string[]): string =>
    parts
        .map((p) => p.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(', ')

/**
 * Resolve an href against the club's origin and strip the query and fragment.
 *
 * The normalized href is the identity used for change detection, so a cache
 * buster or tracking parameter appended to an existing PDF must not read as a
 * newly posted chart.
 */
export function normalizeHref(origin: string, href: string): string | null {
    try {
        const url = new URL(href, origin)
        url.search = ''
        url.hash = ''
        return url.toString()
    } catch {
        return null
    }
}

// --- tableRowCells: clubs whose charts sit in a table row ------------------
// Title comes from a fixed set of cell indexes; the link from another cell.
export type TableRowCellsConfig = {
    titleCells: number[]
    linkCell: number
    minCells: number
    // Hamilton links many PDFs and only some are charts.
    hrefMustMatch?: string
    hrefMustInclude?: string[]
    // Hamilton also keeps prior-year tables on the page under their own heading.
    skipHeaderMatch?: string[]
}

function extractTableRowCells(
    doc: Doc,
    cfg: TableRowCellsConfig,
    origin: string,
): DepthChartItem[] {
    const out: DepthChartItem[] = []
    // Iterate TABLES, not tbodies: thead is a sibling of tbody, so a header
    // check has to start from the table. Hamilton keeps a prior-season table on
    // the same page under its own heading, and reading the header from inside
    // the tbody silently matched nothing — pulling in 2015 charts.
    for (const table of doc.querySelectorAll('table')) {
        if (cfg.skipHeaderMatch?.length) {
            const head = text(table.querySelector('thead'))
            if (cfg.skipHeaderMatch.some((m) => head.includes(m))) continue
        }
        for (const row of table.querySelectorAll('tr')) {
            const cells = [...row.querySelectorAll('td')]
            if (cells.length < cfg.minCells) continue

            const rawHref = cells[cfg.linkCell]?.querySelector('a')?.getAttribute('href')
            if (!rawHref) continue

            const href = normalizeHref(origin, rawHref)
            if (!href) continue

            // Filter the NORMALIZED href, not the raw one. Clubs sometimes wrap
            // links through a redirector (Outlook safelinks) whose query string
            // contains the real .pdf — matching the raw href would let those
            // through, and they are neither stable nor the actual document.
            if (cfg.hrefMustMatch && !new RegExp(cfg.hrefMustMatch, 'i').test(href)) continue
            if (cfg.hrefMustInclude?.length && !cfg.hrefMustInclude.some((s) => href.includes(s))) {
                continue
            }

            out.push({
                title: normalizeTitle(cfg.titleCells.map((i) => text(cells[i] ?? null))),
                href,
            })
        }
    }
    return out
}

// --- tableCellLookback: clubs with no row structure to rely on -------------
// Walk every cell; when one holds a link, the title is the N cells before it.
export type TableCellLookbackConfig = { lookback: number }

function extractTableCellLookback(
    doc: Doc,
    cfg: TableCellLookbackConfig,
    origin: string,
): DepthChartItem[] {
    const out: DepthChartItem[] = []
    for (const table of doc.querySelectorAll('table')) {
        const cells = [...table.querySelectorAll('td')]
        cells.forEach((cell, i) => {
            if (i < cfg.lookback) return
            const rawHref = cell.querySelector('a')?.getAttribute('href')
            if (!rawHref) return
            const href = normalizeHref(origin, rawHref)
            if (!href) return
            const preceding = cells.slice(i - cfg.lookback, i).map((c) => text(c))
            out.push({ title: normalizeTitle(preceding), href })
        })
    }
    return out
}

// --- cardList: clubs using a card layout rather than a table ---------------
export type CardListConfig = {
    cardSelector: string
    titleSelectors: string[]
    // Which link in the card is the chart, matched (case-insensitively) on the
    // link's text. Without it the card's first link is taken — which on the
    // 2026 club platform is "Game Preview", not the chart. Hamilton's cards
    // also link the OPPONENT's chart and game notes, so this must be specific.
    linkTextMatch?: string
    // Alternatively match on the normalized href — for a club whose button
    // text varies week to week (Ottawa: "Download Depth Chart", "Download",
    // "Depth Chart") but whose only PDF in the card is the chart.
    linkHrefMatch?: string
}

function extractCardList(doc: Doc, cfg: CardListConfig, origin: string): DepthChartItem[] {
    const out: DepthChartItem[] = []
    const linkText = cfg.linkTextMatch ? new RegExp(cfg.linkTextMatch, 'i') : null
    const linkHref = cfg.linkHrefMatch ? new RegExp(cfg.linkHrefMatch, 'i') : null
    const isChartLink = (a: El): boolean => {
        if (linkText && !linkText.test(text(a))) return false
        if (linkHref) {
            const href = normalizeHref(origin, a.getAttribute('href') ?? '')
            if (!href || !linkHref.test(href)) return false
        }
        return true
    }
    for (const card of doc.querySelectorAll(cfg.cardSelector)) {
        const link =
            linkText || linkHref
                ? ([...card.querySelectorAll('a')].find(isChartLink) ?? null)
                : card.querySelector('a')
        const rawHref = link?.getAttribute('href')
        if (!rawHref) continue
        const href = normalizeHref(origin, rawHref)
        if (!href) continue
        const parts = cfg.titleSelectors.map((sel) => text(card.querySelector(sel)))
        out.push({ title: normalizeTitle(parts.length ? parts : [text(card)]), href })
    }
    return out
}

// --- articleList: clubs that post each chart as its own article -----------
// Edmonton, from 2026: the chart page is a list of articles, one per game, and
// the PDF is linked from inside each article. This pass yields the ARTICLES;
// resolveArticlePdfs() then fetches each new one and swaps in its PDF, since
// that needs the network and every function in this file is pure.
export type ArticleListConfig = {
    // Matched against the normalized article URL.
    linkHrefMatch: string
    // Element inside the link that holds the title; falls back to the link text.
    titleSelector?: string
    // Matched against links inside an article to find the chart PDF.
    pdfHrefMatch?: string
}

function extractArticleList(doc: Doc, cfg: ArticleListConfig, origin: string): DepthChartItem[] {
    const out: DepthChartItem[] = []
    const match = new RegExp(cfg.linkHrefMatch, 'i')
    for (const a of doc.querySelectorAll('a')) {
        const rawHref = a.getAttribute('href')
        if (!rawHref) continue
        const href = normalizeHref(origin, rawHref)
        if (!href || !match.test(href)) continue
        const titleEl = cfg.titleSelector ? a.querySelector(cfg.titleSelector) : null
        out.push({ title: normalizeTitle([text(titleEl ?? a)]), href, page: href })
    }
    return out
}

/** The chart PDF linked from an article page, or null if it has none. */
export function findArticlePdf(doc: Doc, cfg: ArticleListConfig, origin: string): string | null {
    const match = new RegExp(cfg.pdfHrefMatch ?? '\\.pdf$', 'i')
    for (const a of doc.querySelectorAll('a')) {
        const href = normalizeHref(origin, a.getAttribute('href') ?? '')
        if (href && match.test(href)) return href
    }
    return null
}

// --- composite: a page that needs more than one strategy -------------------
// Hamilton, from 2026: the season's charts sit in a table, but the newest game
// is only on its own card. Results are unioned in order; a chart found by both
// keeps the first part's title, and the href dedupe below collapses it.
export type CompositeConfig = { parts: { strategy: Strategy; config: unknown }[] }

/**
 * Run a club's configured strategy over its page.
 *
 * Duplicate hrefs are collapsed: several clubs link the same PDF from more than
 * one place on the page, and counting it twice would look like two charts.
 */
export function extract(
    doc: Doc,
    strategy: Strategy,
    config: unknown,
    origin: string,
): DepthChartItem[] {
    const cfg = (config ?? {}) as Record<string, unknown>
    let items: DepthChartItem[]
    switch (strategy) {
        case 'tableRowCells':
            items = extractTableRowCells(doc, cfg as unknown as TableRowCellsConfig, origin)
            break
        case 'tableCellLookback':
            items = extractTableCellLookback(doc, cfg as unknown as TableCellLookbackConfig, origin)
            break
        case 'cardList':
            items = extractCardList(doc, cfg as unknown as CardListConfig, origin)
            break
        case 'articleList':
            items = extractArticleList(doc, cfg as unknown as ArticleListConfig, origin)
            break
        case 'composite':
            items = ((cfg as unknown as CompositeConfig).parts ?? [])
                // One level only: a part that is itself composite is ignored
                // rather than recursed into.
                .filter((p) => isStrategy(p.strategy) && p.strategy !== 'composite')
                .flatMap((p) => extract(doc, p.strategy, p.config, origin))
            break
    }
    const seen = new Set<string>()
    return items.filter((i) => (seen.has(i.href) ? false : (seen.add(i.href), true)))
}
