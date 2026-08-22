import { GraphQLError } from 'graphql'
import { builder } from '~/builder'
import { db } from '~/lib/db.server'
import { requireAuth } from '~/lib/guards.server'
import { verifyUnsubscribeToken } from '~/lib/signedLinks.server'

builder.prismaObject('NotificationSubscription', {
    fields: (t) => ({
        id: t.exposeInt('id'),
        enabled: t.exposeBoolean('enabled'),
        createdAt: t.expose('createdAt', { type: 'DateTime' }),
        updatedAt: t.expose('updatedAt', { type: 'DateTime' }),
        team: t.relation('Team'),
    }),
})

async function teamIdBySlug(slug: string): Promise<number> {
    const team = await db.team.findUnique({ where: { slug }, select: { id: true } })
    if (!team) {
        throw new GraphQLError(`No team with slug "${slug}"`, {
            extensions: { code: 'NOT_FOUND' },
        })
    }
    return team.id
}

// Subscribe and unsubscribe are both an upsert on (account, team): the row is
// the preference, so there is nothing to delete and nothing to duplicate.
const setSubscription = (query: object, accountId: number, teamId: number, enabled: boolean) =>
    db.notificationSubscription.upsert({
        ...query,
        where: { accountId_teamId: { accountId, teamId } },
        update: { enabled },
        create: { accountId, teamId, enabled },
    })

builder.queryFields((t) => ({
    mySubscriptions: t.prismaField({
        type: ['NotificationSubscription'],
        description: 'Signed in only.',
        resolve: (query, _root, _args, ctx) =>
            db.notificationSubscription.findMany({
                ...query,
                where: { accountId: requireAuth(ctx).account.id },
                orderBy: { Team: { name: 'asc' } },
            }),
    }),
}))

builder.mutationFields((t) => ({
    subscribe: t.prismaField({
        type: 'NotificationSubscription',
        description: 'Signed in only.',
        args: { teamSlug: t.arg.string({ required: true }) },
        resolve: async (query, _root, { teamSlug }, ctx) => {
            const { account } = requireAuth(ctx)
            return setSubscription(query, account.id, await teamIdBySlug(teamSlug), true)
        },
    }),
    unsubscribe: t.prismaField({
        type: 'NotificationSubscription',
        description: 'Signed in only.',
        args: { teamSlug: t.arg.string({ required: true }) },
        resolve: async (query, _root, { teamSlug }, ctx) => {
            const { account } = requireAuth(ctx)
            return setSubscription(query, account.id, await teamIdBySlug(teamSlug), false)
        },
    }),
    unsubscribeWithToken: t.boolean({
        description: 'Signed link from a notification email; needs no session.',
        args: { token: t.arg.string({ required: true }) },
        resolve: async (_root, { token }) => {
            const claims = verifyUnsubscribeToken(token)
            if (!claims) {
                throw new GraphQLError('Invalid unsubscribe link', {
                    extensions: { code: 'BAD_USER_INPUT' },
                })
            }
            const { count } = await db.notificationSubscription.updateMany({
                where: {
                    Account: { uuid: claims.accountUuid },
                    Team: { slug: claims.teamSlug },
                    enabled: true,
                },
                data: { enabled: false },
            })
            // True when the link did something; a second click is an honest false.
            return count > 0
        },
    }),
}))
