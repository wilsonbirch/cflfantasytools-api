// Fit the expected-points surface, and write EPA back onto every play.
//
// Two halves, deliberately separable: fitting reads drives and produces EpValue
// rows; applying reads EpValue and writes Play.epa. Both are idempotent and both
// rebuild from scratch, because the raw payload is retained and a model bug
// should be a refit rather than a data loss — the same contract as the parser.

import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import type { RuleEra } from '~/lib/season.server'
import { yardsFromOwnGoal } from '~/services/pbp/parseDescription'
import { fieldLengthForEra } from '~/services/pbp/parsePlays.server'
import {
    buildEpLookup,
    epaForPlays,
    EP_SOURCE_ERA,
    fitCells,
    MIN_SAMPLE,
    type EpaPlay,
    type EpCell,
    type TrainingRow,
} from './epModel'

const fileName = 'services/epa/fitEp'

export type FitSummary = {
    era: RuleEra
    rows: number
    cells: number
    thinCells: number
}

export type ApplySummary = {
    games: number
    plays: number
    scored: number
    unpriced: number
    skippedEra: number
}

/**
 * The training set: every play with a real game state, on a drive whose eventual
 * next score is known.
 *
 * Four filters, each of which would corrupt the fit if dropped:
 *
 *  - `nextPointOutcome IS NOT NULL` — the drive reached the end of a half with no
 *    further score, so what it was worth is simply unobserved. Reading that as
 *    zero would teach the model that a first down at midfield is worthless.
 *  - `isNoPlay = false` — a penalty wiped the snap. It occupied no down.
 *  - down and yard line present — kickoffs and converts have no line of
 *    scrimmage and no state to price.
 *  - the era matches — 2023/24 and 2027 are not the same game. See
 *    docs/memory/project-cfl-rule-eras.md.
 */
async function trainingRows(era: RuleEra): Promise<TrainingRow[]> {
    const rows = await db.$queryRaw<
        { down: number; distance: string; yardLine: number; nextPointOutcome: number }[]
    >`
        SELECT p."down", p."distance", p."yardLine", d."nextPointOutcome"
        FROM "Play" p
        JOIN "Drive" d ON d.id = p."driveId"
        WHERE p."ruleEra" = ${era}::"RuleEra"
          AND p."down" IS NOT NULL
          AND p."yardLine" IS NOT NULL
          AND p."distance" IS NOT NULL
          AND p."isNoPlay" = false
          AND d."nextPointOutcome" IS NOT NULL`

    const fieldLength = fieldLengthForEra(era)
    const training: TrainingRow[] = []
    for (const row of rows) {
        const distance = Number(row.distance)
        const ygo = yardsFromOwnGoal(row.yardLine, fieldLength)
        if (!Number.isFinite(distance) || ygo === null) continue
        training.push({
            down: row.down,
            distance,
            yardsFromOwnGoal: ygo,
            nextPointOutcome: row.nextPointOutcome,
        })
    }
    return training
}

/**
 * Fit one era's surface and store it.
 *
 * Replaces the era's cells wholesale in a transaction, so a refit is never half
 * applied and the table never mixes two fits of the same era.
 */
export async function fitEpModel(era: RuleEra): Promise<FitSummary> {
    const rows = await trainingRows(era)
    const cells = fitCells(rows, fieldLengthForEra(era))
    const thinCells = cells.filter((c) => c.sampleSize < MIN_SAMPLE).length

    await db.$transaction(async (tx) => {
        await tx.epValue.deleteMany({ where: { ruleEra: era } })
        if (cells.length > 0) {
            await tx.epValue.createMany({
                data: cells.map((c) => ({
                    ruleEra: era,
                    down: c.down,
                    distanceBucket: c.distanceBucket,
                    yardLineBucket: c.yardLineBucket,
                    expectedPoints: c.expectedPoints,
                    sampleSize: c.sampleSize,
                })),
            })
        }
    })

    logger.info(
        fileName,
        `fitted ${era}: ${cells.length} cells from ${rows.length} plays ` +
            `(${thinCells} below the ${MIN_SAMPLE}-play threshold, pooled at lookup)`,
    )
    return { era, rows: rows.length, cells: cells.length, thinCells }
}

/** Load a stored surface back out. */
export async function loadCells(era: RuleEra): Promise<EpCell[]> {
    const rows = await db.epValue.findMany({
        where: { ruleEra: era },
        select: {
            down: true,
            distanceBucket: true,
            yardLineBucket: true,
            expectedPoints: true,
            sampleSize: true,
        },
    })
    return rows
}

/** Mirrors drives.ts halfKey; a scoring search may not cross a half. */
const halfOf = (phase: string, quarter: string): string => {
    if (phase === 'Overtime') return 'OT'
    return Number(quarter) <= 2 ? 'H1' : 'H2'
}

