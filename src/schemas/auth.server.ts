import bcrypt from 'bcryptjs'
import { GraphQLError } from 'graphql'
import { z } from 'zod'
import { builder } from '~/builder'
import { db } from '~/lib/db.server'
import { Prisma, type Account } from '~/generated/prisma/client'
import { RoleEnum } from '~/schemas/enums.server'
import { issueSession, revokeSession, rotateSession } from '~/services/auth/sessions.server'

const AccountType = builder.prismaObject('Account', {
    fields: (t) => ({
        id: t.exposeInt('id'),
        uuid: t.exposeString('uuid'),
        email: t.exposeString('email'),
        role: t.expose('role', { type: RoleEnum }),
        createdAt: t.expose('createdAt', { type: 'DateTime' }),
    }),
})

const AuthPayload = builder
    .objectRef<{ accessToken: string; refreshToken: string; account: Account }>('AuthPayload')
    .implement({
        fields: (t) => ({
            accessToken: t.exposeString('accessToken'),
            refreshToken: t.exposeString('refreshToken', {
                description: 'One-time use. Each refresh returns a new token and revokes this one.',
            }),
            account: t.field({ type: AccountType, resolve: (p) => p.account }),
        }),
    })

const BCRYPT_ROUNDS = 10
// Compared against when the email is unknown, so a wrong email costs the same
// time as a wrong password and the response never says which it was.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS)

const credentials = z.object({
    email: z
        .email()
        .max(254)
        .transform((e) => e.trim().toLowerCase()),
    password: z.string().min(8).max(200),
})

const badInput = (message: string): GraphQLError =>
    new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } })

const badCredentials = (): GraphQLError =>
    new GraphQLError('Invalid email or password', { extensions: { code: 'UNAUTHENTICATED' } })

builder.mutationType({
    fields: (t) => ({
        register: t.field({
            type: AuthPayload,
            args: {
                email: t.arg.string({ required: true }),
                password: t.arg.string({ required: true }),
            },
            resolve: async (_root, args) => {
                const parsed = credentials.safeParse(args)
                if (!parsed.success) {
                    throw badInput(
                        'A valid email and a password of at least 8 characters are required',
                    )
                }
                const { email, password } = parsed.data
                let account: Account
                try {
                    account = await db.account.create({
                        data: { email, password: await bcrypt.hash(password, BCRYPT_ROUNDS) },
                    })
                } catch (err) {
                    if (
                        err instanceof Prisma.PrismaClientKnownRequestError &&
                        err.code === 'P2002'
                    ) {
                        throw badInput('An account with that email already exists')
                    }
                    throw err
                }
                return { ...(await issueSession(account)), account }
            },
        }),
        login: t.field({
            type: AuthPayload,
            description: 'Wrong email and wrong password fail identically.',
            args: {
                email: t.arg.string({ required: true }),
                password: t.arg.string({ required: true }),
            },
            resolve: async (_root, { email, password }) => {
                const account = await db.account.findUnique({
                    where: { email: email.trim().toLowerCase() },
                })
                const ok = await bcrypt.compare(password, account?.password ?? DUMMY_HASH)
                if (!account || !ok) throw badCredentials()
                return { ...(await issueSession(account)), account }
            },
        }),
        refresh: t.field({
            type: AuthPayload,
            description: 'Rotates the token; reusing a rotated token revokes the whole session.',
            args: { refreshToken: t.arg.string({ required: true }) },
            resolve: (_root, { refreshToken }) => rotateSession(refreshToken),
        }),
        logout: t.boolean({
            description: 'Revokes the session the refresh token belongs to. Idempotent.',
            args: { refreshToken: t.arg.string({ required: true }) },
            resolve: async (_root, { refreshToken }) => {
                await revokeSession(refreshToken)
                return true
            },
        }),
    }),
})

builder.queryFields((t) => ({
    me: t.field({
        type: AccountType,
        nullable: true,
        description: 'Null when signed out.',
        resolve: (_root, _args, ctx) => ctx.auth?.account ?? null,
    }),
}))
