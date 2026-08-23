import { builder } from '~/builder'
import { db } from '~/lib/db.server'
import { PassDepthEnum, PassDirectionEnum, RuleEraEnum } from '~/schemas/enums.server'
import {
    playerLines,
    STAT_PLAY_SELECT,
    teamBoxScores,
    type PlayerLine,
    type TeamBoxScore,
    type ZoneTargets,
} from '~/services/stats/playStats'

// Every derived stat excludes no-plays: a penalty-wiped snap occupies no down
// and credits nobody. One shared selection so Pothos can merge the four
// stat fields on Game into a single nested query.
const statPlays = {
    Plays: { where: { isNoPlay: false }, select: STAT_PLAY_SELECT },
} as const

const PLAYER_DESCRIPTION = 'Name as it appears in the play text, e.g. "#12 A.Smith".'

const teamByGeniusId = (query: object, geniusTeamId: string) =>
    db.team.findUniqueOrThrow({ ...query, where: { geniusTeamId } })

builder.prismaObject('Drive', {
    fields: (t) => ({
        id: t.exposeInt('id'),
        number: t.exposeInt('number'),
        isScoring: t.exposeBoolean('isScoring'),
        points: t.exposeInt('points', {
            nullable: true,
            description: 'Signed for the possessing team: negative means the opponent scored.',
        }),
        startQuarter: t.exposeInt('startQuarter', { nullable: true }),
        team: t.relation('Team'),
    }),
})

builder.prismaObject('Play', {
    fields: (t) => ({
        id: t.exposeInt('id'),
        number: t.exposeInt('number'),
        driveNumber: t.int({
            select: { Drive: { select: { number: true } } },
            resolve: (p) => p.Drive.number,
        }),
        team: t.relation('Team'),
        phase: t.exposeString('phase'),
        quarter: t.int({
            nullable: true,
            description: '1-4; null in overtime or when the feed gives no quarter.',
            select: { phase: true, phaseQualifier: true },
            resolve: (p) => {
                const q = Number(p.phaseQualifier)
                return p.phase === 'Regular' && Number.isInteger(q) && q >= 1 && q <= 4 ? q : null
            },
        }),
        clock: t.exposeString('clock'),
        type: t.exposeString('type'),
        subtype: t.exposeString('subtype', { nullable: true }),
        description: t.exposeString('description'),
        down: t.exposeInt('down', { nullable: true }),
        distance: t.exposeString('distance', { nullable: true }),
        yardLine: t.exposeInt('yardLine', { nullable: true }),
        passer: t.exposeString('passer', { nullable: true }),
        rusher: t.exposeString('rusher', { nullable: true }),
        receiver: t.exposeString('receiver', { nullable: true }),
        isComplete: t.exposeBoolean('isComplete', {
            nullable: true,
            description: 'Whether a pass was caught; null on non-pass plays.',
        }),
        yardsGained: t.exposeInt('yardsGained', { nullable: true }),
        epa: t.exposeFloat('epa', { nullable: true }),
        targetDepth: t.expose('targetDepth', { type: PassDepthEnum, nullable: true }),
        targetDirection: t.expose('targetDirection', { type: PassDirectionEnum, nullable: true }),
        airYards: t.exposeInt('airYards', { nullable: true }),
        yardsAfterCatch: t.exposeInt('yardsAfterCatch', { nullable: true }),
        isNoPlay: t.exposeBoolean('isNoPlay', {
            description: 'A penalty wiped this snap; excluded from all stats.',
        }),
        isScoring: t.exposeBoolean('isScoring'),
        isFirstDown: t.exposeBoolean('isFirstDown'),
        isTurnover: t.exposeBoolean('isTurnover'),
        points: t.exposeInt('points', {
            nullable: true,
            description: 'Points on this play, signed for its team; -6 is a return touchdown.',
        }),
    }),
})

const ZoneTargetsType = builder.objectRef<ZoneTargets>('ZoneTargets').implement({
    description: 'Targets to one (depth, direction) zone.',
    fields: (t) => ({
        depth: t.expose('depth', { type: PassDepthEnum }),
        direction: t.expose('direction', { type: PassDirectionEnum }),
        targets: t.exposeInt('targets'),
        receptions: t.exposeInt('receptions'),
        yards: t.exposeInt('yards'),
        epa: t.exposeFloat('epa'),
    }),
})

