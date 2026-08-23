import { describe, expect, it } from 'vitest'
import {
    COORD_PRIOR_GAMES,
    fitModel,
    PLAYER_PRIOR_GAMES,
    project,
    zeroLine,
    type ObservedGame,
    type TeamGame,
} from '~/services/projections/model'

const line = (receivingYards: number, targets = 5) => ({ ...zeroLine(), receivingYards, targets })

// Two 1S receivers: A averages 100 yards over four games, B 60 over two. League
// of two offences, each with its own coordinator.
const observed: ObservedGame[] = [
    ...[100, 100, 100, 100].map((y, i) => ({
        gameId: i,
        playerKey: 'A',
        role: 'WR:1S',
        stats: line(y),
    })),
    ...[60, 60].map((y, i) => ({ gameId: i, playerKey: 'B', role: 'WR:1S', stats: line(y) })),
]
const teamGames: TeamGame[] = [
    ...[0, 1, 2, 3].map((g) => ({
        gameId: g,
        teamKey: 'T1',
        ocKey: 'OC:x',
        dcKey: 'DC:y',
        stats: line(300),
    })),
    ...[0, 1, 2, 3].map((g) => ({
        gameId: g,
        teamKey: 'T2',
        ocKey: 'OC:z',
        dcKey: 'DC:w',
        stats: line(200),
    })),
]

describe('projection model', () => {
    const model = fitModel(observed, teamGames)

    it('takes the role baseline as the mean over every player-game in the role', () => {
        expect(model.roleMeans.get('WR:1S')?.receivingYards).toBeCloseTo((400 + 120) / 6)
        expect(model.groupMeans.get('WR')?.receivingYards).toBeCloseTo((400 + 120) / 6)
    })

    it('shrinks the player term toward the baseline by sample size', () => {
        const base = (400 + 120) / 6
        const a = project(model, { playerKey: 'A', role: 'WR:1S', ocKey: '-', dcKey: '-' })!
        const b = project(model, { playerKey: 'B', role: 'WR:1S', ocKey: '-', dcKey: '-' })!
        const wa = 4 / (4 + PLAYER_PRIOR_GAMES)
        const wb = 2 / (2 + PLAYER_PRIOR_GAMES)
        expect(a.stats.receivingYards).toBeCloseTo(base + wa * (100 - base))
        expect(b.stats.receivingYards).toBeCloseTo(base + wb * (60 - base))
        expect(a.games).toBe(4)
        // An unseen player is the baseline itself, with no games behind it.
        const c = project(model, { playerKey: 'C', role: 'WR:1S', ocKey: '-', dcKey: '-' })!
        expect(c.stats.receivingYards).toBeCloseTo(base)
        expect(c.games).toBe(0)
    })

    it('applies coordinator offsets as shrunk fractions of the baseline, additively', () => {
        const base = (400 + 120) / 6
        // OC:x's offence throws for 300 against a league mean of 250: +20%, shrunk by 4/(4+prior).
        const w = 4 / (4 + COORD_PRIOR_GAMES)
        const ocOnly = project(model, { playerKey: 'C', role: 'WR:1S', ocKey: 'OC:x', dcKey: '-' })!
        expect(ocOnly.stats.receivingYards).toBeCloseTo(base * (1 + w * 0.2))
        // DC:w faced T2's offence at 200 — opponents produce 20% less against it.
        const both = project(model, {
            playerKey: 'C',
            role: 'WR:1S',
            ocKey: 'OC:x',
            dcKey: 'DC:w',
        })!
        expect(both.stats.receivingYards).toBeCloseTo(base * (1 + w * 0.2 - w * 0.2))
    })

    it('falls back to the position group when the exact role is unseen, and to null when nothing is', () => {
        const r = project(model, { playerKey: 'C', role: 'WR:3WK', ocKey: '-', dcKey: '-' })!
        expect(r.stats.receivingYards).toBeCloseTo((400 + 120) / 6)
        expect(project(model, { playerKey: 'C', role: 'QB', ocKey: '-', dcKey: '-' })).toBeNull()
        expect(
            project(fitModel([], []), { playerKey: 'A', role: 'WR:1S', ocKey: '-', dcKey: '-' }),
        ).toBeNull()
    })

    it('floors production at zero but leaves EPA signed', () => {
        const neg: ObservedGame[] = [
            {
                gameId: 0,
                playerKey: 'D',
                role: 'RB',
                stats: { ...zeroLine(), rushingYards: -5, epa: -2 },
            },
        ]
        const m = fitModel(neg, [])
        const r = project(m, { playerKey: 'D', role: 'RB', ocKey: '-', dcKey: '-' })!
        expect(r.stats.rushingYards).toBe(0)
        expect(r.stats.epa).toBeLessThan(0)
    })
})
