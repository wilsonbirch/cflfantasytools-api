import { describe, expect, it, vi } from 'vitest'
import { discoverFixtures } from '~/services/pbp/discoverFixtures.server'

// The failure that cost September and October 2026: cfl.ca changed shape,
// discovery found nothing, and capture logged "0 captured" as a success for
// two months. An empty schedule is never a real answer in-season or out.
describe('discoverFixtures failure modes', () => {
    it('throws when the schedule itself is unreachable', async () => {
        const f = vi.fn(
            async () => new Response('nope', { status: 503 }),
        ) as unknown as typeof fetch
        await expect(discoverFixtures(f)).rejects.toThrow(/schedule fetch failed/)
    })

    it('throws, rather than returning nothing, when the page yields no fixtures', async () => {
        const f = vi.fn(
            async () => new Response('<html>redesigned</html>', { status: 200 }),
        ) as unknown as typeof fetch
        await expect(discoverFixtures(f)).rejects.toThrow(/0 fixtures/)
    })
})
