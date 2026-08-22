import { beforeAll, describe, expect, it } from 'vitest'
import { __setSecretForTest } from '~/lib/auth.server'
import { db } from '~/lib/db.server'
import { issueSession } from '~/services/auth/sessions.server'
import { executeOperation } from './setup/yogaClient'

beforeAll(() => __setSecretForTest('integration-secret'))

async function tokenFor(role: 'USER' | 'ADMIN'): Promise<string> {
    const account = await db.account.create({
        data: { email: `${role.toLowerCase()}@example.test`, password: 'x', role },
    })
    return (await issueSession(account)).accessToken
}

async function seedTeamWithSource() {
    return db.team.create({
        data: {
            slug: 'calgary',
            abbreviation: 'CGY',
            name: 'Calgary',
            sources: {
                create: {
                    url: 'https://example.test/depth',
                    strategy: 'tableRowCells',
                    config: { linkCell: 1 },
                },
            },
        },
        include: { sources: true },
    })
}

const code = (r: { errors?: { extensions?: Record<string, unknown> }[] }) =>
    r.errors?.[0]?.extensions?.code

describe('authorization', () => {
    it('refuses anonymous and non-admin callers on every admin field', async () => {
        const user = await tokenFor('USER')
        const ops = [
            '{ scrapeRuns { id } }',
            '{ jobs { id } }',
            '{ teamSources { id } }',
            'mutation { updateTeamSource(id: 1, input: { enabled: false }) { id } }',
            'mutation { enqueueJob(kind: "gamezone-sync") { id } }',
        ]
        for (const query of ops) {
            expect(code(await executeOperation({ query })), query).toBe('UNAUTHENTICATED')
            expect(code(await executeOperation({ query }, { token: user })), query).toBe(
                'FORBIDDEN',
            )
        }
        expect(await db.job.count()).toBe(0)
    })
})

describe('scrapeRuns', () => {
    it('lists runs newest first, optionally per club', async () => {
        const admin = await tokenFor('ADMIN')
        const cgy = await seedTeamWithSource()
        const bc = await db.team.create({ data: { slug: 'bc', abbreviation: 'BC', name: 'BC' } })
        await db.scrapeRun.create({
            data: { teamId: cgy.id, status: 'OK', itemCount: 5, startedAt: new Date(1000) },
        })
        await db.scrapeRun.create({
            data: { teamId: bc.id, status: 'FAILED', error: 'timeout', startedAt: new Date(2000) },
        })
        const r = await executeOperation<{
            scrapeRuns: { status: string; team: { slug: string }; error: string | null }[]
            cgy: { status: string }[]
            one: { status: string }[]
        }>(
            {
                query: `{
                    scrapeRuns { status team { slug } error }
                    cgy: scrapeRuns(teamSlug: "calgary") { status }
                    one: scrapeRuns(limit: 1) { status }
                }`,
            },
            { token: admin },
        )
        expect(r.errors).toBeUndefined()
        expect(r.data?.scrapeRuns.map((s) => s.team.slug)).toEqual(['bc', 'calgary'])
        expect(r.data?.scrapeRuns[0].error).toBe('timeout')
        expect(r.data?.cgy).toEqual([{ status: 'OK' }])
        expect(r.data?.one).toEqual([{ status: 'FAILED' }])
    })
})

describe('jobs', () => {
    it('lists jobs newest first with kind and status filters', async () => {
        const admin = await tokenFor('ADMIN')
        await db.job.create({ data: { kind: 'gamezone-sync', status: 'SUCCEEDED' } })
        await db.job.create({ data: { kind: 'pbp-capture', status: 'FAILED', error: 'boom' } })
        await db.job.create({ data: { kind: 'gamezone-sync', payload: { year: 2025 } } })
        const r = await executeOperation<{
            jobs: { kind: string; status: string; payload: unknown }[]
            sync: { id: number }[]
            failed: { error: string }[]
            one: { id: number }[]
        }>(
            {
                query: `{
                    jobs { kind status payload }
                    sync: jobs(kind: "gamezone-sync") { id }
                    failed: jobs(status: FAILED) { error }
                    one: jobs(limit: 1) { id }
                }`,
            },
            { token: admin },
        )
        expect(r.errors).toBeUndefined()
        expect(r.data?.jobs.map((j) => j.kind)).toEqual([
            'gamezone-sync',
            'pbp-capture',
            'gamezone-sync',
        ])
        expect(r.data?.jobs[0].payload).toEqual({ year: 2025 })
        expect(r.data?.sync).toHaveLength(2)
        expect(r.data?.failed).toEqual([{ error: 'boom' }])
        expect(r.data?.one).toHaveLength(1)
    })
})

