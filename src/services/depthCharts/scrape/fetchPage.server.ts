import { parseHTML } from 'linkedom'
import { HttpStatusError } from '~/lib/jobErrors.server'
import type { Doc } from './extractors'
import { inlineNuxtFragments } from './nuxtFragments'

// Every club page is fetched with plain HTTP and parsed server-side, which is
// fast, cheap and — because the extractor then receives an ordinary Document —
// testable against a saved fixture. There is no browser path any more: Ottawa,
// the one client-rendered club, moved onto the CFL's server-rendered platform
// in 2026, and the content that platform renders only from its payload is
// inlined by inlineNuxtFragments instead. 3DF launched Chromium for all nine
// clubs, which is why its production container needed SYS_ADMIN and an
// unconfined seccomp profile.
export async function fetchPage(url: string, fetchImpl: typeof fetch = fetch): Promise<Doc> {
    const html = await fetchHtml(url, fetchImpl)
    return parseHTML(inlineNuxtFragments(html)).document as unknown as Doc
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
    // Classified here, where the status is known: a 404 is permanent (the job
    // fails without retrying), a 5xx/408/429 is transient.
    if (!res.ok) throw new HttpStatusError(res.status, `HTTP ${res.status} ${res.statusText}`)
    return res.text()
}
