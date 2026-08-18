import { GraphQLError } from 'graphql'
import type { AuthContext, GraphQLContext } from '~/context'

// The api is the ONLY security boundary. Web's /admin redirect and native's
// hidden admin tab are UX; neither is enforcement. In 3DF the three /api/*
// routes had no check at all, which is how anyone could flip anyone's
// notification preferences — every privileged field goes through here now.

export function requireAuth(ctx: GraphQLContext): AuthContext {
    if (!ctx.auth) {
        throw new GraphQLError('You must be signed in to do that', {
            extensions: { code: 'UNAUTHENTICATED' },
        })
    }
    return ctx.auth
}

export function requireAdmin(ctx: GraphQLContext): AuthContext {
    const auth = requireAuth(ctx)
    if (auth.account.role !== 'ADMIN') {
        throw new GraphQLError('Admin access required', {
            extensions: { code: 'FORBIDDEN' },
        })
    }
    return auth
}
