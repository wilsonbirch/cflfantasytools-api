import { describe, expect, it } from 'vitest'
import { fantasyPoints } from '~/services/fantasy/scoring'

// Real 2026 lines from players.json, checked against Game Zone's own `points`.
describe('fantasyPoints', () => {
    it('scores a receiver: 1 per catch, 10 yards per point, 6 a touchdown', () => {
        // Tyson Philpot, season to gameweek 11: 83 rec, 1229 yds, 9 TD, 16 rush yds.
        expect(
            fantasyPoints({
                passingYards: 0,
                passingTouchdowns: 0,
                interceptions: 0,
                rushingYards: 16,
                rushingTouchdowns: 0,
                receptions: 83,
                receivingYards: 1229,
                receivingTouchdowns: 9,
            }),
        ).toBe(261.5)
    })

    it('scores a back across rushing and receiving', () => {
        // Justin Rankin: 136/791/8 rushing, 45/527/1 receiving.
        expect(
            fantasyPoints({
                passingYards: 0,
                passingTouchdowns: 0,
                interceptions: 0,
                rushingYards: 791,
                rushingTouchdowns: 8,
                receptions: 45,
                receivingYards: 527,
                receivingTouchdowns: 1,
            }),
        ).toBe(230.8)
    })

    it('scores a quarterback: 25 yards per point, 4 a touchdown, -2 a pick', () => {
        // Arithmetic only: 9.24 + 12 - 2 + 4.3 + 6. Quarterback feed totals run
        // a few points under this (see scoring.ts), so no feed line is quoted.
        expect(
            fantasyPoints({
                passingYards: 231,
                passingTouchdowns: 3,
                interceptions: 1,
                rushingYards: 43,
                rushingTouchdowns: 1,
                receptions: 0,
                receivingYards: 0,
                receivingTouchdowns: 0,
            }),
        ).toBe(29.5)
    })

    it('adds converts and return touchdowns when given', () => {
        expect(
            fantasyPoints({
                passingYards: 0,
                passingTouchdowns: 0,
                interceptions: 0,
                rushingYards: 0,
                rushingTouchdowns: 0,
                receptions: 0,
                receivingYards: 0,
                receivingTouchdowns: 0,
                twoPointConversions: 1,
                returnTouchdowns: 1,
            }),
        ).toBe(8)
    })
})
