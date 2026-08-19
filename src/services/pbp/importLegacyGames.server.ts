// Import 2023/2024 play-by-play from the legacy 3 Down Fantasy database.
//
// WHY THIS EXISTS AT ALL: the BetGenius widget serves current-season data only —
// a 2024 fixture now comes back as PreMatch with no plays. The `Game.response`
// blobs in the 3DF database are the ONLY surviving copy of 2023/24 play-by-play,
// and they are the entire training corpus for expected points. See
// docs/memory/project-cfl-rule-eras.md.
//
// WHY IT IS A SCRIPT AND NOT A JOB: the legacy Postgres is not reachable from
// production. It binds to localhost on the 3DF host, so the working copy is a
// local restore of a dump. This runs from a machine that can see both databases;
// a scheduled job could never do it.
//
// The payloads are stored raw and NOT parsed here. `pbp-parse` picks them up on
// its own, because an imported game has a null `parsedHash` and so reads as
// stale — which keeps one parser as the single path into Drive/Play.

import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import { ruleEraForYear } from '~/lib/season.server'

const fileName = 'services/pbp/importLegacyGames'

/**
 * The seasons worth importing.
 *
 * 2022 IS DELIBERATELY EXCLUDED and is not a matter of taste. It is a partial
 * capture — 22 plays per game against a true rate near 150, and 41% of those
 * plays are scoring plays. Fitting expected points on it would teach the model
 * that almost every snap ends in points. It is in the dump; it must not be in
 * the corpus.
 */
export const CORPUS_YEARS: readonly number[] = [2023, 2024]

/** One row as it exists in the legacy `Game` table. */
export type LegacyGameRow = {
    id: number
    year: number
    response: string
}

/**
 * Reads candidate rows out of the legacy database.
 *
 * Injected rather than imported so the logic below is testable without a second
 * Postgres — the same shape as `capturePbp(year, fetchImpl)`.
 */
export type LegacyGameReader = (years: readonly number[]) => Promise<LegacyGameRow[]>

export type ImportSummary = {
    read: number
    imported: number
    updated: number
    skippedEmpty: number
    skippedExisting: number
    rejected: number
}

export type EvaluatedGame =
    | { ok: true; fixtureId: number; year: number; response: string; plays: number }
    | { ok: false; reason: string }

type LegacyPayload = {
    data?: {
        betGeniusFixtureId?: string | number
        playByPlayInfo?: { ALL?: unknown[] }
    }
}

/**
 * Decide whether one legacy row is importable, and under which id.
 *
 * PURE — no database, no clock. This is the part worth testing exhaustively.
 *
 * THE ID IS NOT THE LEGACY PRIMARY KEY BY COINCIDENCE. `Game.id` in this schema
 * is the BetGenius fixture id (capturePbp upserts on `fixture.fixtureId`), and
 * 3DF happened to key its own table the same way — verified across all 190
 * rows, where `Game.id` equals `data.betGeniusFixtureId` every time. The id is
 * still read from the PAYLOAD rather than trusted from the row, because the
 * payload is the authority on which fixture it describes: a mismatch means the
 * row is mislabelled and importing it under the wrong id would silently
 * overwrite a different game.
 */
export function evaluateLegacyGame(row: LegacyGameRow): EvaluatedGame {
    let payload: LegacyPayload
    try {
        payload = JSON.parse(row.response) as LegacyPayload
    } catch {
        return { ok: false, reason: `game ${row.id}: response is not valid JSON` }
    }

    const rawId = payload.data?.betGeniusFixtureId
    if (rawId === undefined || rawId === null || !/^\d+$/.test(String(rawId))) {
        return {
            ok: false,
            reason: `game ${row.id}: payload carries no numeric betGeniusFixtureId`,
        }
    }
    const fixtureId = Number(rawId)

    if (fixtureId !== row.id) {
        return {
            ok: false,
            reason: `game ${row.id}: payload describes fixture ${fixtureId} — refusing to import a mislabelled row`,
        }
    }

    const plays = payload.data?.playByPlayInfo?.ALL
    if (!Array.isArray(plays) || plays.length === 0) {
        return { ok: false, reason: `game ${row.id}: payload has no plays` }
    }

    return { ok: true, fixtureId, year: row.year, response: row.response, plays: plays.length }
}

/**
 * Copy legacy games into this project's `Game` table.
 *
 * An existing row is left alone unless `force` is set. That is the important
 * default: fixture ids share one space across seasons, so a bad `year` on a
 * legacy row could otherwise land on top of a good current-season capture. The
 * only thing worse than missing history is destroying the present to get it.
 */
export async function importLegacyGames(
    read: LegacyGameReader,
    options: { years?: readonly number[]; force?: boolean } = {},
): Promise<ImportSummary> {
    const years = options.years ?? CORPUS_YEARS
    const force = options.force ?? false

    const summary: ImportSummary = {
        read: 0,
        imported: 0,
        updated: 0,
        skippedEmpty: 0,
        skippedExisting: 0,
        rejected: 0,
    }

    const rows = await read(years)
    summary.read = rows.length

    for (const row of rows) {
        const evaluated = evaluateLegacyGame(row)
        if (!evaluated.ok) {
            // A payload with no plays is an unplayed fixture, not a fault. A
            // payload that will not parse, or that names a different fixture, is.
            if (evaluated.reason.endsWith('has no plays')) summary.skippedEmpty += 1
            else summary.rejected += 1
            logger.warn(fileName, evaluated.reason)
            continue
        }

        const existing = await db.game.findUnique({
            where: { id: evaluated.fixtureId },
            select: { id: true },
        })

        if (existing && !force) {
            summary.skippedExisting += 1
            continue
        }

        // `parsedHash`/`parsedAt`/`playCount` are deliberately left null: that is
        // exactly what makes `pbp-parse` treat the game as stale and normalize it
        // on its next run. Setting them here would claim a parse that never ran.
        await db.game.upsert({
            where: { id: evaluated.fixtureId },
            update: { response: evaluated.response, year: evaluated.year },
            create: { id: evaluated.fixtureId, response: evaluated.response, year: evaluated.year },
        })

        if (existing) summary.updated += 1
        else summary.imported += 1
    }

    const eras = [...new Set(years.map(ruleEraForYear))].join(', ')
    logger.info(
        fileName,
        `imported ${summary.imported} new, ${summary.updated} updated from ${summary.read} legacy ` +
            `row(s) for ${years.join('/')} (${eras}): ${summary.skippedExisting} already present, ` +
            `${summary.skippedEmpty} empty, ${summary.rejected} rejected`,
    )
    return summary
}