const TeamBoxScoreType = builder.objectRef<TeamBoxScore>('TeamBoxScore').implement({
    description: "One team's totals in a game, from plays (no-plays excluded).",
    fields: (t) => ({
        team: t.prismaField({ type: 'Team', resolve: (q, b) => teamByGeniusId(q, b.geniusTeamId) }),
        points: t.exposeInt('points'),
        plays: t.exposeInt('plays'),
        passAttempts: t.exposeInt('passAttempts'),
        completions: t.exposeInt('completions'),
        passingYards: t.exposeInt('passingYards'),
        rushAttempts: t.exposeInt('rushAttempts'),
        rushingYards: t.exposeInt('rushingYards'),
        totalYards: t.exposeInt('totalYards'),
        turnovers: t.exposeInt('turnovers'),
        firstDowns: t.exposeInt('firstDowns'),
        epa: t.exposeFloat('epa'),
    }),
})

// Both line types carry the same stat columns, written out twice rather than
// through a generic field helper: Pothos' expose* typing does not survive a
// generic parent shape, and two copies of fifteen one-liners beat a cast.
const PlayerGameStatsType = builder
    .objectRef<PlayerLine & { gameId: number }>('PlayerGameStats')
    .implement({
        description: 'Per-player production in one game, from plays (no-plays excluded).',
        fields: (t) => ({
            gameId: t.exposeInt('gameId'),
            player: t.exposeString('player', { description: PLAYER_DESCRIPTION }),
            team: t.prismaField({
                type: 'Team',
                resolve: (q, l) => teamByGeniusId(q, l.geniusTeamId),
            }),
            passAttempts: t.exposeInt('passAttempts'),
            completions: t.exposeInt('completions'),
            passingYards: t.exposeInt('passingYards'),
            passingTouchdowns: t.exposeInt('passingTouchdowns'),
            interceptions: t.exposeInt('interceptions'),
            rushAttempts: t.exposeInt('rushAttempts'),
            rushingYards: t.exposeInt('rushingYards'),
            rushingTouchdowns: t.exposeInt('rushingTouchdowns'),
            targets: t.exposeInt('targets'),
            receptions: t.exposeInt('receptions'),
            receivingYards: t.exposeInt('receivingYards'),
            receivingTouchdowns: t.exposeInt('receivingTouchdowns'),
            epa: t.exposeFloat('epa'),
            targetsByZone: t.expose('targetsByZone', { type: [ZoneTargetsType] }),
        }),
    })

const PlayerSeasonStatsType = builder
    .objectRef<PlayerLine & { year: number }>('PlayerSeasonStats')
    .implement({
        description: 'Per-player production over a season, from plays (no-plays excluded).',
        fields: (t) => ({
            year: t.exposeInt('year'),
            games: t.exposeInt('games'),
            player: t.exposeString('player', { description: PLAYER_DESCRIPTION }),
            team: t.prismaField({
                type: 'Team',
                resolve: (q, l) => teamByGeniusId(q, l.geniusTeamId),
            }),
            passAttempts: t.exposeInt('passAttempts'),
            completions: t.exposeInt('completions'),
            passingYards: t.exposeInt('passingYards'),
            passingTouchdowns: t.exposeInt('passingTouchdowns'),
            interceptions: t.exposeInt('interceptions'),
            rushAttempts: t.exposeInt('rushAttempts'),
            rushingYards: t.exposeInt('rushingYards'),
            rushingTouchdowns: t.exposeInt('rushingTouchdowns'),
            targets: t.exposeInt('targets'),
            receptions: t.exposeInt('receptions'),
            receivingYards: t.exposeInt('receivingYards'),
            receivingTouchdowns: t.exposeInt('receivingTouchdowns'),
            epa: t.exposeFloat('epa'),
            targetsByZone: t.expose('targetsByZone', { type: [ZoneTargetsType] }),
        }),
    })

