import { describe, expect, it } from 'vitest'
import { playerLines, teamBoxScores, type StatPlay } from '~/services/stats/playStats'

const A = '100'
const B = '200'

const play = (over: Partial<StatPlay>): StatPlay => ({
    gameId: 1,
    geniusTeamId: A,
    type: 'Pass',
    description: '',
    passer: null,
    rusher: null,
    receiver: null,
    returner: null,
    fumbleLostBy: null,
    isComplete: null,
    isTurnover: false,
    isFirstDown: false,
    yardsGained: null,
    epa: null,
    targetDepth: null,
    targetDirection: null,
    points: null,
    ...over,
})

const qb = '#12 A.Smith'
const wr = '#81 B.Jones'
const rb = '#30 C.Brown'

const plays: StatPlay[] = [
    play({
        passer: qb,
        receiver: wr,
        isComplete: true,
        yardsGained: 12,
        epa: 1.5,
        targetDepth: 'SHORT',
        targetDirection: 'LEFT',
        isFirstDown: true,
    }),
    play({
        passer: qb,
        receiver: wr,
        isComplete: false,
        epa: -0.75,
        targetDepth: 'DEEP',
        targetDirection: 'RIGHT',
    }),
    // A caught touchdown: subtype would be "Touchdown", which is why stats key
    // off isComplete and points rather than subtype.
    play({
        passer: qb,
        receiver: wr,
        isComplete: true,
        yardsGained: 30,
        epa: 4,
        points: 6,
        targetDepth: 'DEEP',
        targetDirection: 'MIDDLE',
    }),
    play({
        passer: qb,
        receiver: rb,
        isComplete: false,
        isTurnover: true,
        description: 'pass intended for #30 C.Brown INTERCEPTED by #2 D.Back',
        epa: -3,
    }),
    play({ type: 'Run', rusher: rb, yardsGained: 7, epa: 0.25 }),
    play({ type: 'Run', rusher: rb, yardsGained: 3, epa: 0.5, points: 6 }),
    // Team B's punt returned for a touchdown: -6 on B's play is six for A.
    play({ geniusTeamId: B, type: 'Punt', points: -6, epa: -5 }),
    play({ geniusTeamId: B, type: 'Run', rusher: '#1 Z.Back', yardsGained: 4, epa: 0.1 }),
    // A convert is its own play, worth one, and credits nobody's stat line.
    play({ type: 'OnePoint', points: 1 }),
]

describe('teamBoxScores', () => {
    it('totals each team, crediting return scores to the other side', () => {
        const [a, b] = teamBoxScores(plays)
        expect(a.geniusTeamId).toBe(A)
        expect(a).toMatchObject({
            points: 6 + 6 + 6 + 1,
            plays: 6,
            passAttempts: 4,
            completions: 2,
            passingYards: 42,
            rushAttempts: 2,
            rushingYards: 10,
            totalYards: 52,
            turnovers: 1,
            firstDowns: 1,
            epa: 2.5,
        })
        expect(b).toMatchObject({ geniusTeamId: B, points: 0, rushAttempts: 1, epa: -4.9 })
    })

    it('returns nothing for no plays', () => {
        expect(teamBoxScores([])).toEqual([])
    })
})

describe('playerLines', () => {
    it('credits passing, receiving and rushing off the play text', () => {
        const lines = playerLines(plays)
        const byName = Object.fromEntries(lines.map((l) => [l.player, l]))

        expect(byName[qb]).toMatchObject({
            geniusTeamId: A,
            games: 1,
            passAttempts: 4,
            completions: 2,
            passingYards: 42,
            passingTouchdowns: 1,
            interceptions: 1,
            epa: 1.75,
            targetsByZone: [],
        })
        expect(byName[wr]).toMatchObject({
            targets: 3,
            receptions: 2,
            receivingYards: 42,
            receivingTouchdowns: 1,
            epa: 4.75,
        })
        // Zones sorted by depth then direction, so a client can lay them out
        // without sorting again.
        expect(byName[wr].targetsByZone).toEqual([
            { depth: 'DEEP', direction: 'MIDDLE', targets: 1, receptions: 1, yards: 30, epa: 4 },
            { depth: 'DEEP', direction: 'RIGHT', targets: 1, receptions: 0, yards: 0, epa: -0.75 },
            { depth: 'SHORT', direction: 'LEFT', targets: 1, receptions: 1, yards: 12, epa: 1.5 },
        ])
        expect(byName[rb]).toMatchObject({
            rushAttempts: 2,
            rushingYards: 10,
            rushingTouchdowns: 1,
            targets: 1,
            receptions: 0,
            epa: -2.25,
        })
    })

    it('orders by involvement, then name', () => {
        expect(playerLines(plays).map((l) => l.player)).toEqual([qb, rb, wr, '#1 Z.Back'])
    })

    it('counts a scrimmage fumble lost but never a returner fumble', () => {
        const lines = playerLines([
            // A sack-fumble: no pass attempt, only the lost ball.
            play({ type: 'Sack', passer: qb, fumbleLostBy: qb, isTurnover: true }),
            play({ type: 'Run', rusher: rb, yardsGained: 5, fumbleLostBy: rb, isTurnover: true }),
            // The opposing returner losing a punt is not a line stat here.
            play({ type: 'Punt', returner: '#2 M.Alford', fumbleLostBy: '#2 M.Alford' }),
        ])
        const byName = Object.fromEntries(lines.map((l) => [l.player, l]))
        expect(byName[qb].fumblesLost).toBe(1)
        expect(byName[qb].passAttempts).toBe(0)
        expect(byName[rb].fumblesLost).toBe(1)
        expect(byName['#2 M.Alford']).toBeUndefined()
    })

    it('keeps the same name on two teams apart and counts distinct games', () => {
        const lines = playerLines([
            play({ type: 'Run', rusher: rb, gameId: 1 }),
            play({ type: 'Run', rusher: rb, gameId: 2 }),
            play({ type: 'Run', rusher: rb, gameId: 2, geniusTeamId: B }),
        ])
        expect(lines).toHaveLength(2)
        expect(lines.find((l) => l.geniusTeamId === A)?.games).toBe(2)
        expect(lines.find((l) => l.geniusTeamId === B)?.games).toBe(1)
    })
})
