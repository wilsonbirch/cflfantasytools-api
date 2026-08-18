/**
 * Read-only reconnaissance of the legacy 3 Down Fantasy database.
 *
 * This is the go/no-go for the EPA work. The upstream BetGenius widget no
 * longer serves historical fixtures — a 2024 game now comes back as PreMatch
 * with no plays — so the `Game.response` blobs in this database are the only
 * surviving copy of 2024/2025 play-by-play. If they are truncated, unparseable
 * or empty, the expected-points model has no training data and phase 7 needs
 * re-planning before anyone schedules it.
 *
 * Issues SELECTs only. Never writes, never migrates.
 *
 *   npx tsx --env-file-if-exists=.env scripts/inspectLegacy.ts
 */
import { Client } from 'pg'

const url = process.env.LEGACY_DATABASE_URL
if (!url) {
    console.error('LEGACY_DATABASE_URL is not set (see .env.example)')
    process.exit(1)
}

const client = new Client({ connectionString: url })

const n = (v: unknown): number => Number(v ?? 0)
const pct = (part: number, whole: number): string =>
    whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`

async function tableCounts(): Promise<Map<string, number>> {
    const { rows } = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
    )
    const counts = new Map<string, number>()
    for (const { table_name } of rows) {
        const r = await client.query<{ c: string }>(
            `SELECT count(*)::text AS c FROM "${table_name}"`,
        )
        counts.set(table_name, n(r.rows[0].c))
    }
    return counts
}

async function main(): Promise<void> {
    await client.connect()

    const { rows: dbRows } = await client.query<{ db: string; version: string }>(
        'SELECT current_database() AS db, version() AS version',
    )
    console.log(`\nConnected to "${dbRows[0].db}" — ${dbRows[0].version.split(',')[0]}\n`)

    console.log('=== Row counts ===')
    const counts = await tableCounts()
    const width = Math.max(...[...counts.keys()].map((k) => k.length))
    for (const [table, count] of counts) {
        console.log(`  ${table.padEnd(width)}  ${count.toLocaleString().padStart(9)}`)
    }

    if (!counts.has('Game') || counts.get('Game') === 0) {
        console.log('\n⚠ No Game rows — there is no historical play-by-play to migrate.')
        console.log('  EPA (phase 7) would have to be built forward from live capture.\n')
        return
    }

    console.log('\n=== Game.response by year ===')
    const { rows: byYear } = await client.query<{
        year: number
        games: string
        min_len: string
        median_len: string
        max_len: string
    }>(
        `SELECT year,
                count(*)::text AS games,
                min(length(response))::text AS min_len,
                (percentile_cont(0.5) WITHIN GROUP (ORDER BY length(response)))::bigint::text AS median_len,
                max(length(response))::text AS max_len
         FROM "Game" GROUP BY year ORDER BY year`,
    )
    console.log('  year   games     min blob    median      max')
    for (const r of byYear) {
        console.log(
            `  ${r.year}   ${n(r.games).toString().padStart(5)}  ${n(r.min_len).toLocaleString().padStart(10)}  ${n(r.median_len).toLocaleString().padStart(9)}  ${n(r.max_len).toLocaleString().padStart(9)}`,
        )
    }

    // The decisive question: do the blobs still contain plays?
    console.log('\n=== Play-by-play integrity ===')
    const totalGames = counts.get('Game') ?? 0
    const { rows: parseRows } = await client.query<{ valid: string }>(
        `SELECT count(*)::text AS valid FROM "Game"
         WHERE response IS NOT NULL AND response <> '' AND (response::jsonb) IS NOT NULL`,
    )
    const parseable = n(parseRows[0].valid)
    console.log(
        `  parse as JSON            ${parseable} / ${totalGames}  (${pct(parseable, totalGames)})`,
    )

    const { rows: playRows } = await client.query<{ with_plays: string; total_plays: string }>(
        `SELECT count(*) FILTER (
                  WHERE jsonb_array_length(
                      COALESCE(response::jsonb #> '{data,playByPlayInfo,ALL}', '[]'::jsonb)
                  ) > 0
                )::text AS with_plays,
                COALESCE(sum(
                  jsonb_array_length(
                      COALESCE(response::jsonb #> '{data,playByPlayInfo,ALL}', '[]'::jsonb)
                  )
                ), 0)::text AS total_plays
         FROM "Game"
         WHERE response IS NOT NULL AND response <> ''`,
    )
    const withPlays = n(playRows[0].with_plays)
    const totalPlays = n(playRows[0].total_plays)
    console.log(
        `  contain >0 plays         ${withPlays} / ${totalGames}  (${pct(withPlays, totalGames)})`,
    )
    console.log(`  total plays recoverable  ${totalPlays.toLocaleString()}`)
    if (withPlays > 0) {
        console.log(`  mean plays per game      ${(totalPlays / withPlays).toFixed(1)}`)
    }

    console.log('\n=== Verdict ===')
    if (withPlays === 0) {
        console.log('  ✖ NO-GO — blobs exist but contain no plays. EPA needs re-planning.')
    } else if (totalPlays < 5_000) {
        console.log(`  ⚠ THIN — ${totalPlays.toLocaleString()} plays is too few for a stable`)
        console.log('    expected-points model. Usable, but expect wide confidence intervals.')
    } else {
        console.log(
            `  ✔ GO — ${totalPlays.toLocaleString()} plays across ${withPlays} games are recoverable.`,
        )
        console.log('    Back this database up off-box before anything else; it is the only copy.')
    }
    console.log()
}

main()
    .catch((err) => {
        console.error('\ninspectLegacy failed:', err instanceof Error ? err.message : err)
        process.exit(1)
    })
    .finally(() => client.end())
