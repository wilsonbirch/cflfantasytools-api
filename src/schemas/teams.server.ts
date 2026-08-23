import { builder } from '~/builder'
import { db } from '~/lib/db.server'
import { CoachingRoleEnum } from '~/schemas/enums.server'

builder.prismaObject('CoachingStaff', {
    description: 'One person in one role at one club. Hand-maintained; not in any feed.',
    fields: (t) => ({
        id: t.exposeInt('id'),
        role: t.expose('role', { type: CoachingRoleEnum }),
        person: t.exposeString('person'),
        effectiveFrom: t.expose('effectiveFrom', { type: 'DateTime' }),
        effectiveTo: t.expose('effectiveTo', {
            type: 'DateTime',
            nullable: true,
            description: 'Null while current.',
        }),
        team: t.relation('Team'),
    }),
})

/** Rows in post at any point during a calendar year. */
export const inPostDuring = (year: number) => ({
    effectiveFrom: { lte: new Date(Date.UTC(year, 11, 31, 23, 59, 59)) },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date(Date.UTC(year, 0, 1)) } }],
})

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
        coachingStaff: t.relation('coachingStaff', {
            description:
                'Staff in post at any point during the season; every row when year is omitted.',
            args: { year: t.arg.int() },
            query: ({ year }) => ({
                where: year == null ? {} : inPostDuring(year),
                orderBy: [{ role: 'asc' }, { effectiveFrom: 'asc' }],
            }),
        }),
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
