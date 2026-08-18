import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, type Prisma } from '../src/generated/prisma/client'
import { TEAMS } from '../src/data/teams'

// Idempotent: upserts by the natural key (slug for teams, teamId+kind for
// sources), so re-running after a schema change or a URL fix is safe.
const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

async function main(): Promise<void> {
    for (const t of TEAMS) {
        const team = await prisma.team.upsert({
            where: { slug: t.slug },
            update: {
                abbreviation: t.abbreviation,
                name: t.name,
                nameFr: t.nameFr,
                shortName: t.shortName,
                city: t.city,
                geniusTeamId: t.geniusTeamId,
                gameZoneSquadId: t.gameZoneSquadId,
            },
            create: {
                slug: t.slug,
                abbreviation: t.abbreviation,
                name: t.name,
                nameFr: t.nameFr,
                shortName: t.shortName,
                city: t.city,
                geniusTeamId: t.geniusTeamId,
                gameZoneSquadId: t.gameZoneSquadId,
            },
        })

        // The scrape config is seeded, not owned, by this file: admin edits it in
        // place, so `update` deliberately does NOT reset url/strategy/config —
        // otherwise a re-seed would silently undo a mid-season fix.
        await prisma.teamSource.upsert({
            where: { teamId_kind: { teamId: team.id, kind: 'depth-chart' } },
            update: {},
            create: {
                teamId: team.id,
                kind: 'depth-chart',
                url: t.depthChartUrl,
                strategy: t.strategy,
                // TeamSeed.config is a plain object so src/data/teams.ts stays free of
                // Prisma imports; it is JSON by construction.
                config: t.config as Prisma.InputJsonValue,
                requiresBrowser: t.requiresBrowser,
            },
        })
    }

    const teams = await prisma.team.count()
    const sources = await prisma.teamSource.count()
    console.log(`Seeded ${teams} teams, ${sources} depth-chart sources`)
}

main()
    .catch((err) => {
        console.error(err)
        process.exit(1)
    })
    .finally(() => prisma.$disconnect())