builder.prismaObject('Game', {
    description: 'One fixture. Scores and stats are derived from plays at read time.',
    fields: (t) => ({
        id: t.exposeInt('id'),
        year: t.exposeInt('year'),
        ruleEra: t.expose('ruleEra', { type: RuleEraEnum, nullable: true }),
        date: t.expose('startedAt', { type: 'DateTime', nullable: true }),
        homeTeam: t.relation('HomeTeam', { nullable: true }),
        awayTeam: t.relation('AwayTeam', { nullable: true }),
        // The feed's official final when the payload carried one; otherwise
        // summed from plays. The sum is right for clean 2026 payloads but the
        // 2023/24 corpus has plays stamped with the wrong team in places, so the
        // stored final is the authority whenever it exists.
        homeScore: t.int({
            nullable: true,
            select: { homeScore: true, homeGeniusTeamId: true, ...statPlays },
            resolve: (g) =>
                g.homeScore ??
                teamBoxScores(g.Plays).find((b) => b.geniusTeamId === g.homeGeniusTeamId)?.points ??
                null,
        }),
        awayScore: t.int({
            nullable: true,
            select: { awayScore: true, awayGeniusTeamId: true, ...statPlays },
            resolve: (g) =>
                g.awayScore ??
                teamBoxScores(g.Plays).find((b) => b.geniusTeamId === g.awayGeniusTeamId)?.points ??
                null,
        }),
        drives: t.relation('Drives', { query: { orderBy: { number: 'asc' } } }),
        plays: t.relation('Plays', {
            description: 'Chronological, including no-plays.',
            query: { orderBy: [{ Drive: { number: 'asc' } }, { number: 'asc' }] },
        }),
        boxScore: t.field({
            type: [TeamBoxScoreType],
            select: statPlays,
            resolve: (g) => teamBoxScores(g.Plays),
        }),
        playerStats: t.field({
            type: [PlayerGameStatsType],
            select: { id: true, ...statPlays },
            resolve: (g) => playerLines(g.Plays).map((l) => ({ ...l, gameId: g.id })),
        }),
    }),
})

builder.queryFields((t) => ({
    seasons: t.field({
        type: ['Int'],
        description: 'Every year with a game or a fixture, newest first.',
        resolve: async () => {
            const [games, matches] = await Promise.all([
                db.game.findMany({ distinct: ['year'], select: { year: true } }),
                db.match.findMany({ distinct: ['year'], select: { year: true } }),
            ])
            return [...new Set([...games, ...matches].map((r) => r.year))].sort((a, b) => b - a)
        },
    }),
    games: t.prismaField({
        type: ['Game'],
        description: 'Newest first. Only games with parsed plays.',
        args: {
            year: t.arg.int({ required: true }),
            teamSlug: t.arg.string(),
            limit: t.arg.int({ defaultValue: 50 }),
            offset: t.arg.int({ defaultValue: 0 }),
        },
        resolve: (query, _root, { year, teamSlug, limit, offset }) =>
            db.game.findMany({
                ...query,
                where: {
                    year,
                    playCount: { gt: 0 },
                    ...(teamSlug ? { Drives: { some: { Team: { slug: teamSlug } } } } : {}),
                },
                orderBy: [{ startedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
                take: Math.min(Math.max(limit ?? 50, 1), 200),
                skip: Math.max(offset ?? 0, 0),
            }),
    }),
    game: t.prismaField({
        type: 'Game',
        nullable: true,
        args: { id: t.arg.int({ required: true }) },
        resolve: (query, _root, { id }) => db.game.findUnique({ ...query, where: { id } }),
    }),
    playerSeasonStats: t.field({
        type: [PlayerSeasonStatsType],
        description: 'Sorted by targets + pass attempts + rush attempts, descending.',
        args: {
            year: t.arg.int({ required: true }),
            teamSlug: t.arg.string(),
            limit: t.arg.int({ defaultValue: 100 }),
            offset: t.arg.int({ defaultValue: 0 }),
        },
        resolve: async (_root, { year, teamSlug, limit, offset }) => {
            // ponytail: loads a season's plays (~14k rows) and aggregates in
            // process; move to a SQL GROUP BY if this ever gets slow.
            const plays = await db.play.findMany({
                where: {
                    isNoPlay: false,
                    Game: { year },
                    ...(teamSlug ? { Team: { slug: teamSlug } } : {}),
                },
                select: STAT_PLAY_SELECT,
            })
            const start = Math.max(offset ?? 0, 0)
            return playerLines(plays)
                .slice(start, start + Math.min(Math.max(limit ?? 100, 1), 500))
                .map((l) => ({ ...l, year }))
        },
    }),
}))
