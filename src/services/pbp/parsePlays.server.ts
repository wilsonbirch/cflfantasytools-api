import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import { ruleEraForYear, type RuleEra } from '~/lib/season.server'
import { parseDescription, parseStartPosition } from './parseDescription'
import {
    chronological,
    driveOutcome,
    groupIntoDrives,
    nextPointOutcomes,
    type RawPlay,
} from './drives'

const fileName = 'services/pbp/parsePlays'

/**
 * Normalize the raw widget payload into Drive and Play rows.
 *
 * The raw blob stays in `Game.response` after parsing, which is what makes this
 * safe to re-run: a parser bug is re-parsed, not lost. Every game is rebuilt
 * from scratch (drives deleted, plays cascade) so a re-run is idempotent rather
 * than additive.
 *
 * FIELD LENGTH IS ERA-DEPENDENT. 2027 shortens the field 110 -> 100 yards, which
 * changes what a yard-line number means. See docs/memory/project-cfl-rule-eras.md.
 */
export const fieldLengthForEra = (era: RuleEra): number => (era === 'E2027' ? 100 : 110)

type MatchInfo = {
    scheduledStartTime?: string
    homeTeam?: { competitorId?: string }
    awayTeam?: { competitorId?: string }
}

export type ParseSummary = {
    gameId: number
    drives: number
    plays: number
}

export type ParseAllSummary = {
    games: number
    drives: number
    plays: number
    failed: number
    skipped: number
}

/**
 * Parse one stored game into Drive and Play rows.
 *
 * Returns null when the game has no usable payload — an unplayed fixture is not
 * a failure.
 */
export async function parseGame(gameId: number): Promise<ParseSummary | null> {
    const game = await db.game.findUnique({ where: { id: gameId } })
    if (!game) return null

    let raw: RawPlay[]
    let matchInfo: MatchInfo | undefined
    try {
        const payload = JSON.parse(game.response) as {
            data?: { matchInfo?: MatchInfo; playByPlayInfo?: { ALL?: RawPlay[] } }
        }
        raw = payload.data?.playByPlayInfo?.ALL ?? []
        matchInfo = payload.data?.matchInfo
    } catch {
        throw new Error(`game ${gameId}: response is not valid JSON`)
    }
    if (raw.length === 0) return null

    const era = ruleEraForYear(game.year)
    const fieldLength = fieldLengthForEra(era)

    // geniusTeamId -> abbreviation, needed to sign the yard line. A play whose
    // team is not in our table still parses; its yard line keeps magnitude only.
    const teams = await db.team.findMany({ where: { geniusTeamId: { not: null } } })
    const abbrByGeniusId = new Map(teams.map((t) => [t.geniusTeamId as string, t.abbreviation]))

    const drives = groupIntoDrives(chronological(raw))
    const outcomes = drives.map(driveOutcome)
    const nextPoints = nextPointOutcomes(drives)

    // Only drives whose team we can resolve: Drive.geniusTeamId is a foreign key
    // onto Team, so an unknown club would fail the insert and take the game with
    // it. Preseason fixtures occasionally carry an unlisted competitor.
    const known = drives.filter((d) => abbrByGeniusId.has(d.geniusTeamId))
    if (known.length !== drives.length) {
        logger.warn(
            fileName,
            `game ${gameId}: skipped ${drives.length - known.length} drive(s) with unknown team`,
        )
    }

    const playCount = await db.$transaction(async (tx) => {
        // Rebuild from scratch. Plays cascade off Drive, so this one delete makes
        // a re-parse idempotent instead of appending a second copy.
        await tx.drive.deleteMany({ where: { gameId } })

        let written = 0
        for (const drive of known) {
            const index = drives.indexOf(drive)
            const created = await tx.drive.create({
                data: {
                    gameId,
                    geniusTeamId: drive.geniusTeamId,
                    number: drive.number,
                    isScoring: outcomes[index].isScoring,
                    points: outcomes[index].points,
                    nextPointOutcome: nextPoints[index],
                    startQuarter: drive.startQuarter,
                },
            })

            const abbr = abbrByGeniusId.get(drive.geniusTeamId) ?? null
            await tx.play.createMany({
                data: drive.plays.map((play) => {
                    const parsed = parseDescription(
                        play.description,
                        play.type,
                        play.subType,
                        fieldLength,
                    )
                    const position = parseStartPosition(play.playStartPosition, abbr)
                    return {
                        gameId,
                        driveId: created.id,
                        geniusTeamId: play.teamId,
                        number: Number(play.id.split('-')[1]) || 0,
                        type: play.type,
                        subtype: play.subType,
                        description: play.description,
                        clock: play.clock,
                        timestamp: BigInt(play.timestamp),
                        phase: play.phase,
                        phaseQualifier: play.phaseQualifier,
                        isScoring: play.isScoring,
                        startPosition: play.playStartPosition,
                        down: position.down,
                        distance: position.distance,
                        yardLine: position.yardLine,
                        ruleEra: era,
                        ...parsed,
                    }
                }),
            })
            written += drive.plays.length
        }

        // Fixture metadata, so the read surface never opens the blob. Only a
        // club we know can be linked: the columns are foreign keys onto Team.
        const knownOrNull = (id: string | undefined): string | null =>
            id && abbrByGeniusId.has(id) ? id : null
        const startedAt = matchInfo?.scheduledStartTime
            ? new Date(matchInfo.scheduledStartTime)
            : null
        await tx.game.update({
            where: { id: gameId },
            data: {
                parsedAt: new Date(),
                playCount: written,
                ruleEra: era,
                homeGeniusTeamId: knownOrNull(matchInfo?.homeTeam?.competitorId),
                awayGeniusTeamId: knownOrNull(matchInfo?.awayTeam?.competitorId),
                startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null,
            },
        })
        // md5 computed by Postgres, not Node: the candidate query below compares
        // against md5("response") server-side, and a hash produced by two
        // different implementations is a bug waiting to happen over encoding.
        await tx.$executeRaw`UPDATE "Game" SET "parsedHash" = md5("response") WHERE id = ${gameId}`
        return written
    })

    return { gameId, drives: known.length, plays: playCount }
}

