import { builder } from '~/builder'
import { db } from '~/lib/db.server'
import { depthChartFilePath } from '~/routes/depthChartFiles.server'

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
