import { builder } from '~/builder'
import { db } from '~/lib/db.server'

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
