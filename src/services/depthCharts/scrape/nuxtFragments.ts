// Club pages on the 2026 CFL platform are Nuxt apps. Most content is
// server-rendered, but rich-text fields that hold raw HTML — Hamilton's whole
// season of charts is one such <table> — travel only inside the __NUXT_DATA__
// payload and are rendered in the browser. A plain fetch never sees them in
// the DOM.
//
// Rather than launch Chromium for that, append those fragments to the page as
// ordinary markup, so the extractors read them like any other table.

const NUXT_DATA = /<script[^>]*\bid="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/

/** HTML tables carried as strings in the page's Nuxt payload. */
export function nuxtHtmlFragments(html: string): string[] {
    const m = html.match(NUXT_DATA)
    if (!m) return []
    let values: unknown
    try {
        values = JSON.parse(m[1])
    } catch {
        return []
    }
    if (!Array.isArray(values)) return []
    return values.filter((v): v is string => typeof v === 'string' && /<table[\s>]/i.test(v))
}

/** The page with its payload-only HTML fragments appended to the body. */
export function inlineNuxtFragments(html: string): string {
    const fragments = nuxtHtmlFragments(html)
    if (fragments.length === 0) return html
    const block = fragments.map((f) => `<div data-nuxt-fragment>${f}</div>`).join('\n')
    return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${block}</body>`) : html + block
}
