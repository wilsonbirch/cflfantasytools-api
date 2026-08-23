import { builder } from '~/builder'
import type { Player, Projection } from '~/generated/prisma/client'
import { db } from '~/lib/db.server'
import { currentSeasonYear } from '~/lib/season.server'
import { PlayerPositionEnum } from '~/schemas/enums.server'
import { fantasyPoints } from '~/services/fantasy/scoring'
import { currentGameweek, seasonGameweeks, weekOf } from '~/services/gamezone/gameweeks.server'

// The fantasy companion's read surface over what gamezone-sync stores: the
// schedule, the player pool with Game Zone's own salary/projection/points, and
// each player's history, with our projection for one gameweek attached.

// What a FantasyPlayer row carries beyond the Player columns: our latest
// projection for the gameweek the caller is looking at, and which completed
// gameweek is the latest (for `lastGameweekPoints`) — both resolved once per
// query rather than once per player.
export type FantasyPlayerRow = Player & {
    projection: Projection | null
    lastCompleteId: number | null
}

async function latestCompleteGameweekId(year: number): Promise<number | null> {
    const g = await db.gameweek.findFirst({
        where: { year, status: 'complete' },
        orderBy: [{ startDate: { sort: 'desc', nulls: 'last' } }, { gameZoneId: 'desc' }],
        select: { id: true },
    })
    return g?.id ?? null
}

/** The newest fit's rows for a gameweek, optionally for some players only. */
export async function latestProjections(
    gameweekId: number,
    playerIds?: number[],
): Promise<Projection[]> {
    const newest = await db.projection.findFirst({
        where: { gameweekId },
        orderBy: { fittedAt: 'desc' },
        select: { fittedAt: true },
    })
    if (!newest) return []
    return db.projection.findMany({
        where: {
            gameweekId,
            fittedAt: newest.fittedAt,
            ...(playerIds ? { playerId: { in: playerIds } } : {}),
        },
    })
}

/** Attach the per-query context a FantasyPlayer needs; gameweekId null = current. */
export async function asFantasyPlayers(
    players: Player[],
    gameweekId: number | null | undefined,
): Promise<FantasyPlayerRow[]> {
    const year = currentSeasonYear()
    const gw = gameweekId ?? (await currentGameweek(year))?.id ?? null
    const lastCompleteId = await latestCompleteGameweekId(year)
    const projections =
        gw === null
            ? []
            : await latestProjections(
                  gw,
                  players.map((p) => p.id),
              )
    const byPlayer = new Map(projections.map((r) => [r.playerId, r]))
    return players.map((p) =>
        Object.assign(p, { projection: byPlayer.get(p.id) ?? null, lastCompleteId }),
    )
}

const ProjectionType = builder.prismaObject('Projection', {
    description:
        'Projected production for one player in one gameweek: role baseline + player quality (shrunk toward the league mean by sample size) + offensive-coordinator offset + opposing defensive-coordinator offset, fitted on the current rule era only. Every number is a per-game expectation.',
    fields: (t) => ({
        id: t.exposeInt('id'),
        fittedAt: t.expose('fittedAt', { type: 'DateTime' }),
        gameweek: t.relation('Gameweek'),
        player: t.prismaField({
            type: 'Player',
            select: { playerId: true, gameweekId: true },
            resolve: async (q, r) => {
                const p = await db.player.findUniqueOrThrow({ ...q, where: { id: r.playerId } })
                return (await asFantasyPlayers([p], r.gameweekId))[0]
            },
        }),
        opponent: t.prismaField({
            type: 'Team',
            nullable: true,
            description: 'The opposing team; null when the fixture is not known.',
            select: { opponentTeamId: true },
            resolve: (q, r) =>
                r.opponentTeamId === null
                    ? null
                    : db.team.findUnique({ ...q, where: { id: r.opponentTeamId } }),
        }),
        alignment: t.exposeString('alignment', {
            nullable: true,
            description:
                'Receiver position (1S, 2WK, ...) the role baseline was taken from; null when no chart names the player.',
        }),
        games: t.exposeInt('games', {
            description:
                'Games behind the player term; the fewer, the more the projection is pooled.',
        }),
        passAttempts: t.exposeFloat('passAttempts'),
        passingYards: t.exposeFloat('passingYards'),
        passingTouchdowns: t.exposeFloat('passingTouchdowns'),
        interceptions: t.exposeFloat('interceptions'),
        rushAttempts: t.exposeFloat('rushAttempts'),
        rushingYards: t.exposeFloat('rushingYards'),
        rushingTouchdowns: t.exposeFloat('rushingTouchdowns'),
        targets: t.exposeFloat('targets'),
        receptions: t.exposeFloat('receptions'),
        receivingYards: t.exposeFloat('receivingYards'),
        receivingTouchdowns: t.exposeFloat('receivingTouchdowns'),
        epa: t.exposeFloat('epa', {
            description: 'Expected EPA of the plays the player throws, carries or is targeted on.',
        }),
        points: t.float({
            description:
                'Fantasy points under the current Game Zone scoring, computed at read time from the stat projections.',
            resolve: (r) => fantasyPoints(r),
        }),
    }),
})

