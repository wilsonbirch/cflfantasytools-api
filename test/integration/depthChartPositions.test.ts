import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import { parseChartPositions } from '~/services/depthCharts/parsePositions.server'
import { parseGame } from '~/services/pbp/parsePlays.server'
import { executeOperation } from './setup/yogaClient'

// Real charts, archived 2026-08-22: Calgary's for 2026-08-13 and BC's for
// 2026-08-23. Parsed through the real pdftotext binary, as in production.
const CGY_PDF = readFileSync('test/fixtures/depth-charts/pdf/CGY-2026-08.pdf')
const BC_PDF = readFileSync('test/fixtures/depth-charts/pdf/BC-2026-08.pdf')

// A syntactically valid PDF whose only text is a roster heading: a layout the
// parser does not know, as opposed to bytes that are not a PDF at all.
const NO_DIAGRAM_PDF = Buffer.from(
    [
        '%PDF-1.1',
        '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
        '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
        '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
        '4 0 obj << /Length 44 >> stream',
        'BT /F1 24 Tf 72 700 Td (ROSTER ONLY) Tj ET',
        'endstream endobj',
        '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
        'trailer << /Root 1 0 R >>',
    ].join('\n'),
)

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

const CGY = '112939'
const SSK = '106752'

async function seedTeams() {
    const cgy = await db.team.create({
        data: {
            slug: 'calgary-stampeders',
            abbreviation: 'CGY',
            name: 'Calgary Stampeders',
            geniusTeamId: CGY,
        },
    })
    const ssk = await db.team.create({
        data: {
            slug: 'saskatchewan-roughriders',
            abbreviation: 'SSK',
            name: 'Saskatchewan Roughriders',
            geniusTeamId: SSK,
        },
    })
    return { cgy, ssk }
}

/** A chart with one archived copy, ready to parse. */
async function seedChart(
    teamId: number,
    pdf: Buffer,
    opts: { week?: number; publishedAt?: Date; href?: string } = {},
) {
    const list = await db.depthChartList.upsert({
        where: { teamId_year: { teamId, year: 2026 } },
        update: {},
        create: { teamId, year: 2026 },
    })
    const chart = await db.depthChart.create({
        data: {
            teamId,
            depthChartListId: list.id,
            title: `Week ${opts.week ?? 12}`,
            value: opts.href ?? `https://example.test/${teamId}-w${opts.week ?? 12}.pdf`,
            year: 2026,
            season: 'regular',
            week: opts.week ?? 12,
            publishedAt: opts.publishedAt ?? new Date('2026-08-12T18:00:00Z'),
        },
    })
    const file = await db.depthChartFile.create({
        data: {
            depthChartId: chart.id,
            sha256: sha(pdf),
            bytes: new Uint8Array(pdf),
            size: pdf.length,
            contentType: 'application/pdf',
        },
    })
    return { chart, file }
}

describe('parseChartPositions', () => {
    it('reads the starting five off a real PDF through pdftotext and stores them', async () => {
        const { cgy } = await seedTeams()
        const { chart, file } = await seedChart(cgy.id, CGY_PDF)

        const summary = await parseChartPositions(cgy.id, 2026)
        expect(summary).toEqual({ parsed: 1, ok: 1, unsupported: 0, failed: 0 })

        const updated = await db.depthChart.findUniqueOrThrow({ where: { id: chart.id } })
        expect(updated.parseStatus).toBe('OK')
        expect(updated.parsedFileId).toBe(file.id)

        const rows = await db.depthChartPosition.findMany({
            where: { depthChartId: chart.id, depth: 1 },
            orderBy: { position: 'asc' },
        })
        expect(rows.map((r) => [r.position, r.jersey, r.player])).toEqual([
            ['1S', 14, 'BARNES'],
            ['1WK', 4, 'JONES'],
            ['2S', 87, 'BROOKS'],
            ['2WK', 85, 'PHILPOT'],
            ['3S', 17, 'BRISSETT'],
        ])
        expect(rows.every((r) => r.teamId === cgy.id && r.year === 2026 && r.week === 12)).toBe(
            true,
        )
    })

    it('parses a chart once per archived copy, and again when a new copy lands', async () => {
        const { cgy } = await seedTeams()
        const { chart } = await seedChart(cgy.id, CGY_PDF)
        await parseChartPositions(cgy.id, 2026)
        expect((await parseChartPositions(cgy.id, 2026)).parsed).toBe(0)

        // The club replaced the file in place (BC's chart standing in for a
        // revised Calgary one): the newest copy is parsed and the slots replaced.
        await db.depthChartFile.create({
            data: {
                depthChartId: chart.id,
                sha256: sha(BC_PDF),
                bytes: new Uint8Array(BC_PDF),
                size: BC_PDF.length,
                contentType: 'application/pdf',
                fetchedAt: new Date(Date.now() + 60_000),
            },
        })
        expect((await parseChartPositions(cgy.id, 2026)).ok).toBe(1)
        const one = await db.depthChartPosition.findFirstOrThrow({
            where: { depthChartId: chart.id, position: '1WK', depth: 1 },
        })
        expect(one.player).toBe('HATCHER')
        expect(await db.depthChartPosition.count({ where: { player: 'JONES' } })).toBe(0)
    })

    it('records UNSUPPORTED for a PDF without the field diagram, FAILED for a non-PDF', async () => {
        const { cgy } = await seedTeams()
        const { chart: noDiagram } = await seedChart(cgy.id, NO_DIAGRAM_PDF, { week: 1 })
        const { chart: garbage } = await seedChart(cgy.id, Buffer.from('not a pdf'), { week: 2 })

        const summary = await parseChartPositions(cgy.id, 2026)
        expect(summary).toMatchObject({ parsed: 2, ok: 0 })

        const a = await db.depthChart.findUniqueOrThrow({ where: { id: noDiagram.id } })
        expect(a.parseStatus).toBe('UNSUPPORTED')
        expect(a.parseError).toMatch(/no offensive line row/)
        const b = await db.depthChart.findUniqueOrThrow({ where: { id: garbage.id } })
        expect(['FAILED', 'UNSUPPORTED']).toContain(b.parseStatus)
        expect(await db.depthChartPosition.count()).toBe(0)
    })
})

