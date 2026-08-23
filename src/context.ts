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
    // This API's public origin ("https://cflfantasytools-api.fly.dev"), for
    // fields that hand out REST URLs on this same host. Read from the request
    // (x-forwarded-proto behind Fly's proxy) so no deployment config is needed.
    origin: string
}

export function requestOrigin(request: Request): string {
    const url = new URL(request.url)
    const proto = request.headers.get('x-forwarded-proto')?.split(',')[0].trim()
    return `${proto || url.protocol.replace(/:$/, '')}://${url.host}`
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
    const origin = requestOrigin(request)
    const token = bearerToken(request.headers.get('authorization'))
    if (!token) return { auth: null, origin }

    try {
        const claims = await verifyAccessToken(token)
        const account = await db.account.findUnique({ where: { uuid: claims.sub } })
        // A valid signature over a deleted account is still anonymous.
        if (!account) return { auth: null, origin }
        return { auth: { account, sessionUuid: claims.sid }, origin }
    } catch (err) {
        logger.warn(fileName, `rejected auth token: ${(err as Error).message}`)
        return { auth: null, origin }
    }
}