const LATEST_SNAPSHOT = {
    snapshots: { orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }], take: 1 },
} as const

builder.prismaObject('Gameweek', {
    description: 'One Game Zone fantasy round and its fixtures.',
    fields: (t) => ({
        id: t.exposeInt('id'),
        gameZoneId: t.exposeInt('gameZoneId'),
        name: t.exposeString('name'),
        status: t.exposeString('status', {
            description: 'scheduled, playing or complete, as the feed reports it.',
        }),
        year: t.exposeInt('year'),
        week: t.int({
            description: '1-based ordinal of the gameweek within its season, by start date.',
            select: { id: true, year: true },
            resolve: (g) => weekOf(g),
        }),
        startDate: t.expose('startDate', { type: 'DateTime', nullable: true }),
        endDate: t.expose('endDate', { type: 'DateTime', nullable: true }),
        matches: t.relation('matches', {
            query: { orderBy: [{ date: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }] },
        }),
    }),
})

builder.prismaObject('Match', {
    description: 'One fixture as Game Zone schedules it.',
    fields: (t) => ({
        id: t.exposeInt('id'),
        gameZoneId: t.exposeInt('gameZoneId'),
        gameweek: t.relation('Gameweek'),
        homeTeam: t.relation('HomeTeam', { nullable: true }),
        awayTeam: t.relation('AwayTeam', { nullable: true }),
        homeScore: t.exposeInt('homeScore', { nullable: true }),
        awayScore: t.exposeInt('awayScore', { nullable: true }),
        status: t.exposeString('status'),
        venue: t.exposeString('venue', { nullable: true }),
        date: t.expose('date', { type: 'DateTime', nullable: true }),
        game: t.prismaField({
            type: 'Game',
            nullable: true,
            description: 'The parsed play-by-play for this fixture; null until captured.',
            select: { geniusFixtureId: true },
            resolve: (q, m) =>
                m.geniusFixtureId === null
                    ? null
                    : db.game.findFirst({
                          ...q,
                          where: { id: m.geniusFixtureId, playCount: { gt: 0 } },
                      }),
        }),
    }),
})

const GameweekPointsType = builder
    .objectRef<{ gameweekId: number; points: number }>('GameweekPoints')
    .implement({
        description: 'Fantasy points one player scored in one gameweek.',
        fields: (t) => ({
            gameweek: t.prismaField({
                type: 'Gameweek',
                resolve: (q, r) =>
                    db.gameweek.findUniqueOrThrow({ ...q, where: { id: r.gameweekId } }),
            }),
            points: t.exposeFloat('points'),
        }),
    })

const SalarySnapshotType = builder
    .objectRef<{
        capturedAt: Date
        cost: number
        projectedScores: number | null
        weekSalaryChange: number | null
    }>('SalarySnapshot')
    .implement({
        description: "A player's salary as of one sync.",
        fields: (t) => ({
            capturedAt: t.expose('capturedAt', { type: 'DateTime' }),
            salary: t.exposeInt('cost'),
            gameZoneProjection: t.exposeFloat('projectedScores', { nullable: true }),
            weekSalaryChange: t.exposeInt('weekSalaryChange', { nullable: true }),
        }),
    })

