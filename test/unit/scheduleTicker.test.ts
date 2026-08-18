import { describe, expect, it, vi, beforeEach } from 'vitest'

const enqueueDueSchedules = vi.fn()
const jobHasPending = vi.fn()
const jobStaleness = vi.fn()
const wakeWorker = vi.fn()
const error = vi.fn()
const info = vi.fn()

vi.mock('~/worker/loop', () => ({ enqueueDueSchedules }))
vi.mock('~/dao/job.server', () => ({ jobHasPending }))
vi.mock('~/services/health/staleness.server', () => ({ jobStaleness }))
vi.mock('~/lib/flyMachines.server', () => ({ wakeWorker }))
vi.mock('~/lib/logger.server', () => ({ logger: { error, info, warn: vi.fn(), debug: vi.fn() } }))

const { runScheduleTick, startScheduleTicker, stopScheduleTicker } =
    await import('~/services/health/scheduleTicker.server')

beforeEach(() => {
    vi.clearAllMocks()
    jobStaleness.mockResolvedValue([])
    enqueueDueSchedules.mockResolvedValue(0)
    jobHasPending.mockResolvedValue(false)
    stopScheduleTicker()
})

describe('runScheduleTick', () => {
    it('wakes the worker when it enqueued something', async () => {
        enqueueDueSchedules.mockResolvedValue(2)
        jobHasPending.mockResolvedValue(true)
        await runScheduleTick()
        expect(wakeWorker).toHaveBeenCalledOnce()
    })

    it('does not wake the worker when there is no pending work', async () => {
        await runScheduleTick()
        // Most ticks do nothing; waking a sleeping machine every minute would
        // defeat the point of letting it sleep.
        expect(wakeWorker).not.toHaveBeenCalled()
    })

    it('RETRIES the wake for work already pending from an earlier tick', async () => {
        // The regression that stranded depth-chart-sweep in production: the
        // schedule will not re-enqueue a kind that already has a recent row, so
        // if the wake is only attempted at enqueue time, one failed wake leaves
        // the job PENDING with the worker asleep forever.
        enqueueDueSchedules.mockResolvedValue(0)
        jobHasPending.mockResolvedValue(true)
        await runScheduleTick()
        expect(wakeWorker).toHaveBeenCalledOnce()
    })

    it('logs an error for each stale job', async () => {
        jobStaleness.mockResolvedValue([
            {
                kind: 'gamezone-sync',
                lastSuccessAt: null,
                ageMs: null,
                expectedEveryMs: 3_600_000,
                isStale: true,
            },
            {
                kind: 'pbp-capture',
                lastSuccessAt: new Date(),
                ageMs: 0,
                expectedEveryMs: 3_600_000,
                isStale: false,
            },
        ])
        await runScheduleTick()
        expect(error).toHaveBeenCalledOnce()
        expect(error.mock.calls[0][1]).toMatch(/STALE: gamezone-sync .*never/)
    })

    it('survives a failing tick instead of killing the interval', async () => {
        enqueueDueSchedules.mockRejectedValue(new Error('database gone'))
        // If one bad tick could throw out of the interval, the trigger would
        // stop permanently and capture would go quiet.
        await expect(runScheduleTick()).resolves.toBeUndefined()
        expect(error.mock.calls[0][1]).toMatch(/tick failed: database gone/)
    })

    it('still reports staleness even when the wake fails', async () => {
        enqueueDueSchedules.mockResolvedValue(1)
        jobHasPending.mockResolvedValue(true)
        wakeWorker.mockRejectedValue(new Error('no token'))
        await runScheduleTick()
        expect(error.mock.calls[0][1]).toMatch(/tick failed/)
    })
})

describe('startScheduleTicker', () => {
    it('does nothing unless explicitly enabled', () => {
        delete process.env.SCHEDULE_TICKER_ENABLED
        startScheduleTicker()
        // A local shell or a test run must never start enqueueing real jobs.
        expect(enqueueDueSchedules).not.toHaveBeenCalled()
    })

    it('runs immediately on start rather than waiting a full interval', async () => {
        process.env.SCHEDULE_TICKER_ENABLED = 'true'
        startScheduleTicker()
        await vi.waitFor(() => expect(enqueueDueSchedules).toHaveBeenCalled())
        stopScheduleTicker()
        delete process.env.SCHEDULE_TICKER_ENABLED
    })
})