/**
 * Parse every stored game that needs it.
 *
 * `force` re-parses games already parsed, which is what a parser change needs.
 * Without it, only games whose stored payload differs from the one they were
 * last parsed from are touched — the common case, and cheap enough to run on a
 * schedule.
 */
export async function parseStoredGames(year?: number, force = false): Promise<ParseAllSummary> {
    const summary: ParseAllSummary = { games: 0, drives: 0, plays: 0, failed: 0, skipped: 0 }

    // Staleness is a payload question, not a clock question: a game needs
    // re-parsing when its `response` differs from the one it was parsed from.
    //
    // The comparison runs in SQL because the alternative — pulling every
    // `response` blob into Node to hash it — moves megabytes per run to answer
    // "did anything change". `IS DISTINCT FROM` rather than `<>` so a NULL hash
    // (never parsed) counts as stale.
    const games: { id: number }[] = force
        ? await db.game.findMany({
              where: year === undefined ? {} : { year },
              select: { id: true },
              orderBy: { id: 'asc' },
          })
        : year === undefined
          ? await db.$queryRaw`
                SELECT id FROM "Game"
                WHERE "parsedHash" IS DISTINCT FROM md5("response")
                ORDER BY id ASC`
          : await db.$queryRaw`
                SELECT id FROM "Game"
                WHERE year = ${year}
                  AND "parsedHash" IS DISTINCT FROM md5("response")
                ORDER BY id ASC`

    for (const { id } of games) {
        try {
            const result = await parseGame(id)
            if (!result) {
                summary.skipped += 1
                continue
            }
            summary.games += 1
            summary.drives += result.drives
            summary.plays += result.plays
        } catch (err) {
            summary.failed += 1
            logger.warn(fileName, `game ${id}: ${err instanceof Error ? err.message : String(err)}`)
        }
    }

    logger.info(
        fileName,
        `parsed ${summary.games} game(s): ${summary.drives} drives, ${summary.plays} plays, ` +
            `${summary.skipped} skipped, ${summary.failed} failed`,
    )
    return summary
}