export const FantasyPlayerType = builder.prismaObject('Player', {
    name: 'FantasyPlayer',
    description:
        'A Game Zone fantasy player with the salary, projection and points the feed carries, plus our own projection for one gameweek.',
    fields: (t) => ({
        id: t.exposeInt('id'),
        gameZoneId: t.exposeInt('gameZoneId', {
            description: "Game Zone's own id for the player.",
        }),
        firstName: t.exposeString('firstName'),
        lastName: t.exposeString('lastName'),
        name: t.string({
            description: 'First and last name.',
            select: { firstName: true, lastName: true },
            resolve: (p) => `${p.firstName} ${p.lastName}`,
        }),
        team: t.relation('Team', { nullable: true }),
        position: t.expose('position', { type: PlayerPositionEnum }),
        status: t.exposeString('status', {
            nullable: true,
            description: "Game Zone's availability status as the feed reports it.",
        }),
        isLocked: t.exposeBoolean('isLocked'),
        isActive: t.exposeBoolean('isActive', {
            description:
                'False once the player has been absent from several consecutive feed pulls.',
        }),
        injuredText: t.exposeString('injuredTextEn', {
            nullable: true,
            description: "Game Zone's injury note; null when there is none.",
        }),
        salary: t.int({
            nullable: true,
            description: 'Game Zone salary as of the latest sync.',
            select: LATEST_SNAPSHOT,
            resolve: (p) => p.snapshots[0]?.cost ?? null,
        }),
        weekSalaryChange: t.int({
            nullable: true,
            description: 'Salary change this week, as the feed reports it.',
            select: LATEST_SNAPSHOT,
            resolve: (p) => p.snapshots[0]?.weekSalaryChange ?? null,
        }),
        gameZoneProjection: t.float({
            nullable: true,
            description:
                "Game Zone's own projection for the upcoming gameweek, as of the latest sync.",
            select: LATEST_SNAPSHOT,
            resolve: (p) => p.snapshots[0]?.projectedScores ?? null,
        }),
        seasonPoints: t.float({
            nullable: true,
            description: 'Game Zone season total as of the latest sync.',
            select: LATEST_SNAPSHOT,
            resolve: (p) => p.snapshots[0]?.totalPoints ?? null,
        }),
        avgPoints: t.float({
            nullable: true,
            description: "Game Zone's average points per game played, as of the latest sync.",
            select: LATEST_SNAPSHOT,
            resolve: (p) => p.snapshots[0]?.avgPoints ?? null,
        }),
        lastGameweekPoints: t.float({
            nullable: true,
            description:
                'Points in the most recent completed gameweek; null when the player did not feature.',
            select: { points: { select: { gameweekId: true, points: true } } },
            resolve: (p) => {
                const { lastCompleteId } = p as unknown as FantasyPlayerRow
                return p.points.find((r) => r.gameweekId === lastCompleteId)?.points ?? null
            },
        }),
        pointsHistory: t.field({
            type: [GameweekPointsType],
            description: 'Every gameweek the player scored in, oldest first.',
            select: {
                points: {
                    select: { gameweekId: true, points: true },
                    orderBy: [{ Gameweek: { startDate: 'asc' } }, { gameweekId: 'asc' }],
                },
            },
            resolve: (p) => p.points,
        }),
        projection: t.field({
            type: ProjectionType,
            nullable: true,
            description:
                'Our projection for the gameweek the query asked for; null when none has been fitted.',
            resolve: (p) => (p as unknown as FantasyPlayerRow).projection,
        }),
        value: t.float({
            nullable: true,
            description: 'projection.points per $1000 of salary; null without both.',
            select: LATEST_SNAPSHOT,
            resolve: (p) => {
                const { projection } = p as unknown as FantasyPlayerRow
                const salary = p.snapshots[0]?.cost
                if (!projection || !salary) return null
                return Math.round((fantasyPoints(projection) / (salary / 1000)) * 100) / 100
            },
        }),
        salaryHistory: t.field({
            type: [SalarySnapshotType],
            description:
                'One point per change in salary, oldest first, ending at the current value.',
            select: {
                snapshots: {
                    select: {
                        capturedAt: true,
                        cost: true,
                        projectedScores: true,
                        weekSalaryChange: true,
                    },
                    orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
                },
            },
            resolve: (p) => {
                const out: {
                    capturedAt: Date
                    cost: number
                    projectedScores: number | null
                    weekSalaryChange: number | null
                }[] = []
                for (const s of p.snapshots) {
                    if (s.cost === null) continue
                    if (out.at(-1)?.cost !== s.cost) out.push({ ...s, cost: s.cost })
                }
                return out
            },
        }),
    }),
})

