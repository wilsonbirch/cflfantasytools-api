/**
 * Recompute DepthChart.season/week from what each chart's title and filename
 * say about its game (src/services/depthCharts/chartWeek.ts), for the charts
 * stamped with the week they were first SEEN — notably the November 2026
 * backfill, which filed weeks 14–21 and the playoffs under the week the fixed
 * scraper caught up.
 *
 * DRY RUN by default: prints every chart's old and new week with the evidence
 * and writes nothing. --apply writes the rows that change (DepthChart and the
 * week copied onto its DepthChartPosition rows). A chart that says nothing
 * usable is left as it is.
 *
 * A year with no Gameweek rows (the legacy 2024/2025 seasons) can only be
 * re-derived from printed weeks and hardcoded date math, which would overwrite
 * weeks 3DF recorded live. --apply refuses such a year unless
 * --allow-date-math is given as well.
 *
 * DATABASE_URL must be given explicitly — the script never reads .env:
 *
 *   DATABASE_URL=postgres://… npx tsx --env-file-if-exists=/dev/null \
 *       scripts/rederiveDepthChartWeeks.ts --year 2026 [--team SSK] [--changed] [--apply [--allow-date-math]]
 */
import { parseArgs } from 'node:util'

const { values } = parseArgs({
    options: {
        year: { type: 'string' },
        team: { type: 'string' },
        apply: { type: 'boolean', default: false },
        changed: { type: 'boolean', default: false },
        'allow-date-math': { type: 'boolean', default: false },
    },
})

const url = process.env.DATABASE_URL
if (!url) {
    console.error('DATABASE_URL is not set. Pass it explicitly; this script never reads .env.')
    process.exit(1)
}
const year = Number(values.year)
if (!Number.isInteger(year) || year < 2000) {
    console.error('--year is required, e.g. --year 2026')
    process.exit(1)
}

const target = (() => {
    try {
        const u = new URL(url)
        return `${u.hostname}:${u.port || '5432'}${u.pathname}`
    } catch {
        return '(unparseable DATABASE_URL)'
    }
})()
const team = values.team?.toUpperCase()
console.log(
    `${values.apply ? 'APPLY' : 'DRY RUN'} against ${target}, year ${year}` +
        (team ? `, team ${team}` : ''),
)

// Imported only now, so the Prisma client is built from the URL checked above.
const { rederiveChartWeeks } = await import('~/services/depthCharts/chartWeek.server')
const { db } = await import('~/lib/db.server')

const gameweeks = await db.gameweek.count({ where: { year } })
const matches = await db.match.count({ where: { year, date: { not: null } } })
console.log(`schedule: ${gameweeks} gameweek(s), ${matches} dated match(es)`)
if (gameweeks === 0) {
    console.log(
        'WARNING: no gameweeks for this year — weeks fall back to printed weeks and date math',
    )
    if (values.apply && !values['allow-date-math']) {
        console.error(
            'Refusing to --apply without gameweeks: that would overwrite weeks from date math. ' +
                'Review the dry run, then add --allow-date-math if you really mean it.',
        )
        await db.$disconnect()
        process.exit(1)
    }
}

const rows = await rederiveChartWeeks({ year, team, apply: values.apply })
const fmt = (s: { season: string; week: number }) => `${s.season} ${s.week}`.padEnd(10)
for (const r of rows) {
    if (values.changed && !r.changed) continue
    console.log(
        `${r.changed ? '*' : ' '} #${String(r.id).padEnd(5)} ${r.team.padEnd(3)} ` +
            `${fmt(r.old)} → ${r.new ? fmt(r.new) : 'unchanged '} ${(r.source ?? '-').padEnd(12)} ` +
            `| ${r.title} | ${r.evidence}`,
    )
}

const bySource = new Map<string, number>()
for (const r of rows) bySource.set(r.source ?? 'none', (bySource.get(r.source ?? 'none') ?? 0) + 1)
const changed = rows.filter((r) => r.changed).length
const disagree = rows.filter((r) => r.evidence.includes('DISAGREES')).length
console.log(
    `\n${rows.length} chart(s); ${changed} ${values.apply ? 'updated' : 'would change'}; ` +
        `by source: ${[...bySource].map(([s, n]) => `${s} ${n}`).join(', ')}` +
        (disagree ? `; ${disagree} where the printed week disagrees with the schedule` : ''),
)
if (!values.apply && changed) console.log('Nothing written. Re-run with --apply to write.')
await db.$disconnect()
