import { describe, expect, it, vi } from 'vitest'
import { discoverFixtures } from '~/services/pbp/discoverFixtures.server'

const SCHEDULE = `
  <a href="https://www.cfl.ca/games/1/a-vs-b/">a</a>
  <a href="https://www.cfl.ca/games/2/c-vs-d/">b</a>
`

// One club page changing shape, or cfl.ca returning a 500 for a single game,
// must never cost the rest of the season's capture.
describe('discoverFixtures resilience', () => {
    it('throws when the schedule itself is unreachable', async () => {
        const f = vi.fn(
            async () => new Response('nope', { status: 503 }),
        ) as unknown as typeof fetch
        await expect(discoverFixtures(f, 0)).rejects.toThrow(/schedule fetch failed/)
    })

    it('skips a game page that returns an error status', async () => {
        const f = vi.fn(async (url: string | URL | Request) => {
            const u = String(url)
            if (u.includes('/schedule/')) return new Response(SCHEDULE, { status: 200 })
            if (u.includes('/games/1/')) return new Response('boom', { status: 500 })
            return new Response('fixtureId=2002', { status: 200 })
        }) as unknown as typeof fetch

        const found = await discoverFixtures(f, 0)
        expect(found).toHaveLength(1)
        expect(found[0].fixtureId).toBe(2002)
    })

    it('skips a game page with no tracker embed', async () => {
        const f = vi.fn(async (url: string | URL | Request) => {
            const u = String(url)
            if (u.includes('/schedule/')) return new Response(SCHEDULE, { status: 200 })
            if (u.includes('/games/1/'))
                return new Response('<html>no embed</html>', { status: 200 })
            return new Response('fixtureId=2002', { status: 200 })
        }) as unknown as typeof fetch

        expect(await discoverFixtures(f, 0)).toHaveLength(1)
    })

    it('skips a game page that throws outright', async () => {
        const f = vi.fn(async (url: string | URL | Request) => {
            if (String(url).includes('/schedule/')) return new Response(SCHEDULE, { status: 200 })
            throw new Error('ECONNRESET')
        }) as unknown as typeof fetch

        expect(await discoverFixtures(f, 0)).toEqual([])
    })
})
