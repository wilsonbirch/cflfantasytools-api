/**
 * Import 2023/2024 play-by-play out of the legacy 3 Down Fantasy database.
 *
 * The 3DF `Game.response` blobs are the only surviving copy of that
 * play-by-play — the BetGenius widget no longer serves historical fixtures — and
 * they are the whole training corpus for expected points.
 *
 * Reads LEGACY_DATABASE_URL (SELECT only, never written to) and writes into
 * DATABASE_URL. Parsing is NOT done here: imported games have a null parsedHash,
 * so the existing `pbp-parse` job normalizes them into Drive/Play on its next
 * run, through the one parser everything else uses.
 *
 *   npx tsx --env-file-if-exists=.env scripts/importLegacyGames.ts [--force] [--years 2023,2024]
 *
 * --force overwrites games already present. Without it an existing row is left
 * alone, so this cannot clobber a live capture.
 */
import { Client } from 'pg'
import {
    CORPUS_YEARS,
    importLegacyGames,
    type LegacyGameRow,
} from '~/services/pbp/importLegacyGames.server'

const legacyUrl = process.env.LEGACY_DATABASE_URL
const targetUrl = process.env.DATABASE_URL

if (!legacyUrl) {
    console.error('LEGACY_DATABASE_URL is not set (see .env.example)')
    process.exit(1)
}
if (!targetUrl) {
    console.error('DATABASE_URL is not set — nothing to import into')
    process.exit(1)
}

// Reading and writing the same database would truncate nothing but would import
// rows on top of themselves, and more importantly means one of the two URLs is
// wrong. Fail loudly rather than do something confusing.
const sameHost = (a: string, b: string): boolean => {
    try {
        const ua = new URL(a)
        const ub = new URL(b)
        return ua.host === ub.host && ua.pathname === ub.pathname
    } catch {
        return false
    }
}
if (sameHost(legacyUrl, targetUrl)) {
    console.error('LEGACY_DATABASE_URL and DATABASE_URL point at the same database — refusing')
    process.exit(1)
}

const args = process.argv.slice(2)
const force = args.includes('--force')

const yearsArg = args.indexOf('--years')
const years =
    yearsArg === -1
        ? CORPUS_YEARS
        : (args[yearsArg + 1] ?? '')
              .split(',')
              .map((y) => Number(y.trim()))
              .filter((y) => Number.isInteger(y))

if (years.length === 0) {
    console.error('--years given but no valid year parsed')
    process.exit(1)
}

if (years.includes(2022)) {
    console.warn(
        '\n⚠️  2022 is a PARTIAL capture — 22 plays per game, 41% of them scoring plays.\n' +
            '   It must not be fitted on. Importing it is only defensible for inspection.\n',
    )
}

async function main(): Promise<void> {
    const client = new Client({ connectionString: legacyUrl })
    await client.connect()

    const read = async (wanted: readonly number[]): Promise<LegacyGameRow[]> => {
        const { rows } = await client.query<{ id: number; year: number; response: string }>(
            `SELECT id, year, response FROM "Game" WHERE year = ANY($1::int[]) ORDER BY id ASC`,
            [wanted],
        )
        return rows
    }

    console.log(`\nImporting ${years.join('/')} from legacy${force ? ' (force)' : ''}...\n`)

    try {
        const summary = await importLegacyGames(read, { years, force })
        console.log('\n=== Import summary ===')
        for (const [key, value] of Object.entries(summary)) {
            console.log(`  ${key.padEnd(16)} ${String(value).padStart(6)}`)
        }
        console.log(
            '\nImported games have no parsedHash, so the next `pbp-parse` run will\n' +
                'normalize them into Drive/Play rows. To do it now:\n' +
                '  npx tsx -e "import(\'./src/services/pbp/parsePlays.server\').then(m => m.parseStoredGames())"\n',
        )
    } finally {
        await client.end()
    }
}

main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
})
