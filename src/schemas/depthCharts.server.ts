import { builder } from '~/builder'
import { db } from '~/lib/db.server'
import { depthChartFilePath } from '~/routes/depthChartFiles.server'
import { DepthChartParseStatusEnum } from '~/schemas/enums.server'

builder.prismaObject('DepthChartPosition', {
    description:
        'One receiver slot on a chart. `position` counts OUTSIDE-IN: 1S is the widest receiver on the strong/field side, 2WK the second from the outside on the weak/boundary side.',
    fields: (t) => ({
        position: t.exposeString('position', { description: '1S, 2S, 3S, 1WK, 2WK, ...' }),
        player: t.exposeString('player', { description: 'Name as printed on the chart.' }),
        jersey: t.exposeInt('jersey', {
            nullable: true,
            description: 'Jersey number when the chart prints one.',
        }),
        depth: t.exposeInt('depth', { description: '1 = starter, 2 = second string, 3 = third.' }),
    }),
})

const POSITIONS_ORDER = [{ depth: 'asc' }, { position: 'asc' }] as const

// Bytes are deliberately NOT a field: GraphQL is the wrong transport for a
// binary. `url` points at the REST route on this API that streams them.
builder.prismaObject('DepthChartFile', {
    description: 'An archived copy of a chart PDF. Bytes are served over REST, not GraphQL.',
    fields: (t) => ({
        id: t.exposeInt('id'),
        sha256: t.exposeString('sha256'),
        size: t.exposeInt('size', { description: 'Bytes.' }),
        contentType: t.exposeString('contentType'),
        fetchedAt: t.expose('fetchedAt', { type: 'DateTime' }),
        url: t.string({
            description:
                'Absolute URL on this API that streams the file: GET /depth-charts/files/{id}.pdf',
            resolve: (f, _args, ctx) => `${ctx.origin}${depthChartFilePath(f.id)}`,
        }),
    }),
})

builder.prismaObject('DepthChart', {
    description: "One posted depth chart; `url` is the club's own PDF.",
    fields: (t) => ({
        id: t.exposeInt('id'),
        uuid: t.exposeString('uuid'),
        title: t.exposeString('title'),
        url: t.exposeString('value'),
        year: t.exposeInt('year'),
        season: t.exposeString('season'),
        week: t.exposeInt('week'),
        publishedAt: t.expose('publishedAt', { type: 'DateTime' }),
        detectedAt: t.expose('createdAt', {
            type: 'DateTime',
            description: 'When the scraper first saw the chart.',
        }),
        files: t.relation('files', {
            description: 'Archived copies of the PDF, newest first; one per distinct checksum.',
            query: { orderBy: [{ fetchedAt: 'desc' }, { id: 'desc' }] },
        }),
        parseStatus: t.expose('parseStatus', {
            type: DepthChartParseStatusEnum,
            nullable: true,
            description: 'Null until a parse has been attempted on an archived copy.',
        }),
        positions: t.relation('positions', {
            description:
                'Receiver alignment read from the newest archived copy. Empty unless parseStatus is OK.',
            query: { orderBy: [...POSITIONS_ORDER] },
        }),
    }),
})

type TeamAlignmentRow = { chartId: number; teamId: number; year: number; week: number }

const TeamAlignmentType = builder.objectRef<TeamAlignmentRow>('TeamAlignment').implement({
    description: "A team's receiver alignment as of one chart.",
    fields: (t) => ({
        year: t.exposeInt('year'),
        week: t.exposeInt('week'),
        weeks: t.intList({
            description: 'Every week of the season with a chart that parsed OK, ascending.',
            resolve: async (r) => {
                const rows = await db.depthChart.findMany({
                    where: { teamId: r.teamId, year: r.year, parseStatus: 'OK' },
                    distinct: ['week'],
                    select: { week: true },
                    orderBy: { week: 'asc' },
                })
                return rows.map((c) => c.week)
            },
        }),
        team: t.prismaField({
            type: 'Team',
            resolve: (q, r) => db.team.findUniqueOrThrow({ ...q, where: { id: r.teamId } }),
        }),
        chart: t.prismaField({
            type: 'DepthChart',
            resolve: (q, r) => db.depthChart.findUniqueOrThrow({ ...q, where: { id: r.chartId } }),
        }),
        positions: t.prismaField({
            type: ['DepthChartPosition'],
            resolve: (q, r) =>
                db.depthChartPosition.findMany({
                    ...q,
                    where: { depthChartId: r.chartId },
                    orderBy: [...POSITIONS_ORDER],
                }),
        }),
    }),
})

builder.prismaObject('DepthChartList', {
    description: "A team's depth charts for one season, newest chart first.",
    fields: (t) => ({
        id: t.exposeInt('id'),
        uuid: t.exposeString('uuid'),
        year: t.exposeInt('year'),
        updatedAt: t.expose('updatedAt', { type: 'DateTime' }),
        team: t.relation('Team'),
        charts: t.relation('depthCharts', {
            query: { orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }] },
        }),
    }),
})

builder.queryFields((t) => ({
    teamAlignment: t.field({
        type: TeamAlignmentType,
        nullable: true,
        description:
            "The newest parsed chart for the team's week (or the season's newest when week is omitted); null when none has parsed OK.",
        args: {
            teamSlug: t.arg.string({ required: true }),
            year: t.arg.int({ required: true }),
            week: t.arg.int(),
        },
        resolve: async (_root, { teamSlug, year, week }) => {
            const chart = await db.depthChart.findFirst({
                where: {
                    Team: { slug: teamSlug },
                    year,
                    parseStatus: 'OK',
                    ...(week == null ? {} : { week }),
                },
                orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
                select: { id: true, teamId: true, year: true, week: true },
            })
            return chart
                ? { chartId: chart.id, teamId: chart.teamId, year: chart.year, week: chart.week }
                : null
        },
    }),
    depthChartYears: t.field({
        type: ['Int'],
        args: { teamSlug: t.arg.string({ required: true }) },
        resolve: async (_root, { teamSlug }) => {
            const lists = await db.depthChartList.findMany({
                where: { Team: { slug: teamSlug } },
                select: { year: true },
                orderBy: { year: 'desc' },
            })
            return lists.map((l) => l.year)
        },
    }),
    depthChartLists: t.prismaField({
        type: ['DepthChartList'],
        args: { teamSlug: t.arg.string({ required: true }), year: t.arg.int() },
        resolve: (query, _root, { teamSlug, year }) =>
            db.depthChartList.findMany({
                ...query,
                where: { Team: { slug: teamSlug }, ...(year == null ? {} : { year }) },
                orderBy: { year: 'desc' },
            }),
    }),
}))
