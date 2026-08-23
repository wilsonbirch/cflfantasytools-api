import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { seedCoachingStaff } from '../../prisma/seedCoachingStaff'
import { COACHING_STAFF } from '~/data/coachingStaff'
import { TEAMS } from '~/data/teams'
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

const code = (r: { errors?: { extensions?: Record<string, unknown> }[] }) =>
    r.errors?.[0]?.extensions?.code

async function seedTeams() {
    for (const t of TEAMS) {
        await db.team.create({
            data: { slug: t.slug, abbreviation: t.abbreviation, name: t.name },
        })
    }
}

describe('seedCoachingStaff', () => {
    it('seeds every hand row once, and is idempotent on re-run', async () => {
        await seedTeams()
        const first = await seedCoachingStaff(db)
        expect(first).toBe(COACHING_STAFF.length)
        expect(await db.coachingStaff.count()).toBe(COACHING_STAFF.length)

        // Re-running after a deploy must not duplicate a single row.
        await seedCoachingStaff(db)
        expect(await db.coachingStaff.count()).toBe(COACHING_STAFF.length)
    })

    it('gives every club a current head coach and coordinators', async () => {
        await seedTeams()
        await seedCoachingStaff(db)
        for (const t of TEAMS) {
            const current = await db.coachingStaff.findMany({
                where: { Team: { slug: t.slug }, effectiveTo: null },
                select: { role: true },
            })
            expect(current.map((c) => c.role).sort(), t.slug).toEqual(['DC', 'HC', 'OC'])
        }
    })

    it('names its source on every row', () => {
        // The data file carries a `// source:` comment per row — the rule is
        // never to invent a coach. Read the file rather than the array so the
        // comments themselves are checked.
        const text = readFileSync('src/data/coachingStaff.ts', 'utf8')
        const rows = text.match(/^\s*\{\s*$|^\s*\{ team:/gm)?.length ?? 0
        const sources = text.match(/\/\/ source: https?:\/\//g)?.length ?? 0
        expect(rows).toBe(COACHING_STAFF.length)
        expect(sources).toBe(COACHING_STAFF.length)
    })
})

describe('Query.coachingStaff', () => {
    it('lists a season league-wide or for one club, by team then role', async () => {
        await seedTeams()
        await seedCoachingStaff(db)
        const r = await executeOperation<{
            all: { team: { slug: string }; role: string }[]
            one: { team: { slug: string }; role: string; person: string }[]
        }>({
            query: `{
                all: coachingStaff(year: 2026) { team { slug } role }
                one: coachingStaff(year: 2026, teamSlug: "calgary-stampeders") { team { slug } role person }
            }`,
        })
        expect(r.errors).toBeUndefined()
        expect(new Set(r.data!.all.map((c) => c.team.slug)).size).toBe(TEAMS.length)
        expect(r.data!.one.every((c) => c.team.slug === 'calgary-stampeders')).toBe(true)
        // Enum order: HC, then OC, then DC.
        const rank = (role: string) => ['HC', 'OC', 'DC'].indexOf(role)
        const ranks = r.data!.one.map((c) => rank(c.role))
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
        expect(r.data!.one.length).toBeGreaterThanOrEqual(3)
    })
})

describe('Team.coachingStaff', () => {
    it('filters to staff in post at any point during the year', async () => {
        await seedTeams()
        await seedCoachingStaff(db)

        const r = await executeOperation<{
            team: {
                y2023: { role: string; person: string; effectiveTo: string | null }[]
                y2025: { role: string; person: string }[]
                all: { id: number }[]
            }
        }>({
            query: `{ team(slug: "saskatchewan-roughriders") {
                y2023: coachingStaff(year: 2023) { role person effectiveTo }
                y2025: coachingStaff(year: 2025) { role person }
                all: coachingStaff { id }
            } }`,
        })
        expect(r.errors).toBeUndefined()
        const t = r.data!.team
        // 2023: Dickenson was let go in October and Mace hired in December —
        // both were in post at some point that year.
        expect(t.y2023.filter((s) => s.role === 'HC').map((s) => s.person)).toEqual([
            'Craig Dickenson',
            'Corey Mace',
        ])
        // 2025: only the current staff.
        expect(t.y2025.filter((s) => s.role === 'HC').map((s) => s.person)).toEqual(['Corey Mace'])
        expect(t.all.length).toBeGreaterThan(t.y2025.length)
    })
})

describe('admin mutations', () => {
    const upsert = (input: string) =>
        `mutation { upsertCoachingStaff(input: ${input}) { id person role effectiveTo team { slug } } }`
    const INPUT =
        '{ teamSlug: "calgary-stampeders", role: OC, person: "Test Person", effectiveFrom: "2027-01-01T00:00:00.000Z" }'

    it('are admin only', async () => {
        await seedTeams()
        const user = await tokenFor('USER')
        for (const query of [upsert(INPUT), 'mutation { deleteCoachingStaff(id: 1) }']) {
            expect(code(await executeOperation({ query })), query).toBe('UNAUTHENTICATED')
            expect(code(await executeOperation({ query }, { token: user })), query).toBe(
                'FORBIDDEN',
            )
        }
        expect(await db.coachingStaff.count()).toBe(0)
    })

    it('upserts on (team, role, person, effectiveFrom) and deletes idempotently', async () => {
        await seedTeams()
        const admin = await tokenFor('ADMIN')

        const first = await executeOperation<{
            upsertCoachingStaff: { id: number; person: string; team: { slug: string } }
        }>({ query: upsert(INPUT) }, { token: admin })
        expect(first.errors).toBeUndefined()
        expect(first.data!.upsertCoachingStaff.team.slug).toBe('calgary-stampeders')

        // Same key with an end date: the row is updated, not duplicated.
        const second = await executeOperation<{
            upsertCoachingStaff: { id: number; person: string; effectiveTo: string | null }
        }>(
            {
                query: upsert(
                    '{ teamSlug: "calgary-stampeders", role: OC, person: "Test Person", effectiveFrom: "2027-01-01T00:00:00.000Z", effectiveTo: "2027-06-01T00:00:00.000Z" }',
                ),
            },
            { token: admin },
        )
        expect(second.errors).toBeUndefined()
        expect(second.data!.upsertCoachingStaff.id).toBe(first.data!.upsertCoachingStaff.id)
        expect(second.data!.upsertCoachingStaff.effectiveTo).toBe('2027-06-01T00:00:00.000Z')
        expect(await db.coachingStaff.count()).toBe(1)

        // Co-coordinators: a second person in the same role from the same date
        // is a second row (Toronto ran two DCs in 2024).
        const co = await executeOperation<{ upsertCoachingStaff: { id: number } }>(
            {
                query: upsert(
                    '{ teamSlug: "calgary-stampeders", role: OC, person: "Co Ordinator", effectiveFrom: "2027-01-01T00:00:00.000Z" }',
                ),
            },
            { token: admin },
        )
        expect(co.errors).toBeUndefined()
        expect(await db.coachingStaff.count()).toBe(2)

        const id = first.data!.upsertCoachingStaff.id
        const del = await executeOperation<{ deleteCoachingStaff: boolean }>(
            { query: `mutation { deleteCoachingStaff(id: ${id}) }` },
            { token: admin },
        )
        expect(del.data?.deleteCoachingStaff).toBe(true)
        const again = await executeOperation<{ deleteCoachingStaff: boolean }>(
            { query: `mutation { deleteCoachingStaff(id: ${id}) }` },
            { token: admin },
        )
        expect(again.data?.deleteCoachingStaff).toBe(false)
    })

    it('rejects bad input at the boundary', async () => {
        await seedTeams()
        const admin = await tokenFor('ADMIN')
        const cases = [
            // effectiveTo before effectiveFrom
            '{ teamSlug: "calgary-stampeders", role: HC, person: "X Y", effectiveFrom: "2027-01-01T00:00:00.000Z", effectiveTo: "2026-01-01T00:00:00.000Z" }',
            // unknown club
            '{ teamSlug: "nobody", role: HC, person: "X Y", effectiveFrom: "2027-01-01T00:00:00.000Z" }',
            // no name
            '{ teamSlug: "calgary-stampeders", role: HC, person: " ", effectiveFrom: "2027-01-01T00:00:00.000Z" }',
        ]
        for (const input of cases) {
            expect(code(await executeOperation({ query: upsert(input) }, { token: admin }))).toBe(
                'BAD_USER_INPUT',
            )
        }
        expect(await db.coachingStaff.count()).toBe(0)
    })
})
