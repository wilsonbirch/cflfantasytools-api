import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { wakeWorker } from '~/lib/flyMachines.server'

const WORKER = { id: 'm1', state: 'stopped', config: { metadata: { fly_process_group: 'worker' } } }
const WEB = { id: 'm2', state: 'started', config: { metadata: { fly_process_group: 'web' } } }

beforeEach(() => {
    process.env.FLY_MACHINES_TOKEN = 'test-token'
    process.env.FLY_APP_NAME = 'cflfantasytools-api'
})
afterEach(() => {
    delete process.env.FLY_MACHINES_TOKEN
    delete process.env.FLY_APP_NAME
})

// Waking is best-effort: a failure must never propagate, because the worker's
// next boot picks the job up from the queue regardless.
describe('wakeWorker', () => {
    it('starts a stopped worker machine', async () => {
        const f = vi.fn(async (url: string | URL | Request) => {
            if (String(url).endsWith('/machines')) {
                return new Response(JSON.stringify([WORKER, WEB]), { status: 200 })
            }
            return new Response('{}', { status: 200 })
        }) as unknown as typeof fetch

        expect(await wakeWorker(f)).toBe(true)
        expect(
            vi.mocked(f).mock.calls.some(([u]) => String(u).includes('/machines/m1/start')),
        ).toBe(true)
    })

    it('never touches a web machine', async () => {
        const f = vi.fn(async (url: string | URL | Request) =>
            String(url).endsWith('/machines')
                ? new Response(JSON.stringify([WEB]), { status: 200 })
                : new Response('{}', { status: 200 }),
        ) as unknown as typeof fetch

        expect(await wakeWorker(f)).toBe(false)
        expect(vi.mocked(f).mock.calls.some(([u]) => String(u).includes('/start'))).toBe(false)
    })

    it('does nothing when the worker is already running', async () => {
        const f = vi.fn(async (url: string | URL | Request) =>
            String(url).endsWith('/machines')
                ? new Response(JSON.stringify([{ ...WORKER, state: 'started' }]), { status: 200 })
                : new Response('{}', { status: 200 }),
        ) as unknown as typeof fetch
        expect(await wakeWorker(f)).toBe(false)
    })

    it('returns false rather than throwing when the API errors', async () => {
        const f = vi.fn(
            async () => new Response('nope', { status: 401 }),
        ) as unknown as typeof fetch
        await expect(wakeWorker(f)).resolves.toBe(false)
    })

    it('is a no-op when the token is not configured', async () => {
        delete process.env.FLY_MACHINES_TOKEN
        const f = vi.fn() as unknown as typeof fetch
        expect(await wakeWorker(f)).toBe(false)
        expect(vi.mocked(f)).not.toHaveBeenCalled()
    })
})