builder.queryFields((t) => ({
    gameweeks: t.prismaField({
        type: ['Gameweek'],
        description: "A season's gameweeks by start date.",
        args: { year: t.arg.int({ required: true }) },
        resolve: (query, _root, { year }) =>
            db.gameweek.findMany({
                ...query,
                where: { year },
                orderBy: [{ startDate: { sort: 'asc', nulls: 'last' } }, { gameZoneId: 'asc' }],
            }),
    }),
    gameweek: t.prismaField({
        type: 'Gameweek',
        nullable: true,
        args: { id: t.arg.int({ required: true }) },
        resolve: (query, _root, { id }) => db.gameweek.findUnique({ ...query, where: { id } }),
    }),
    fantasyPlayers: t.prismaField({
        type: [FantasyPlayerType],
        description:
            'Active players by salary, highest first. gameweekId selects which projection is attached; omitted means the current gameweek (the first not yet complete).',
        args: {
            gameweekId: t.arg.int(),
            teamSlug: t.arg.string(),
            position: t.arg({ type: PlayerPositionEnum }),
            limit: t.arg.int({ defaultValue: 100 }),
            offset: t.arg.int({ defaultValue: 0 }),
        },
        resolve: async (query, _root, { gameweekId, teamSlug, position, limit, offset }) => {
            // Ordering by the newest snapshot's cost is not expressible in
            // Prisma, so the page of ids comes from SQL and Pothos' selection
            // loads the rows.
            const ordered = await db.$queryRaw<{ id: number }[]>`
                SELECT p.id
                FROM "Player" p
                LEFT JOIN LATERAL (
                    SELECT s.cost FROM "PlayerStatSnapshot" s
                    WHERE s."playerId" = p.id ORDER BY s."capturedAt" DESC, s.id DESC LIMIT 1
                ) s ON true
                LEFT JOIN "Team" t ON t.id = p."teamId"
                WHERE p."isActive" = true
                  AND (${teamSlug ?? null}::text IS NULL OR t.slug = ${teamSlug ?? null})
                  AND (${position ?? null}::text IS NULL OR p.position::text = ${position ?? null})
                ORDER BY s.cost DESC NULLS LAST, p."lastName" ASC, p.id ASC
                LIMIT ${Math.min(Math.max(limit ?? 100, 1), 1000)}
                OFFSET ${Math.max(offset ?? 0, 0)}`
            const ids = ordered.map((r) => r.id)
            const rows = await db.player.findMany({ ...query, where: { id: { in: ids } } })
            const byId = new Map(rows.map((r) => [r.id, r]))
            const players = ids.map((id) => byId.get(id)).filter((r) => r !== undefined)
            return asFantasyPlayers(players, gameweekId)
        },
    }),
    projections: t.prismaField({
        type: ['Projection'],
        description:
            'The latest fitted projections for one gameweek (week is Gameweek.week), highest points first.',
        args: {
            year: t.arg.int({ required: true }),
            week: t.arg.int({ required: true }),
            teamSlug: t.arg.string(),
        },
        resolve: async (query, _root, { year, week, teamSlug }) => {
            const gw = (await seasonGameweeks(year)).find((g) => g.week === week)
            if (!gw) return []
            const newest = await db.projection.findFirst({
                where: { gameweekId: gw.id },
                orderBy: { fittedAt: 'desc' },
                select: { fittedAt: true },
            })
            if (!newest) return []
            const rows = await db.projection.findMany({
                ...query,
                where: {
                    gameweekId: gw.id,
                    fittedAt: newest.fittedAt,
                    ...(teamSlug ? { Player: { Team: { slug: teamSlug } } } : {}),
                },
            })
            return rows.sort((a, b) => fantasyPoints(b) - fantasyPoints(a) || a.id - b.id)
        },
    }),
    fantasyPlayer: t.prismaField({
        type: FantasyPlayerType,
        nullable: true,
        description:
            'One player, with our projection for gameweekId (the current gameweek when omitted).',
        args: { id: t.arg.int({ required: true }), gameweekId: t.arg.int() },
        resolve: async (query, _root, { id, gameweekId }) => {
            const p = await db.player.findUnique({ ...query, where: { id } })
            return p ? (await asFantasyPlayers([p], gameweekId))[0] : null
        },
    }),
}))
