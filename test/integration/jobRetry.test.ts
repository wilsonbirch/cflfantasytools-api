import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jobEnqueue, jobHasPending } from '~/dao/job.server'
import { db } from '~/lib/db.server'
import { __setAppSecretForTest } from '~/lib/signedLinks.server'
import { JOB_HANDLERS } from '~/worker/handlers.server'
import { tickOnce } from '~/worker/loop'

// Permanent vs transient failures, end to end through the real job loop and
// the real handlers. Mocked at the HTTP boundary (global fetch), so nothing
// here touches a club site or a feed.
//
// The point: a 404 retried five times with 2^n-minute backoff kept an off-mode
// collection open ~30 minutes to end in the same FAILED row. A permanent
// failure now lands FAILED on its first attempt; anything that might clear up
// on its own still takes the ladder.

const CGY = readFileSync('test/fixtures/depth-charts/calgary-stampeders.html', 'utf8')

type Route = (url: string) => Response | Promise<Response>

function stubFetch(route: Route) {
    const fn = vi.fn(async (input: string | URL | Request) => route(String(input)))
    vi.stubGlobal('fetch', fn)
    return fn
}

afterEach(() => {
    vi.unstubAllGlobals()
})

let seq = 0
async function seedClub(url: string) {
    seq += 1
    const team = await db.team.create({
        data: { slug: `club-${seq}`, abbreviation: `C${seq}`, name: `Club ${seq}` },
    })
    await db.teamSource.create({
        data: {
            teamId: team.id,
            kind: 'depth-chart',
            url,
            strategy: 'tableRowCells',
            config: { titleCells: [0, 1, 2], linkCell: 4, minCells: 5 },
        },
    })
    return team
}

const listingCalls = (fn: ReturnType<typeof stubFetch>, url: string) =>
    fn.mock.calls.filter(([u]) => String(u) === url).length

async function runOneTeamJob(status: number | 'network') {
    const url = 'https://club.test/depth-chart/'
    const team = await seedClub(url)
    const fn = stubFetch((u) => {
        if (u !== url) return new Response('not found', { status: 404 })
        if (status === 'network') throw new TypeError('fetch failed')
        return new Response('upstream says no', { status })
    })
    const job = await jobEnqueue('depth-chart-team', { teamId: team.id, year: 2026 })
    const before = Date.now()
    expect(await tickOnce(JOB_HANDLERS)).toBe(1)
    const row = await db.job.findUniqueOrThrow({ where: { id: job.id } })
    return { row, fn, url, before }
}

