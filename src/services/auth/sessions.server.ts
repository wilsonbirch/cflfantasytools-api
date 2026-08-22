import { GraphQLError } from 'graphql'
import {
    ACCESS_TOKEN_TTL_MS,
    generateRefreshToken,
    hashRefreshToken,
    REFRESH_TOKEN_TTL_MS,
    signAccessToken,
} from '~/lib/auth.server'
import { db } from '~/lib/db.server'
import type { Account } from '~/generated/prisma/client'

export type IssuedTokens = { accessToken: string; accessTokenExpiresAt: Date; refreshToken: string }

const invalidRefresh = (): GraphQLError =>
    new GraphQLError('Refresh token is invalid or expired', {
        extensions: { code: 'UNAUTHENTICATED' },
    })

/** Open a new session family for an account and mint its first token pair. */
export async function issueSession(
    account: Account,
    rotatedFromId?: number,
): Promise<IssuedTokens> {
    const refreshToken = generateRefreshToken()
    const session = await db.session.create({
        data: {
            accountId: account.id,
            tokenHash: hashRefreshToken(refreshToken),
            expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
            rotatedFromId,
        },
    })
    // Stamped before signing so it can only be earlier than the real exp.
    const accessTokenExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS)
    const accessToken = await signAccessToken({
        accountUuid: account.uuid,
        role: account.role,
        sessionUuid: session.uuid,
    })
    return { accessToken, accessTokenExpiresAt, refreshToken }
}

/**
 * Revoke a session and every session rotated from it. Called when a rotated
 * (already-spent) refresh token is presented again: either the legitimate
 * client or a thief now holds a live descendant, and there is no telling
 * which, so the whole family goes.
 */
async function revokeFamily(rootId: number): Promise<void> {
    let ids = [rootId]
    while (ids.length) {
        await db.session.updateMany({
            where: { id: { in: ids }, revokedAt: null },
            data: { revokedAt: new Date() },
        })
        const next = await db.session.findMany({
            where: { rotatedFromId: { in: ids } },
            select: { id: true },
        })
        ids = next.map((s) => s.id)
    }
}

/**
 * Exchange a refresh token for a new pair. The presented token is spent: its
 * row is revoked and a new row supersedes it. A token that was already spent
 * revokes the family (see revokeFamily); an unknown or expired one is simply
 * rejected.
 */
export async function rotateSession(
    refreshToken: string,
): Promise<IssuedTokens & { account: Account }> {
    const session = await db.session.findUnique({
        where: { tokenHash: hashRefreshToken(refreshToken) },
        include: { Account: true },
    })
    if (!session) throw invalidRefresh()
    if (session.revokedAt) {
        await revokeFamily(session.id)
        throw invalidRefresh()
    }
    if (session.expiresAt.getTime() <= Date.now()) throw invalidRefresh()

    // Guarded on revokedAt so two concurrent refreshes with the same token
    // cannot both win: the loser sees count 0 and is treated as a reuse.
    const { count } = await db.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: new Date(), lastUsedAt: new Date() },
    })
    if (count !== 1) {
        await revokeFamily(session.id)
        throw invalidRefresh()
    }
    const tokens = await issueSession(session.Account, session.id)
    return { ...tokens, account: session.Account }
}

/** Revoke the session a refresh token belongs to. Unknown tokens are a no-op. */
export async function revokeSession(refreshToken: string): Promise<void> {
    await db.session.updateMany({
        where: { tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
    })
}
