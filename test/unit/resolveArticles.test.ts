import { describe, expect, it, vi } from 'vitest'
import { resolveArticlePdfs } from '~/services/depthCharts/scrape/resolveArticles.server'

const cfg = { linkHrefMatch: '/article/', pdfHrefMatch: '\\.pdf$' }
const A1 = 'https://goelks.com/article/1-depth-chart'
const A2 = 'https://goelks.com/article/2-depth-chart'
const article = (pdf: string | null) =>
    `<html><body>${pdf ? `<a href="${pdf}">View Depth Chart</a>` : '<p>soon</p>'}</body></html>`

const site = (pages: Record<string, string | Response>) =>
    vi.fn(async (url: string | URL | Request) => {
        const p = pages[String(url)]
        if (p === undefined) throw new Error(`unexpected fetch ${String(url)}`)
        return p instanceof Response ? p : new Response(p, { status: 200 })
    }) as unknown as typeof fetch

describe('resolveArticlePdfs', () => {
    it("swaps each article for the PDF it links, keeping the article as the item's page", async () => {
        const fetchImpl = site({ [A1]: article('https://static.cfl.ca/one.pdf') })
        expect(
            await resolveArticlePdfs([{ title: 'One', href: A1, page: A1 }], null, cfg, fetchImpl),
        ).toEqual([{ title: 'One', href: 'https://static.cfl.ca/one.pdf', page: A1 }])
    })

    it('reuses an article already resolved in the previous snapshot instead of fetching it', async () => {
        const fetchImpl = site({ [A2]: article('https://static.cfl.ca/two.pdf') })
        const previous = [{ title: 'One', href: 'https://static.cfl.ca/one.pdf', page: A1 }]
        const out = await resolveArticlePdfs(
            [
                { title: 'One', href: A1, page: A1 },
                { title: 'Two', href: A2, page: A2 },
            ],
            previous,
            cfg,
            fetchImpl,
        )
        expect(out.map((i) => i.href)).toEqual([
            'https://static.cfl.ca/one.pdf',
            'https://static.cfl.ca/two.pdf',
        ])
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('drops an article with no PDF, or that fails to load, without losing the rest', async () => {
        const fetchImpl = site({
            [A1]: article(null),
            [A2]: new Response('down', { status: 503 }),
            'https://goelks.com/article/3': article('https://static.cfl.ca/three.pdf'),
        })
        const out = await resolveArticlePdfs(
            [
                { title: 'One', href: A1, page: A1 },
                { title: 'Two', href: A2, page: A2 },
                {
                    title: 'Three',
                    href: 'https://goelks.com/article/3',
                    page: 'https://goelks.com/article/3',
                },
            ],
            null,
            cfg,
            fetchImpl,
        )
        expect(out.map((i) => i.title)).toEqual(['Three'])
    })
})