describe('job loop retry decision', () => {
    it('404: fails the job on the first attempt, with no retry scheduled', async () => {
        const { row, fn, url } = await runOneTeamJob(404)

        expect(row.status).toBe('FAILED')
        expect(row.attempts).toBe(1)
        expect(row.finishedAt).not.toBeNull()
        // Recorded as a final failure, and says why it was not retried.
        expect(row.error).toMatch(/^permanent \(not retried\): team \d+: HTTP 404/)

        // Nothing left to drain: the collection can idle-exit now, not in 30 minutes.
        expect(await jobHasPending()).toBe(false)
        expect(await tickOnce(JOB_HANDLERS)).toBe(0)
        expect(listingCalls(fn, url)).toBe(1)

        // The ScrapeRun health row still records the outage.
        const run = await db.scrapeRun.findFirstOrThrow()
        expect(run.status).toBe('FAILED')
        expect(run.error).toMatch(/HTTP 404/)
    })

    it('500: retried with exponential backoff, as before', async () => {
        const { row, fn, url, before } = await runOneTeamJob(500)

        expect(row.status).toBe('PENDING')
        expect(row.attempts).toBe(1)
        expect(row.error).toMatch(/^team \d+: HTTP 500/)
        // attempts = 1 -> 2^1 minutes out.
        expect(row.runAt.getTime()).toBeGreaterThanOrEqual(before + 2 * 60_000 - 1_000)
        expect(await jobHasPending()).toBe(true)

        // Bring the retry due and run it: second attempt, backoff doubles.
        await db.job.update({ where: { id: row.id }, data: { runAt: new Date() } })
        const before2 = Date.now()
        expect(await tickOnce(JOB_HANDLERS)).toBe(1)
        const again = await db.job.findUniqueOrThrow({ where: { id: row.id } })
        expect(again.status).toBe('PENDING')
        expect(again.attempts).toBe(2)
        expect(again.runAt.getTime()).toBeGreaterThanOrEqual(before2 + 4 * 60_000 - 1_000)
        expect(listingCalls(fn, url)).toBe(2)
    })

    it('500 at the attempt cap: lands FAILED exactly as it always has', async () => {
        const { row } = await runOneTeamJob(500)
        await db.job.update({ where: { id: row.id }, data: { runAt: new Date(), attempts: 4 } })
        expect(await tickOnce(JOB_HANDLERS)).toBe(1)
        const final = await db.job.findUniqueOrThrow({ where: { id: row.id } })
        expect(final).toMatchObject({ status: 'FAILED', attempts: 5 })
        expect(final.error).toMatch(/^team \d+: HTTP 500/)
    })

    it('429: retried — a rate limit is "come back later"', async () => {
        const { row } = await runOneTeamJob(429)
        expect(row.status).toBe('PENDING')
        expect(row.attempts).toBe(1)
        expect(row.error).toMatch(/HTTP 429/)
        expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + 60_000)
    })

    it('408: retried — a request timeout is transient', async () => {
        const { row } = await runOneTeamJob(408)
        expect(row.status).toBe('PENDING')
    })

    it('network error: retried', async () => {
        const { row } = await runOneTeamJob('network')
        expect(row.status).toBe('PENDING')
        expect(row.attempts).toBe(1)
        expect(row.error).toMatch(/fetch failed/)
        expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + 60_000)
    })

    it('a source still flagged requiresBrowser fails for good on attempt 1, without a fetch', async () => {
        const url = 'https://club.test/needs-a-browser/'
        const team = await seedClub(url)
        await db.teamSource.updateMany({
            where: { teamId: team.id },
            data: { requiresBrowser: true },
        })
        const fn = stubFetch(() => new Response(CGY, { status: 200 }))
        const job = await jobEnqueue('depth-chart-team', { teamId: team.id, year: 2026 })

        expect(await tickOnce(JOB_HANDLERS)).toBe(1)
        const row = await db.job.findUniqueOrThrow({ where: { id: job.id } })
        expect(row).toMatchObject({ status: 'FAILED', attempts: 1 })
        expect(row.error).toMatch(
            /^permanent \(not retried\): team \d+: browser scraping was removed/,
        )
        expect(await jobHasPending()).toBe(false)
        expect(fn).not.toHaveBeenCalled()
    })

    it('a malformed payload fails for good: no retry can supply a teamId', async () => {
        const job = await jobEnqueue('depth-chart-team', { year: 2026 })
        await tickOnce(JOB_HANDLERS)
        const row = await db.job.findUniqueOrThrow({ where: { id: job.id } })
        expect(row).toMatchObject({ status: 'FAILED', attempts: 1 })
        expect(row.error).toMatch(/requires a teamId/)
    })

    it('403: fails the job on the first attempt, like any other permanent 4xx', async () => {
        const { row } = await runOneTeamJob(403)
        expect(row).toMatchObject({ status: 'FAILED', attempts: 1 })
        expect(row.error).toMatch(/^permanent \(not retried\): team \d+: HTTP 403/)
        expect(await jobHasPending()).toBe(false)
    })

    it('a club with no depth-chart source fails for good: retrying reads the same row', async () => {
        const team = await db.team.create({
            data: { slug: 'no-source', abbreviation: 'NOS', name: 'No Source' },
        })
        const fn = stubFetch(() => new Response('unexpected', { status: 500 }))
        const job = await jobEnqueue('depth-chart-team', { teamId: team.id, year: 2026 })
        await tickOnce(JOB_HANDLERS)
        const row = await db.job.findUniqueOrThrow({ where: { id: job.id } })
        expect(row).toMatchObject({ status: 'FAILED', attempts: 1 })
        expect(row.error).toMatch(/permanent \(not retried\).*no depth-chart source/)
        expect(fn).not.toHaveBeenCalled()
    })

    it('pbp-capture: a 4xx on the schedule page still takes the retry ladder', async () => {
        // The one response that decides a whole perishable-data run, and a
        // FAILED row would also keep the schedule from re-enqueueing it for
        // six hours. So no status on the schedule fetch is treated as permanent.
        for (const status of [404, 403, 503]) {
            stubFetch(() => new Response('no', { status }))
            const job = await jobEnqueue('pbp-capture', { year: 2026 })
            await tickOnce(JOB_HANDLERS)
            const row = await db.job.findUniqueOrThrow({ where: { id: job.id } })
            expect(row).toMatchObject({ status: 'PENDING', attempts: 1 })
            expect(row.error).toMatch(new RegExp(`schedule fetch failed: HTTP ${status}`))
        }
    })
})

