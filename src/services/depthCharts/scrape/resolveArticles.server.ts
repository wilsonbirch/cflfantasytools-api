import { logger } from '~/lib/logger.server'
import { findArticlePdf, type ArticleListConfig, type DepthChartItem } from './extractors'
import { fetchPage } from './fetchPage.server'

const fileName = 'services/depthCharts/scrape/resolveArticles'

/**
 * Turn articleList items (article URLs) into chart items (PDF URLs).
 *
 * An article already resolved in the previous snapshot reuses that PDF rather
 * than being fetched again, so a sweep costs one request per NEW article, not
 * one per article of the season. A chart replaced in place is still caught —
 * by the archive's checksum re-check, which reads the PDF, not the article.
 *
 * An article that fails to load, or carries no PDF, is dropped and logged: one
 * bad article must not cost the club's other charts. It is retried on the next
 * sweep because it never makes it into the snapshot.
 */
export async function resolveArticlePdfs(
    articles: DepthChartItem[],
    previous: DepthChartItem[] | null,
    cfg: ArticleListConfig,
    fetchImpl: typeof fetch = fetch,
): Promise<DepthChartItem[]> {
    const known = new Map(
        (previous ?? []).filter((i) => i.page).map((i) => [i.page as string, i.href]),
    )
    const out: DepthChartItem[] = []
    for (const article of articles) {
        const page = article.page ?? article.href
        const cached = known.get(page)
        if (cached) {
            out.push({ title: article.title, href: cached, page })
            continue
        }
        try {
            const doc = await fetchPage(page, fetchImpl)
            const pdf = findArticlePdf(doc, cfg, new URL(page).origin)
            if (!pdf) {
                logger.warn(fileName, `${page}: no chart PDF in the article`)
                continue
            }
            out.push({ title: article.title, href: pdf, page })
        } catch (err) {
            logger.warn(fileName, `${page}: ${err instanceof Error ? err.message : String(err)}`)
        }
    }
    return out
}
