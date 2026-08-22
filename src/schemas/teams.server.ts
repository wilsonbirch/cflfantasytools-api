import { builder } from '~/builder'
import { db } from '~/lib/db.server'

export const TeamType = builder.prismaObject('Team', {
    fields: (t) => ({
        id: t.exposeInt('id'),
        uuid: t.exposeString('uuid'),
        slug: t.exposeString('slug'),
        abbreviation: t.exposeString('abbreviation'),
        name: t.exposeString('name'),
        nameFr: t.exposeString('nameFr', { nullable: true }),
        shortName: t.exposeString('shortName', { nullable: true }),
        city: t.exposeString('city', { nullable: true }),
        isActive: t.exposeBoolean('isActive'),
    }),
})

builder.queryFields((t) => ({
    teams: t.prismaField({
        type: ['Team'],
        resolve: (query) => db.team.findMany({ ...query, orderBy: { name: 'asc' } }),
    }),
    team: t.prismaField({
        type: 'Team',
        nullable: true,
        args: { slug: t.arg.string({ required: true }) },
        resolve: (query, _root, { slug }) => db.team.findUnique({ ...query, where: { slug } }),
    }),
}))
