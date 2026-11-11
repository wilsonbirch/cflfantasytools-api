import { describe, expect, it } from 'vitest'
import {
    HttpStatusError,
    isPermanentError,
    isPermanentHttpStatus,
    PermanentError,
} from '~/lib/jobErrors.server'

// The job loop's retry decision. Getting it wrong in one direction holds an
// off-mode collection open ~30 minutes retrying a 404; in the other it gives
// up on an outage that would have cleared and loses the run's data.
describe('isPermanentHttpStatus', () => {
    it.each([400, 401, 403, 404, 410, 422])('%i is permanent', (status) => {
        expect(isPermanentHttpStatus(status)).toBe(true)
    })

    it.each([408, 429])('%i is a 4xx that says "try again later"', (status) => {
        expect(isPermanentHttpStatus(status)).toBe(false)
    })

    it.each([500, 502, 503, 504, 301, 304, 200])('%i is not permanent', (status) => {
        expect(isPermanentHttpStatus(status)).toBe(false)
    })
})

describe('isPermanentError', () => {
    it('honours an explicit PermanentError', () => {
        expect(isPermanentError(new PermanentError('bad payload'))).toBe(true)
    })

    it('classifies an HttpStatusError by its status', () => {
        expect(isPermanentError(new HttpStatusError(404, 'HTTP 404 Not Found'))).toBe(true)
        expect(isPermanentError(new HttpStatusError(500, 'HTTP 500'))).toBe(false)
        expect(isPermanentError(new HttpStatusError(429, 'HTTP 429'))).toBe(false)
        expect(isPermanentError(new HttpStatusError(408, 'HTTP 408'))).toBe(false)
    })

    it('keeps the classification through a wrapping cause', () => {
        const wrapped = new Error('team 3: listing failed', {
            cause: new HttpStatusError(410, 'HTTP 410 Gone'),
        })
        expect(isPermanentError(wrapped)).toBe(true)
        expect(
            isPermanentError(new Error('outer', { cause: new HttpStatusError(503, 'HTTP 503') })),
        ).toBe(false)
    })

    it('treats anything unclassified as transient', () => {
        // What undici throws when the network is down.
        expect(isPermanentError(new TypeError('fetch failed'))).toBe(false)
        expect(isPermanentError(new DOMException('timed out', 'TimeoutError'))).toBe(false)
        expect(isPermanentError(new Error('HTTP 404 Not Found'))).toBe(false)
        expect(isPermanentError('a string')).toBe(false)
        expect(isPermanentError(undefined)).toBe(false)
    })

    it('records the status on the error', () => {
        const err = new HttpStatusError(404, 'HTTP 404')
        expect(err.status).toBe(404)
        expect(err.name).toBe('HttpStatusError')
        expect(new PermanentError('x').name).toBe('PermanentError')
    })
})