describe('teamSources', () => {
    it('lists sources and updates the given fields only', async () => {
        const admin = await tokenFor('ADMIN')
        const team = await seedTeamWithSource()
        const id = team.sources[0].id

        const list = await executeOperation<{
            teamSources: { id: number; url: string; team: { slug: string }; config: unknown }[]
        }>({ query: '{ teamSources { id url team { slug } config } }' }, { token: admin })
        expect(list.data?.teamSources).toEqual([
            {
                id,
                url: 'https://example.test/depth',
                team: { slug: 'calgary' },
                config: { linkCell: 1 },
            },
        ])

        const upd = await executeOperation<{
            updateTeamSource: { url: string; strategy: string; enabled: boolean; config: unknown }
        }>(
            {
                query: `mutation ($id: Int!, $input: TeamSourceInput!) {
                    updateTeamSource(id: $id, input: $input) { url strategy enabled config }
                }`,
                variables: {
                    id,
                    input: { url: 'https://example.test/2026', enabled: false, strategy: null },
                },
            },
            { token: admin },
        )
        expect(upd.errors).toBeUndefined()
        // Untouched fields keep their value; an explicit null is "leave alone".
        expect(upd.data?.updateTeamSource).toEqual({
            url: 'https://example.test/2026',
            strategy: 'tableRowCells',
            enabled: false,
            config: { linkCell: 1 },
        })

        const cfg = await executeOperation<{ updateTeamSource: { config: unknown } }>(
            {
                query: `mutation ($id: Int!, $input: TeamSourceInput!) {
                    updateTeamSource(id: $id, input: $input) { config }
                }`,
                variables: {
                    id,
                    input: { config: { lookback: 2 }, strategy: 'tableCellLookback' },
                },
            },
            { token: admin },
        )
        expect(cfg.data?.updateTeamSource.config).toEqual({ lookback: 2 })
    })

    it('rejects a bad url, an unknown strategy, a non-object config and an unknown id', async () => {
        const admin = await tokenFor('ADMIN')
        const team = await seedTeamWithSource()
        const id = team.sources[0].id
        const q = `mutation ($id: Int!, $input: TeamSourceInput!) {
            updateTeamSource(id: $id, input: $input) { id }
        }`
        for (const input of [
            { url: 'ftp://example.test' },
            { url: 'not a url' },
            { strategy: 'magic' },
            { config: [1, 2] },
        ]) {
            const r = await executeOperation(
                { query: q, variables: { id, input } },
                { token: admin },
            )
            expect(code(r), JSON.stringify(input)).toBe('BAD_USER_INPUT')
        }
        const missing = await executeOperation(
            { query: q, variables: { id: 999, input: { enabled: true } } },
            { token: admin },
        )
        expect(code(missing)).toBe('NOT_FOUND')
        const row = await db.teamSource.findUniqueOrThrow({ where: { id } })
        expect(row.url).toBe('https://example.test/depth')
    })
})

describe('enqueueJob', () => {
    it('queues a job with its payload for the worker to claim', async () => {
        const admin = await tokenFor('ADMIN')
        const r = await executeOperation<{
            enqueueJob: { id: number; kind: string; status: string; payload: unknown }
        }>(
            {
                query: `mutation { enqueueJob(kind: " pbp-parse ", payload: { year: 2024, force: true }) {
                    id kind status payload
                } }`,
            },
            { token: admin },
        )
        expect(r.errors).toBeUndefined()
        expect(r.data?.enqueueJob).toMatchObject({
            kind: 'pbp-parse',
            status: 'PENDING',
            payload: { year: 2024, force: true },
        })
        const { jobClaimNext } = await import('~/dao/job.server')
        expect((await jobClaimNext())?.kind).toBe('pbp-parse')
    })

    it('defaults the payload to an empty object and rejects a non-object one', async () => {
        const admin = await tokenFor('ADMIN')
        const ok = await executeOperation<{ enqueueJob: { payload: unknown } }>(
            { query: 'mutation { enqueueJob(kind: "epa-fit") { payload } }' },
            { token: admin },
        )
        expect(ok.data?.enqueueJob.payload).toEqual({})
        for (const payload of ['[1]', '"x"', '3']) {
            const r = await executeOperation(
                { query: `mutation { enqueueJob(kind: "epa-fit", payload: ${payload}) { id } }` },
                { token: admin },
            )
            expect(code(r), payload).toBe('BAD_USER_INPUT')
        }
        const unknown = await executeOperation(
            { query: 'mutation { enqueueJob(kind: "epa-fti") { id } }' },
            { token: admin },
        )
        expect(code(unknown)).toBe('BAD_USER_INPUT')
        expect(unknown.errors?.[0].message).toMatch(/epa-fit/)
        expect(await db.job.count()).toBe(1)
    })
})