describe('chart-alert handler', () => {
    beforeEach(async () => {
        process.env.RESEND_API_KEY = 'test-key'
        process.env.RESEND_FROM_EMAIL = 'Alerts <alerts@alerts.example.com>'
        __setAppSecretForTest('test-secret')
    })

    afterEach(() => {
        delete process.env.RESEND_API_KEY
        delete process.env.RESEND_FROM_EMAIL
    })

    async function alertJob(scrapeRunId: number) {
        const team = await seedClub('https://club.test/charts/')
        const account = await db.account.create({
            data: {
                email: `fan-${scrapeRunId}@example.com`,
                password: 'x',
                uuid: `u-${scrapeRunId}`,
            },
        })
        await db.notificationSubscription.create({
            data: { accountId: account.id, teamId: team.id, enabled: true },
        })
        return jobEnqueue('chart-alert', { teamId: team.id, scrapeRunId, added: 1, revised: 0 })
    }

    it('a batch Resend refuses with a 4xx fails the job for good', async () => {
        stubFetch(() => new Response('{"message":"domain not verified"}', { status: 403 }))
        const job = await alertJob(201)
        await tickOnce(JOB_HANDLERS)
        const row = await db.job.findUniqueOrThrow({ where: { id: job.id } })
        expect(row).toMatchObject({ status: 'FAILED', attempts: 1 })
        expect(row.error).toMatch(/^permanent \(not retried\): 1 of 1 sends failed/)
    })

    it('a 5xx from Resend takes the retry ladder', async () => {
        stubFetch(() => new Response('{"message":"internal"}', { status: 500 }))
        const job = await alertJob(202)
        await tickOnce(JOB_HANDLERS)
        const row = await db.job.findUniqueOrThrow({ where: { id: job.id } })
        expect(row).toMatchObject({ status: 'PENDING', attempts: 1 })
        expect(row.error).toBe('1 of 1 sends failed')
    })
})

describe('a depth-chart sweep with one dead club', () => {
    it('scrapes every other club; only the dead one fails, and without retrying', async () => {
        const dead = 'https://dead.test/depth-chart/'
        const live = ['https://one.test/charts/', 'https://two.test/charts/']
        const deadTeam = await seedClub(dead)
        const liveTeams = [await seedClub(live[0]), await seedClub(live[1])]

        const fn = stubFetch((u) => {
            if (live.includes(u)) return new Response(CGY, { status: 200 })
            // The dead club's listing, and every chart PDF the archiver asks
            // for (its failures are logged inside, never fatal).
            return new Response('not found', { status: 404 })
        })

        // The sweep fans out one job per club; the same tick drains them all.
        await jobEnqueue('depth-chart-sweep', { year: 2026 })
        expect(await tickOnce(JOB_HANDLERS)).toBe(4)

        const sweep = await db.job.findFirstOrThrow({ where: { kind: 'depth-chart-sweep' } })
        expect(sweep.status).toBe('SUCCEEDED')

        const jobs = await db.job.findMany({ where: { kind: 'depth-chart-team' } })
        const byTeam = new Map(jobs.map((j) => [(j.payload as { teamId: number }).teamId, j]))
        for (const t of liveTeams) expect(byTeam.get(t.id)?.status).toBe('SUCCEEDED')
        expect(byTeam.get(deadTeam.id)).toMatchObject({ status: 'FAILED', attempts: 1 })

        // Both live clubs were actually scraped and their snapshots stored.
        for (const url of live) expect(listingCalls(fn, url)).toBe(1)
        expect(await db.depthChartList.count()).toBe(2)
        const runs = await db.scrapeRun.findMany()
        expect(runs.filter((r) => r.status === 'OK')).toHaveLength(2)
        expect(runs.filter((r) => r.status === 'FAILED')).toHaveLength(1)

        // And the queue is empty, so the collection ends now.
        expect(await jobHasPending()).toBe(false)
    })
})