describe('alignment over GraphQL', () => {
    it('exposes positions, parse status and teamAlignment', async () => {
        const { cgy } = await seedTeams()
        await seedChart(cgy.id, CGY_PDF, {
            week: 11,
            publishedAt: new Date('2026-08-05T12:00:00Z'),
        })
        await seedChart(cgy.id, BC_PDF, { week: 12, publishedAt: new Date('2026-08-12T12:00:00Z') })
        await parseChartPositions(cgy.id, 2026)

        const r = await executeOperation<{
            depthChartLists: {
                charts: {
                    week: number
                    parseStatus: string
                    positions: { position: string; player: string; depth: number }[]
                }[]
            }[]
            newest: { week: number; positions: { position: string; player: string }[] } | null
            w11: { week: number; chart: { week: number }; team: { slug: string } } | null
            none: unknown
        }>({
            query: `{
                depthChartLists(teamSlug: "calgary-stampeders", year: 2026) {
                    charts { week parseStatus positions { position player depth } }
                }
                newest: teamAlignment(teamSlug: "calgary-stampeders", year: 2026) {
                    week positions { position player }
                }
                w11: teamAlignment(teamSlug: "calgary-stampeders", year: 2026, week: 11) {
                    week chart { week } team { slug }
                }
                none: teamAlignment(teamSlug: "calgary-stampeders", year: 2025) { week }
            }`,
        })
        expect(r.errors).toBeUndefined()
        const charts = r.data!.depthChartLists[0].charts
        expect(charts.map((c) => [c.week, c.parseStatus])).toEqual([
            [12, 'OK'],
            [11, 'OK'],
        ])
        expect(charts[1].positions.find((p) => p.position === '2WK' && p.depth === 1)?.player).toBe(
            'PHILPOT',
        )
        expect(r.data!.newest?.week).toBe(12)
        expect(r.data!.newest?.positions.find((p) => p.position === '1WK')?.player).toBe('HATCHER')
        expect(r.data!.w11).toEqual({
            week: 11,
            chart: { week: 11 },
            team: { slug: 'calgary-stampeders' },
        })
        expect(r.data!.none).toBeNull()
    })

    it('labels game and season stats with the chart slot', async () => {
        const { cgy } = await seedTeams()
        // The game is CGY v SSK on 2026-05-18; the chart is published the day before.
        await db.game.create({
            data: {
                id: 13419665,
                response: readFileSync('test/fixtures/pbp/widget-payload.json', 'utf8'),
                year: 2026,
            },
        })
        await parseGame(13419665)
        await seedChart(cgy.id, CGY_PDF, { week: 1, publishedAt: new Date('2026-05-17T12:00:00Z') })
        await parseChartPositions(cgy.id, 2026)

        const r = await executeOperation<{
            game: { playerStats: { player: string; alignment: string | null }[] }
            playerSeasonStats: { player: string; primaryAlignment: string | null }[]
        }>({
            query: `{
                game(id: 13419665) { playerStats { player alignment } }
                playerSeasonStats(year: 2026, teamSlug: "calgary-stampeders") { player primaryAlignment }
            }`,
        })
        expect(r.errors).toBeUndefined()
        const philpot = r.data!.game.playerStats.find((l) => l.player === '#85 J.Philpot')
        expect(philpot?.alignment).toBe('2WK')
        // A quarterback is on no receiver slot; a Saskatchewan player has no chart.
        expect(r.data!.game.playerStats.find((l) => l.player === '#3 V.Adams Jr.')?.alignment).toBe(
            null,
        )
        expect(r.data!.game.playerStats.find((l) => l.player === '#10 B.Schager')?.alignment).toBe(
            null,
        )
        const season = r.data!.playerSeasonStats.find((l) => l.player === '#85 J.Philpot')
        expect(season?.primaryAlignment).toBe('2WK')
    })

    it('gives no alignment when the only chart is from a different game week', async () => {
        const { cgy } = await seedTeams()
        await db.game.create({
            data: {
                id: 13419665,
                response: readFileSync('test/fixtures/pbp/widget-payload.json', 'utf8'),
                year: 2026,
            },
        })
        await parseGame(13419665)
        // Published three months after kickoff: not this game's chart.
        await seedChart(cgy.id, CGY_PDF, {
            week: 12,
            publishedAt: new Date('2026-08-12T12:00:00Z'),
        })
        await parseChartPositions(cgy.id, 2026)

        const r = await executeOperation<{
            game: { playerStats: { player: string; alignment: string | null }[] }
        }>({ query: '{ game(id: 13419665) { playerStats { player alignment } } }' })
        expect(r.data!.game.playerStats.every((l) => l.alignment === null)).toBe(true)
    })
})
