import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import {
    archiveChartFiles,
    RECHECK_AFTER_MS,
    RECHECK_NEWEST,
} from '~/services/depthCharts/archiveFiles.server'
import { checkTeam } from '~/services/depthCharts/checkTeam.server'
import { executeOperation } from './setup/yogaClient'

const CGY_PAGE = readFileSync('test/fixtures/depth-charts/calgary-stampeders.html', 'utf8')

// Two distinct "PDFs". Real bytes are not needed to test archiving: the
// service hashes and stores whatever the club served.
const PDF_A = Buffer.from('%PDF-1.7\n% version A\n')
const PDF_B = Buffer.from('%PDF-1.7\n% version B — replaced in place\n')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** Serves the club page for the page URL and a PDF for every .pdf href. */
const serve = (pdf: Buffer | null = PDF_A, page = CGY_PAGE) =>
    (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.endsWith('.pdf')) {
            return pdf === null
                ? new Response('gone', { status: 503 })
                : new Response(new Uint8Array(pdf), {
                      status: 200,
                      headers: { 'content-type': 'application/pdf' },
                  })
        }
        return new Response(page, { status: 200 })
    }) as unknown as typeof fetch

async function seedTeam() {
    const team = await db.team.create({
        data: { slug: 'calgary-stampeders', abbreviation: 'CGY', name: 'Calgary Stampeders' },
    })
    await db.teamSource.create({
        data: {
            teamId: team.id,
            kind: 'depth-chart',
            url: 'https://www.stampeders.com/game-notes/',
            strategy: 'tableRowCells',
            config: { titleCells: [0, 1, 2], linkCell: 4, minCells: 5 },
        },
    })
    return team
}

/** First sweep records the snapshot silently; dropping an item makes it "new" next time. */
async function seedWithOneNewChart(team: { id: number }, fetchImpl: typeof fetch) {
    await checkTeam(team.id, 2026, fetchImpl)
    const list = await db.depthChartList.findFirstOrThrow()
    const items = list.value as { title: string; href: string }[]
    await db.depthChartList.update({ where: { id: list.id }, data: { value: items.slice(0, -1) } })
}

describe('archiving on sweep', () => {
    it('archives the PDF of a newly detected chart', async () => {
        const team = await seedTeam()
        await seedWithOneNewChart(team, serve())

        const r = await checkTeam(team.id, 2026, serve())

        expect(r.addedCount).toBe(1)
        expect(r.revisedCount).toBe(0)
        const chart = await db.depthChart.findFirstOrThrow({ include: { files: true } })
        expect(chart.files).toHaveLength(1)
        expect(chart.files[0]).toMatchObject({
            sha256: sha(PDF_A),
            size: PDF_A.length,
            contentType: 'application/pdf',
        })
        expect(Buffer.from(chart.files[0].bytes).equals(PDF_A)).toBe(true)
    })

    it('does not fail the scrape when the PDF cannot be fetched, and retries next sweep', async () => {
        const team = await seedTeam()
        await seedWithOneNewChart(team, serve())

        const r = await checkTeam(team.id, 2026, serve(null))
        expect(r.status).toBe('OK')
        expect(r.addedCount).toBe(1)
        expect(await db.depthChartFile.count()).toBe(0)

        // The site serves it on the next half-hour sweep: archived then.
        await checkTeam(team.id, 2026, serve())
        expect(await db.depthChartFile.count()).toBe(1)
    })

    it('records a ScrapeRun revisedCount', async () => {
        const team = await seedTeam()
        await checkTeam(team.id, 2026, serve())
        const run = await db.scrapeRun.findFirstOrThrow()
        expect(run.revisedCount).toBe(0)
    })
})

