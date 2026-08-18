/**
 * Push the scraper config in src/data/teams.ts onto existing TeamSource rows.
 *
 * prisma/seed.ts deliberately does NOT overwrite these on re-run, so that an
 * operator fixing a club mid-season is not clobbered by the next deploy. That
 * is the right default, but it means a config fix committed to the repo needs
 * an explicit push — this script — until the admin surface exists.
 *
 *   npx tsx scripts/syncTeamSourceConfig.ts [ABBR]
 */
import { TEAMS } from '~/data/teams'
import { db, type Prisma } from '~/lib/db.server'

const only = process.argv[2]?.toUpperCase()
const targets = only ? TEAMS.filter((t) => t.abbreviation === only) : TEAMS

for (const t of targets) {
    const team = await db.team.findUnique({ where: { slug: t.slug } })
    if (!team) {
        console.log(`${t.abbreviation}: no team row, skipping`)
        continue
    }
    const { count } = await db.teamSource.updateMany({
        where: { teamId: team.id, kind: 'depth-chart' },
        data: {
            url: t.depthChartUrl,
            strategy: t.strategy,
            config: t.config as Prisma.InputJsonValue,
            requiresBrowser: t.requiresBrowser,
        },
    })
    console.log(`${t.abbreviation}: ${count} source(s) updated`)
}

await db.$disconnect()
