import { z } from 'zod'

// The three public CFL Game Zone feeds. Undocumented and unversioned — treat
// shape changes and disappearance as expected, not exceptional.
//
// They are served gzipped from S3; fetch must send Accept-Encoding and decode.
export const FEED_BASE = 'https://gamezone.cfl.ca/json/fantasy'

export const FEED_SOURCES = ['squads', 'players', 'gameweeks'] as const
export type FeedSource = (typeof FEED_SOURCES)[number]

export const feedUrl = (source: FeedSource): string => `${FEED_BASE}/${source}.json`

// Only the fields we actually consume are required. Everything else is allowed
// through untouched, so an upstream addition can never fail a sync.
const squadRef = z.object({
    id: z.number(),
    abbr: z.string().optional(),
    abbreviation: z.string().optional(),
    name: z.string().optional(),
})

export const squadSchema = z.object({
    id: z.number(),
    name: z.string(),
    nameFr: z.string().optional(),
    shortName: z.string().optional(),
    abbreviation: z.string(),
})

// The feed serializes an EMPTY map as `[]` rather than `{}` — players with no
// recorded stats come back as `"stats": []`. Verified 2026-08-17: an inactive
// player yields arrays where an active one yields objects. Coerce the empty
// array to an empty object so a whole sync is not rejected over it, while still
// rejecting a genuinely unexpected shape.
const emptyMapTolerant = <T extends z.ZodTypeAny>(inner: T) =>
    z
        .union([inner, z.array(z.never())])
        .nullish()
        .transform((v) => (Array.isArray(v) ? undefined : v))

export const playerSchema = z.object({
    id: z.number(),
    feedId: z.number().nullish(),
    firstName: z.string(),
    lastName: z.string(),
    squad: squadRef.nullish(),
    status: z.string().nullish(),
    cost: z.number().nullish(),
    points: z.number().nullish(),
    position: z.string().nullish(),
    isLocked: z.boolean().nullish(),
    injuredText: z.object({ en: z.string().nullish() }).nullish(),
    stats: z
        .object({
            avgPoints: z.number().nullish(),
            projectedScores: z.number().nullish(),
            weekSalaryChange: z.number().nullish(),
            stats: emptyMapTolerant(z.record(z.string(), z.unknown())),
            // Points keyed by gameweek and by match id, as strings.
            // A null value means the player did not feature that week, which is
            // NOT the same as scoring zero — syncPoints skips nulls rather than
            // recording a 0 that would drag down any average computed later.
            points: emptyMapTolerant(
                z.object({
                    gws: emptyMapTolerant(z.record(z.string(), z.number().nullable())),
                    matches: emptyMapTolerant(z.record(z.string(), z.number().nullable())),
                }),
            ),
        })
        .nullish(),
})

export const matchSchema = z.object({
    id: z.number(),
    homeSquad: squadRef.nullish(),
    awaySquad: squadRef.nullish(),
    homeSquadScore: z.number().nullish(),
    awaySquadScore: z.number().nullish(),
    status: z.string(),
    date: z.string().nullish(),
    venue: z.string().nullish(),
})

export const gameweekSchema = z.object({
    id: z.number(),
    feedId: z.number().nullish(),
    name: z.string(),
    status: z.string(),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
    matches: z.array(matchSchema).default([]),
})

export const FEED_SCHEMAS = {
    squads: z.array(squadSchema),
    players: z.array(playerSchema),
    gameweeks: z.array(gameweekSchema),
} as const

export type Squad = z.infer<typeof squadSchema>
export type FeedPlayer = z.infer<typeof playerSchema>
export type FeedGameweek = z.infer<typeof gameweekSchema>

// The feed's position strings, mapped to our enum. Anything unrecognised lands
// on OTHER rather than failing the sync — the pool is QB/RB/WR today but the
// league could add a position to the game at any point.
export function mapPosition(
    raw: string | null | undefined,
): 'QUARTERBACK' | 'RUNNING_BACK' | 'WIDE_RECEIVER' | 'OTHER' {
    switch (raw) {
        case 'quarterback':
            return 'QUARTERBACK'
        case 'running_back':
            return 'RUNNING_BACK'
        case 'wide_receiver':
            return 'WIDE_RECEIVER'
        default:
            return 'OTHER'
    }
}
