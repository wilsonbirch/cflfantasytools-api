import type { YogaInitialContext } from 'graphql-yoga'
import { verifyAccessToken } from '~/lib/auth.server'
import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import type { Account } from '~/generated/prisma/client'

const fileName = 'context'

export type AuthContext = {
    account: Account
    // Session.uuid the access token was minted against.
    sessionUuid: string
}

export type GraphQLContext = {
    // null for anonymous requests (no or invalid token). Resolvers gate via
    // ~/lib/guards.server — nothing is implicitly protected.
    auth: AuthContext | null
}

function bearerToken(header: string | null): string | null {
    if (!header) return null
    const [scheme, token] = header.split(' ')
    return scheme?.toLowerCase() === 'bearer' && token ? token : null
}

/**
 * Build the per-request GraphQL context. A missing, malformed or expired token
 * yields `auth: null` rather than an error — an expired access token simply
 * reads as logged-out, and the client is expected to refresh and retry.
 */
export async function createContext({ request }: YogaInitialContext): Promise<GraphQLContext> {
    const token = bearerToken(request.headers.get('authorization'))
    if (!token) return { auth: null }

    try {
        const claims = await verifyAccessToken(token)
        const account = await db.account.findUnique({ where: { uuid: claims.sub } })
        // A valid signature over a deleted account is still anonymous.
        if (!account) return { auth: null }
        return { auth: { account, sessionUuid: claims.sid } }
    } catch (err) {
        logger.warn(fileName, `rejected auth token: ${(err as Error).message}`)
        return { auth: null }
    }
}