/**
 * Write EPA onto every play of every parsed game.
 *
 * The surface an era is priced with is not always its own — 2026 borrows the
 * 2023/24 fit because the field did not change, while 2027 borrows nothing at
 * all and is skipped outright. See EP_SOURCE_ERA.
 */
export async function applyEpa(year?: number): Promise<ApplySummary> {
    const summary: ApplySummary = { games: 0, plays: 0, scored: 0, unpriced: 0, skippedEra: 0 }

    // One lookup per source era, built once and reused across every game.
    const lookups = new Map<RuleEra, ReturnType<typeof buildEpLookup> | null>()
    const lookupFor = async (era: RuleEra) => {
        if (!lookups.has(era)) {
            const source = EP_SOURCE_ERA[era]
            if (source === null) {
                lookups.set(era, null)
            } else {
                const cells = await loadCells(source)
                lookups.set(
                    era,
                    cells.length === 0
                        ? null
                        : buildEpLookup(cells, MIN_SAMPLE, fieldLengthForEra(era)),
                )
            }
        }
        return lookups.get(era) ?? null
    }

    const games = await db.game.findMany({
        where: { parsedAt: { not: null }, ...(year === undefined ? {} : { year }) },
        select: { id: true, ruleEra: true },
        orderBy: { id: 'asc' },
    })

    for (const game of games) {
        const era = game.ruleEra
        if (era === null) continue

        const lookup = await lookupFor(era)
        if (lookup === null) {
            summary.skippedEra += 1
            continue
        }

        // Ordered by drive then play: the sequence logic depends on chronology,
        // and reading it back out of the database is where that could silently
        // be lost.
        const plays = await db.play.findMany({
            where: { gameId: game.id },
            select: {
                id: true,
                number: true,
                driveId: true,
                geniusTeamId: true,
                down: true,
                distance: true,
                yardLine: true,
                points: true,
                isNoPlay: true,
                phase: true,
                phaseQualifier: true,
                Drive: { select: { geniusTeamId: true, number: true } },
            },
            orderBy: [{ Drive: { number: 'asc' } }, { number: 'asc' }],
        })
        if (plays.length === 0) continue

        const fieldLength = fieldLengthForEra(era)
        const input: EpaPlay[] = plays.map((p) => ({
            driveTeamId: p.Drive.geniusTeamId,
            playTeamId: p.geniusTeamId,
            half: halfOf(p.phase, p.phaseQualifier),
            down: p.down,
            distance: p.distance === null ? null : Number(p.distance),
            yardsFromOwnGoal: yardsFromOwnGoal(p.yardLine, fieldLength),
            points: p.points,
            isNoPlay: p.isNoPlay,
        }))

        const values = epaForPlays(input, lookup)

        // One statement, not one per play. A per-row update loop is 28,263
        // round trips over the corpus, which turns a repricing into a coffee
        // break; unnest pairs the ids with their values server-side.
        await db.$executeRaw`
            UPDATE "Play" AS p
            SET "epa" = v.epa
            FROM (
                SELECT unnest(${plays.map((p) => p.id)}::int[]) AS id,
                       unnest(${values}::double precision[]) AS epa
            ) AS v
            WHERE p.id = v.id`

        summary.games += 1
        summary.plays += plays.length
        summary.scored += values.filter((v) => v !== null).length
        summary.unpriced += values.filter((v) => v === null).length
    }

    logger.info(
        fileName,
        `epa: ${summary.scored} of ${summary.plays} plays priced across ${summary.games} game(s), ` +
            `${summary.unpriced} unpriced, ${summary.skippedEra} game(s) skipped for want of an era surface`,
    )
    return summary
}

/**
 * Refit every era that has training data, then reprice every play.
 *
 * This is what the scheduled job runs. Fitting is cheap — a few aggregates over
 * tens of thousands of rows — and repricing is a bulk update, so doing both
 * together keeps the stored EPA consistent with the stored surface at all times.
 */
export async function refitAndApply(): Promise<{ fits: FitSummary[]; applied: ApplySummary }> {
    const eras = await db.play.findMany({
        where: { ruleEra: { not: null } },
        select: { ruleEra: true },
        distinct: ['ruleEra'],
    })

    const fits: FitSummary[] = []
    // Only eras that are their OWN source are worth fitting: 2026 is priced from
    // the 2023/24 surface, so fitting a separate 2026 surface would build a table
    // nothing reads.
    for (const { ruleEra } of eras) {
        if (ruleEra !== null && EP_SOURCE_ERA[ruleEra] === ruleEra) {
            fits.push(await fitEpModel(ruleEra))
        }
    }

    const applied = await applyEpa()
    return { fits, applied }
}
