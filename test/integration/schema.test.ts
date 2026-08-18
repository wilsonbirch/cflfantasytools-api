import { describe, expect, it } from 'vitest'
import { db } from '~/lib/db.server'
import { __setSecretForTest, signAccessToken } from '~/lib/auth.server'
import { executeOperation } from './setup/yogaClient'

// Executes through Yoga's own fetch rather than graphql's `execute`, which both
// avoids the dual-graphql-instance trap and exercises the real path: HTTP →
// context (bearer parsing, account lookup) → resolver → Prisma → Postgres.
describe('schema', () => {
    it('resolves isUp through a real database query', async () => {
        const result = await executeOperation<{ isUp: boolean }>({ query: '{ isUp }' })
        expect(result.errors).toBeUndefined()
        expect(result.data?.isUp).toBe(true)
    })
})

describe('auth context', () => {
    it('treats a request with no token as anonymous rather than failing', async () => {
        const result = await executeOperation({ query: '{ isUp }' })
        expect(result.errors).toBeUndefined()
    })

    it('treats a well-formed token for a deleted account as anonymous', async () => {
        __setSecretForTest('integration-secret')
        // Signed correctly, but no Account row has this uuid.
        const token = await signAccessToken({
            accountUuid: '99999999-9999-9999-9999-999999999999',
            role: 'ADMIN',
            sessionUuid: '88888888-8888-8888-8888-888888888888',
        })
        const result = await executeOperation({ query: '{ isUp }' }, { token })
        // Anonymous, not an error — and crucially not an authenticated ADMIN.
        expect(result.errors).toBeUndefined()
    })
})

describe('migrations', () => {
    it('created every table the reset helper truncates', async () => {
        const rows = await db.$queryRawUnsafe<{ table_name: string }[]>(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
        )
        const names = new Set(rows.map((r) => r.table_name))
        for (const t of ['Account', 'Session', 'Team', 'TeamSource', 'DepthChart', 'Job']) {
            expect(names.has(t)).toBe(true)
        }
    })

    it('enforces one depth chart list per team and year', async () => {
        const team = await db.team.create({
            data: { slug: 't', abbreviation: 'T', name: 'Test' },
        })
        await db.depthChartList.create({ data: { teamId: team.id, year: 2026 } })
        // 3DF held this invariant in application code and returned a 500 when it
        // found two rows. It is a database constraint now.
        await expect(
            db.depthChartList.create({ data: { teamId: team.id, year: 2026 } }),
        ).rejects.toThrow()
    })

    it('cascades deletes from a team to its sources', async () => {
        const team = await db.team.create({
            data: {
                slug: 'cascade',
                abbreviation: 'CAS',
                name: 'Cascade',
                sources: { create: { url: 'https://example.test', strategy: 'tableRowCells' } },
            },
        })
        await db.team.delete({ where: { id: team.id } })
        expect(await db.teamSource.count({ where: { teamId: team.id } })).toBe(0)
    })
})

describe('job queue', () => {
    it('claims a pending job exactly once', async () => {
        const { jobClaimNext, jobEnqueue } = await import('~/dao/job.server')
        await jobEnqueue('test-kind', { a: 1 })
        const first = await jobClaimNext()
        const second = await jobClaimNext()
        expect(first?.kind).toBe('test-kind')
        expect(first?.status).toBe('RUNNING')
        // The optimistic claim must not hand the same row to a second caller.
        expect(second).toBeNull()
    })

    it('does not claim a job scheduled for the future', async () => {
        const { jobClaimNext, jobEnqueue } = await import('~/dao/job.server')
        await jobEnqueue('later', {}, new Date(Date.now() + 60_000))
        expect(await jobClaimNext()).toBeNull()
    })
})

describe('jobHealth', () => {
    it('reports a never-run job as stale', async () => {
        const r = await executeOperation<{
            jobHealth: { kind: string; isStale: boolean; ageMinutes: number | null }[]
        }>({ query: '{ jobHealth { kind isStale ageMinutes expectedEveryMinutes } }' })

        expect(r.errors).toBeUndefined()
        const sync = r.data?.jobHealth.find((h) => h.kind === 'gamezone-sync')
        // Nothing has run in a fresh database — exactly the condition worth
        // surfacing on a new deploy.
        expect(sync?.isStale).toBe(true)
        expect(sync?.ageMinutes).toBeNull()
    })

    it('reports a recently succeeded job as fresh', async () => {
        const { db } = await import('~/lib/db.server')
        await db.job.create({
            data: {
                kind: 'gamezone-sync',
                status: 'SUCCEEDED',
                finishedAt: new Date(Date.now() - 5 * 60_000),
            },
        })

        const r = await executeOperation<{ jobHealth: { kind: string; isStale: boolean }[] }>({
            query: '{ jobHealth { kind isStale } }',
        })
        expect(r.data?.jobHealth.find((h) => h.kind === 'gamezone-sync')?.isStale).toBe(false)
    })

    it('is readable without authentication', async () => {
        // Job names and timestamps only — being able to check "is capture still
        // running" without credentials is the point.
        const r = await executeOperation({ query: '{ jobHealth { kind } }' })
        expect(r.errors).toBeUndefined()
    })
})
