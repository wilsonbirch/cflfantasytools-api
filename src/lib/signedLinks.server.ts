import { createHmac, timingSafeEqual } from 'node:crypto'

// Signed one-click unsubscribe links for notification emails. The token names
// the account and the club and carries an HMAC over both under APP_SECRET, so
// a link can be acted on without a session but cannot be forged or edited —
// 3DF's /api/unsubscribe took a bare account id, which is how anyone could
// flip anyone's preferences.

let _secret: string | undefined

function secret(): string {
    if (!_secret) {
        const raw = process.env.APP_SECRET
        if (!raw) throw new Error('APP_SECRET is not set; cannot sign or verify links')
        _secret = raw
    }
    return _secret
}

export const __setAppSecretForTest = (raw: string): void => {
    _secret = raw
}

const sign = (accountUuid: string, teamSlug: string): string =>
    createHmac('sha256', secret()).update(`${accountUuid}.${teamSlug}`).digest('base64url')

// uuid and slug are both URL-safe, so the token is three dot-separated parts
// that drop straight into a query string.
export const signUnsubscribeToken = (accountUuid: string, teamSlug: string): string =>
    `${accountUuid}.${teamSlug}.${sign(accountUuid, teamSlug)}`

export function verifyUnsubscribeToken(
    token: string,
): { accountUuid: string; teamSlug: string } | null {
    const [accountUuid, teamSlug, sig, ...rest] = token.split('.')
    if (!accountUuid || !teamSlug || !sig || rest.length) return null
    const expected = Buffer.from(sign(accountUuid, teamSlug))
    const given = Buffer.from(sig)
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
    return { accountUuid, teamSlug }
}
