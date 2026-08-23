import type { ServerResponse } from 'node:http'
import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'

const fileName = 'routes/depthChartFiles'

// GET /depth-charts/files/:id.pdf — streams an archived chart PDF.
//
// A REST route rather than a GraphQL field because the payload is a binary:
// base64 in JSON is a third larger, uncacheable by anything in between, and
// useless to a browser tab. The row is immutable once written (a new version is
// a new row), so the response can be cached forever.

const PATH = /^\/depth-charts\/files\/(\d+)\.pdf(?:\?.*)?$/

export const depthChartFilePath = (id: number): string => `/depth-charts/files/${id}.pdf`

export const matchDepthChartFile = (url: string): number | null => {
    const m = url.match(PATH)
    return m ? Number(m[1]) : null
}

export async function handleDepthChartFile(id: number, res: ServerResponse): Promise<void> {
    try {
        const file = await db.depthChartFile.findUnique({
            where: { id },
            select: { bytes: true, contentType: true, sha256: true, size: true },
        })
        if (!file) {
            res.writeHead(404, { 'content-type': 'text/plain' })
            res.end('not found')
            return
        }
        res.writeHead(200, {
            'content-type': file.contentType,
            'content-length': file.size,
            'cache-control': 'public, max-age=31536000, immutable',
            etag: `"${file.sha256}"`,
            'content-disposition': `inline; filename="depth-chart-${id}.pdf"`,
        })
        res.end(Buffer.from(file.bytes))
    } catch (err) {
        logger.error(fileName, `file ${id}: ${err instanceof Error ? err.message : String(err)}`)
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('error')
    }
}