describe('archiveChartFiles — checksum change detection', () => {
    async function seedChart(team: { id: number }, n = 1) {
        const list = await db.depthChartList.create({ data: { teamId: team.id, year: 2026 } })
        const charts = []
        for (let i = 0; i < n; i++) {
            charts.push(
                await db.depthChart.create({
                    data: {
                        teamId: team.id,
                        depthChartListId: list.id,
                        title: `Week ${i + 1}`,
                        value: `https://example.test/w${i + 1}.pdf`,
                        year: 2026,
                        season: 'regular',
                        week: i + 1,
                        publishedAt: new Date(Date.UTC(2026, 6, i + 1)),
                    },
                }),
            )
        }
        return charts
    }

    it('stores a replaced file as a new version and reports it as revised', async () => {
        const team = await seedTeam()
        const [chart] = await seedChart(team)
        const t0 = new Date('2026-08-20T12:00:00Z')

        expect(await archiveChartFiles(team.id, 2026, serve(PDF_A), t0)).toMatchObject({
            archived: 1,
            revised: 0,
        })

        // The club silently swaps the PDF at the same URL. Href-based detection
        // sees nothing; the checksum does.
        const later = new Date(t0.getTime() + RECHECK_AFTER_MS)
        const second = await archiveChartFiles(team.id, 2026, serve(PDF_B), later)
        expect(second).toMatchObject({ archived: 0, revised: 1 })

        const files = await db.depthChartFile.findMany({
            where: { depthChartId: chart.id },
            orderBy: { fetchedAt: 'asc' },
        })
        expect(files.map((f) => f.sha256)).toEqual([sha(PDF_A), sha(PDF_B)])
        // Re-published so the revision surfaces as the newest chart.
        const bumped = await db.depthChart.findUniqueOrThrow({ where: { id: chart.id } })
        expect(bumped.publishedAt.getTime()).toBe(later.getTime())
    })

    it('only re-checks once the interval has passed, and only bumps checkedAt when unchanged', async () => {
        const team = await seedTeam()
        await seedChart(team)
        const t0 = new Date('2026-08-20T12:00:00Z')
        await archiveChartFiles(team.id, 2026, serve(PDF_A), t0)

        // Too soon: nothing is fetched, so the club is not hammered every sweep.
        const soon = new Date(t0.getTime() + RECHECK_AFTER_MS - 1)
        expect(await archiveChartFiles(team.id, 2026, serve(PDF_B), soon)).toMatchObject({
            fetched: 0,
        })

        // Due, unchanged: same single row, checkedAt moved on.
        const due = new Date(t0.getTime() + RECHECK_AFTER_MS)
        expect(await archiveChartFiles(team.id, 2026, serve(PDF_A), due)).toMatchObject({
            fetched: 1,
            archived: 0,
            revised: 0,
        })
        const files = await db.depthChartFile.findMany()
        expect(files).toHaveLength(1)
        expect(files[0].checkedAt.getTime()).toBe(due.getTime())
    })

    it('re-checks only the newest few charts', async () => {
        const team = await seedTeam()
        await seedChart(team, RECHECK_NEWEST + 2)
        const t0 = new Date('2026-08-20T12:00:00Z')
        expect((await archiveChartFiles(team.id, 2026, serve(PDF_A), t0)).archived).toBe(
            RECHECK_NEWEST + 2,
        )

        const due = new Date(t0.getTime() + RECHECK_AFTER_MS)
        expect((await archiveChartFiles(team.id, 2026, serve(PDF_A), due)).fetched).toBe(
            RECHECK_NEWEST,
        )
    })

    it('treats a flip back to an earlier file as that version, not a third', async () => {
        const team = await seedTeam()
        await seedChart(team)
        const t0 = new Date('2026-08-20T12:00:00Z')
        await archiveChartFiles(team.id, 2026, serve(PDF_A), t0)
        await archiveChartFiles(
            team.id,
            2026,
            serve(PDF_B),
            new Date(t0.getTime() + RECHECK_AFTER_MS),
        )
        await archiveChartFiles(
            team.id,
            2026,
            serve(PDF_A),
            new Date(t0.getTime() + 2 * RECHECK_AFTER_MS),
        )
        expect(await db.depthChartFile.count()).toBe(2)
    })
})

describe('DepthChart.files over GraphQL and the REST route', () => {
    let close: (() => Promise<void>) | null = null
    afterAll(async () => {
        await close?.()
    })

    it('exposes metadata with a URL on this API that streams the bytes', async () => {
        const team = await seedTeam()
        await seedWithOneNewChart(team, serve())
        await checkTeam(team.id, 2026, serve())
        const file = await db.depthChartFile.findFirstOrThrow()

        const r = await executeOperation<{
            depthChartLists: {
                charts: {
                    files: { id: number; sha256: string; size: number; url: string }[]
                }[]
            }[]
        }>({
            query: `{ depthChartLists(teamSlug: "calgary-stampeders", year: 2026) {
                charts { files { id sha256 size url } } } }`,
        })
        expect(r.errors).toBeUndefined()
        const files = r.data!.depthChartLists[0].charts[0].files
        expect(files).toEqual([
            {
                id: file.id,
                sha256: sha(PDF_A),
                size: PDF_A.length,
                url: `http://test.local/depth-charts/files/${file.id}.pdf`,
            },
        ])

        // The route itself, on the real http server.
        const { server } = await import('~/app')
        server.listen(0)
        await once(server, 'listening')
        close = () => new Promise((resolve) => server.close(() => resolve()))
        const port = (server.address() as AddressInfo).port

        const ok = await fetch(`http://127.0.0.1:${port}/depth-charts/files/${file.id}.pdf`)
        expect(ok.status).toBe(200)
        expect(ok.headers.get('content-type')).toBe('application/pdf')
        expect(ok.headers.get('cache-control')).toContain('immutable')
        expect(ok.headers.get('etag')).toBe(`"${sha(PDF_A)}"`)
        expect(Buffer.from(await ok.arrayBuffer()).equals(PDF_A)).toBe(true)

        const missing = await fetch(`http://127.0.0.1:${port}/depth-charts/files/999999.pdf`)
        expect(missing.status).toBe(404)
    })
})
