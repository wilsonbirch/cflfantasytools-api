import { parseHTML } from 'linkedom'
import { logger } from '~/lib/logger.server'
import type { Doc } from './extractors'

const fileName = 'services/depthCharts/scrape/fetchPage'

// Puppeteer is a last resort. Most club pages are server-rendered, so a plain
// fetch plus a server-side parse is faster, cheaper and — because the extractor
// then receives an ordinary Document — testable against a saved fixture.
// 3DF launched Chromium for all nine clubs, which is why its production
// container needed SYS_ADMIN and an unconfined seccomp profile.
export async function fetchPage(
    url: string,
    requiresBrowser: boolean,
    fetchImpl: typeof fetch = fetch,
): Promise<Doc> {
    const html = requiresBrowser ? await renderWithBrowser(url) : await fetchHtml(url, fetchImpl)
    return parseHTML(html).document as unknown as Doc
}

async function fetchHtml(url: string, fetchImpl: typeof fetch): Promise<string> {
    const res = await fetchImpl(url, {
        headers: {
            // Some club sites serve a stub to unrecognised agents.
            'user-agent':
                'Mozilla/5.0 (compatible; cflfantasytools/1.0; +https://cflfantasytools.ca)',
            accept: 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return res.text()
}

/**
 * Render a page that genuinely needs JavaScript.
 *
 * Imported lazily so the web process — which never scrapes — does not pay to
 * load Puppeteer, and so a machine without Chromium can still run everything else.
 */
async function renderWithBrowser(url: string): Promise<string> {
    const puppeteer = (await import('puppeteer')).default
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    try {
        const page = await browser.newPage()
        await page.setViewport({ width: 1280, height: 1024 })
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 })
        return await page.content()
    } finally {
        await browser.close().catch((err) => logger.warn(fileName, `browser close: ${String(err)}`))
    }
}
