import { execFile } from 'node:child_process'
import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import { parseChartText } from './parseChart'

const fileName = 'services/depthCharts/parsePositions'

export type PositionsSummary = { parsed: number; ok: number; unsupported: number; failed: number }

/**
 * The column-preserving text of a PDF's first page, via poppler's pdftotext.
 *
 * `-layout` is what makes the field diagram parseable at all: it keeps every
 * name at the horizontal offset it was drawn at, and that offset IS the
 * receiver's alignment. Page 1 only — the roster pages that follow are noise.
 */
export function pdfToLayoutText(bytes: Uint8Array): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = execFile(
            'pdftotext',
            ['-layout', '-l', '1', '-', '-'],
            { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
            (err, stdout) => (err ? reject(err) : resolve(stdout)),
        )
        child.stdin?.on('error', () => undefined)
        child.stdin?.end(bytes)
    })
}

/**
 * Parse the newest archived copy of every chart of a club/season that has not
 * been parsed yet (or whose newest copy is newer than the one last parsed), and
 * store the positions. Per-chart status is recorded either way, so a club whose
 * layout the parser cannot read shows up as UNSUPPORTED rather than as silence.
 */
export async function parseChartPositions(teamId: number, year: number): Promise<PositionsSummary> {
    const summary: PositionsSummary = { parsed: 0, ok: 0, unsupported: 0, failed: 0 }

    const charts = await db.depthChart.findMany({
        where: { teamId, year },
        select: {
            id: true,
            week: true,
            parsedFileId: true,
            files: {
                select: { id: true, bytes: true },
                orderBy: [{ fetchedAt: 'desc' }, { id: 'desc' }],
                take: 1,
            },
        },
    })

    for (const chart of charts) {
        const file = chart.files[0]
        if (!file || chart.parsedFileId === file.id) continue
        summary.parsed += 1

        let result: ReturnType<typeof parseChartText>
        try {
            result = parseChartText(await pdfToLayoutText(file.bytes))
        } catch (err) {
            result = {
                status: 'FAILED',
                reason: `pdftotext: ${err instanceof Error ? err.message : String(err)}`,
            }
        }

        if (result.status !== 'OK') {
            const status = /no offensive line row/.test(result.reason) ? 'UNSUPPORTED' : 'FAILED'
            summary[status === 'UNSUPPORTED' ? 'unsupported' : 'failed'] += 1
            await db.depthChart.update({
                where: { id: chart.id },
                data: { parseStatus: status, parsedFileId: file.id, parseError: result.reason },
            })
            logger.warn(fileName, `chart ${chart.id}: ${status} — ${result.reason}`)
            continue
        }

        // Replace wholesale inside one transaction: a re-parse of a revised file
        // must not leave last version's slots behind.
        await db.$transaction(async (tx) => {
            await tx.depthChartPosition.deleteMany({ where: { depthChartId: chart.id } })
            await tx.depthChartPosition.createMany({
                data: result.positions.map((p) => ({
                    depthChartId: chart.id,
                    teamId,
                    year,
                    week: chart.week,
                    position: p.position,
                    player: p.player,
                    jersey: p.jersey,
                    depth: p.depth,
                })),
            })
            await tx.depthChart.update({
                where: { id: chart.id },
                data: { parseStatus: 'OK', parsedFileId: file.id, parseError: null },
            })
        })
        summary.ok += 1
        logger.info(
            fileName,
            `chart ${chart.id}: ${result.positions.length} receiver slots, boundary on the ${result.weakSide}`,
        )
    }

    return summary
}
