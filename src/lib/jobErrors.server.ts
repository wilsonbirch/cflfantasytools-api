// Permanent vs transient failures, for the job loop's retry decision.
//
// The retry ladder (5 attempts, 2^n-minute backoff) exists for outages that
// clear up on their own: a timeout, a 503, a rate limit. Run against a failure
// that cannot clear up — a club's page returning 404 — it holds an off-mode
// collection open for ~30 minutes and ends exactly where the first attempt did.
//
// "Permanent" means "retrying within this run cannot help", not "never try
// again": the next scheduled run tries afresh. The classification is raised
// next to the HTTP call that knows the status, and travels as a type, so the
// loop never has to read an error message to decide.

/**
 * A failure retrying cannot fix: a 4xx, a payload no handler can act on.
 * The loop fails the job on the spot instead of scheduling a retry.
 */
export class PermanentError extends Error {
    readonly permanent = true as const

    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = 'PermanentError'
    }
}

/**
 * 4xx is the server saying the request itself is wrong (gone, forbidden, bad
 * input), so asking again gets the same answer. Except:
 *   408 Request Timeout — the server gave up waiting; a timeout by another name.
 *   429 Too Many Requests — explicitly "come back later".
 * 5xx, 3xx and anything else are treated as transient.
 */
export const isPermanentHttpStatus = (status: number): boolean =>
    status >= 400 && status < 500 && status !== 408 && status !== 429

/** A non-2xx response, classified by its status. */
export class HttpStatusError extends Error {
    readonly status: number
    readonly permanent: boolean

    constructor(status: number, message: string) {
        super(message)
        this.name = 'HttpStatusError'
        this.status = status
        this.permanent = isPermanentHttpStatus(status)
    }
}

/**
 * Whether the loop should skip the retry ladder for this error. Follows
 * `cause`, so a caller may wrap a classified error with context and keep the
 * classification. Anything unclassified — network errors, timeouts, bugs — is
 * transient: a wrong "transient" costs a few retries, a wrong "permanent"
 * costs a run's data.
 */
export function isPermanentError(err: unknown): boolean {
    let e: unknown = err
    for (let depth = 0; depth < 8 && e instanceof Error; depth += 1) {
        if (e instanceof PermanentError) return true
        if (e instanceof HttpStatusError) return e.permanent
        e = e.cause
    }
    return false
}
