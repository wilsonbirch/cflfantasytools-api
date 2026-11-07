import { describe, expect, it } from 'vitest'
import { inlineNuxtFragments, nuxtHtmlFragments } from '~/services/depthCharts/scrape/nuxtFragments'

const page = (values: unknown[], body = '<main>page</main>') =>
    `<html><body>${body}<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(values)}</script></body></html>`

describe('nuxtHtmlFragments', () => {
    it('returns the HTML tables carried as strings in the payload', () => {
        const table = '<table><tr><td>Game 1</td></tr></table>'
        expect(nuxtHtmlFragments(page([{ a: 1 }, table, 'plain text', '<p>no table</p>']))).toEqual(
            [table],
        )
    })

    it('returns nothing for a page without a payload, or a broken one', () => {
        expect(nuxtHtmlFragments('<html><body>x</body></html>')).toEqual([])
        expect(nuxtHtmlFragments('<script id="__NUXT_DATA__">{oops</script>')).toEqual([])
    })
})

describe('inlineNuxtFragments', () => {
    it('appends the fragments to the body so a DOM parse sees them', () => {
        const out = inlineNuxtFragments(page(['<table><tr><td>T</td></tr></table>']))
        expect(out).toMatch(/<div data-nuxt-fragment><table>.*<\/table><\/div><\/body>/s)
    })

    it('leaves a page with no fragments untouched', () => {
        const html = page(['nothing here'])
        expect(inlineNuxtFragments(html)).toBe(html)
    })
})
