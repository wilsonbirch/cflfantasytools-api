// Thin Resend client. A plain fetch against api.resend.com — the SDK would be
// a dependency for two POSTs.
//
// Env-gated: without RESEND_API_KEY + RESEND_FROM_EMAIL nothing sends, so dev
// machines and CI can run every code path with sending off.

const BATCH_URL = 'https://api.resend.com/emails/batch'

/** Resend's batch endpoint takes at most 100 emails per request. */
export const BATCH_SIZE = 100

export type OutboundEmail = {
    to: string
    subject: string
    text: string
    headers?: Record<string, string>
}

export const emailEnabled = (): boolean =>
    Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL)

/**
 * Send up to BATCH_SIZE emails in one request. The idempotency key makes a
 * retried request a no-op on Resend's side instead of a duplicate send — pass
 * something stable per logical batch, not per attempt.
 *
 * Returns Resend's id per email, in input order. Throws on a non-2xx response;
 * the caller owns recording failure.
 */
export async function sendBatch(
    emails: OutboundEmail[],
    idempotencyKey: string,
    fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
    if (emails.length === 0) return []
    if (emails.length > BATCH_SIZE)
        throw new Error(`batch of ${emails.length} exceeds ${BATCH_SIZE}`)
    const from = process.env.RESEND_FROM_EMAIL
    const key = process.env.RESEND_API_KEY
    if (!from || !key) throw new Error('RESEND_API_KEY / RESEND_FROM_EMAIL are not set')

    const res = await fetchImpl(BATCH_URL, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(emails.map((e) => ({ from, ...e }))),
        signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`)
    }
    const parsed = (await res.json()) as { data?: { id?: string }[] }
    return (parsed.data ?? []).map((d) => d.id ?? '')
}
