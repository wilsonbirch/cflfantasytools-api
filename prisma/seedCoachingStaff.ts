import type { PrismaClient } from '../src/generated/prisma/client'
import { COACHING_STAFF } from '../src/data/coachingStaff'

// Shared by prisma/seed.ts and the tests that prove the seed is idempotent.
//
// Upserts on the natural key (team, role, person, effectiveFrom). The seed is
// the source of truth for the rows it names, so effectiveTo is rewritten — an
// end date learned later reaches production on the next deploy. Rows an admin
// adds (any other effectiveFrom) are never touched; a correction to a seeded
// row belongs in src/data/coachingStaff.ts, with its source.
export async function seedCoachingStaff(prisma: PrismaClient): Promise<number> {
    const teams = await prisma.team.findMany({ select: { id: true, slug: true } })
    const idBySlug = new Map(teams.map((t) => [t.slug, t.id]))
    let written = 0
    for (const row of COACHING_STAFF) {
        const teamId = idBySlug.get(row.team)
        if (teamId === undefined) throw new Error(`coaching staff: unknown team slug ${row.team}`)
        const effectiveFrom = new Date(`${row.from}T00:00:00Z`)
        const effectiveTo = row.to === null ? null : new Date(`${row.to}T00:00:00Z`)
        await prisma.coachingStaff.upsert({
            where: {
                teamId_role_person_effectiveFrom: {
                    teamId,
                    role: row.role,
                    person: row.person,
                    effectiveFrom,
                },
            },
            update: { person: row.person, effectiveTo },
            create: { teamId, role: row.role, person: row.person, effectiveFrom, effectiveTo },
        })
        written += 1
    }
    return written
}
