import { describe, expect, it, vi, beforeEach } from 'vitest'

const findFirst = vi.fn()
vi.mock('~/lib/db.server', () => ({ db: { job: { findFirst } } }))

const { anyStale, jobStaleness } = await import('~/services/health/staleness.server')

const HOUR = 60 * 60 * 1000
const now = new Date('2026-08-18T12:00:00Z')
const rules = [{ kind: 'gamezone-sync', everyMs: HOUR }]

beforeEach(() => findFirst.mockReset())

// A capture pipeline that fails silently is worse than one that fails loudly:
// nobody looks until the data is wanted, by which point the upstream window has
// closed and it cannot be recovered.
describe('jobStaleness', () => {
    it('reports a recent success as fresh', async () => {
        findFirst.mockResolvedValue({ finishedAt: new Date(now.getTime() - 10 * 60_000) })
        const [h] = await jobStaleness(rules, now)
        expect(h.isStale).toBe(false)
        expect(h.ageMs).toBe(10 * 60_000)
    })

    it('tolerates one missed run plus a retry', async () => {
        // 1.5 intervals — a single miss, not yet a problem.
        findFirst.mockResolvedValue({ finishedAt: new Date(now.getTime() - 1.5 * HOUR) })
        expect((await jobStaleness(rules, now))[0].isStale).toBe(false)
    })

    it('flags a job that has gone more than twice its interval', async () => {
        findFirst.mockResolvedValue({ finishedAt: new Date(now.getTime() - 3 * HOUR) })
        expect((await jobStaleness(rules, now))[0].isStale).toBe(true)
    })

    it('flags a job that has NEVER succeeded', async () => {
        // The condition most worth shouting about on a fresh deploy.
        findFirst.mockResolvedValue(null)
        const [h] = await jobStaleness(rules, now)
        expect(h.isStale).toBe(true)
        expect(h.lastSuccessAt).toBeNull()
        expect(h.ageMs).toBeNull()
    })

    it('treats a daily rule with no interval as 24h', async () => {
        findFirst.mockResolvedValue({ finishedAt: new Date(now.getTime() - 30 * HOUR) })
        const [h] = await jobStaleness([{ kind: 'nightly', atUtcHour: 9 }], now)
        expect(h.expectedEveryMs).toBe(24 * HOUR)
        expect(h.isStale).toBe(false)
    })
})

describe('anyStale', () => {
    it('is true when any single job is stale', () => {
        expect(
            anyStale([
                { kind: 'a', lastSuccessAt: now, ageMs: 0, expectedEveryMs: HOUR, isStale: false },
                {
                    kind: 'b',
                    lastSuccessAt: null,
                    ageMs: null,
                    expectedEveryMs: HOUR,
                    isStale: true,
                },
            ]),
        ).toBe(true)
    })

    it('is false when everything is fresh', () => {
        expect(
            anyStale([
                { kind: 'a', lastSuccessAt: now, ageMs: 0, expectedEveryMs: HOUR, isStale: false },
            ]),
        ).toBe(false)
    })
})
