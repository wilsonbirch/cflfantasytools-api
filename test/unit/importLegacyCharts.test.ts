import { describe, expect, it } from 'vitest'
import { gameNumber, titleDate } from '~/services/depthCharts/importLegacyCharts.server'

// Titles verbatim from the legacy dump — the formats are per-club and the
// whole risk is a pattern that reads one club and silently drops another.

describe('titleDate', () => {
    it('reads "Week 5, Sat. July 6," style', () => {
        expect(titleDate('Week 5, Sat. July 6, ', 2024)).toEqual(new Date(Date.UTC(2024, 6, 6, 12)))
    })

    it('reads the abbreviated month in "WEEK\\n2, FRI JUN 13\\n7:30 PM EDT, MTL @ OTT"', () => {
        expect(titleDate('WEEK\n2, FRI JUN 13\n7:30 PM EDT, MTL @ OTT', 2025)).toEqual(
            new Date(Date.UTC(2025, 5, 13, 12)),
        )
    })

    it('reads "3, Jun 20, 2024" style', () => {
        expect(titleDate('3, Jun 20, 2024, ', 2024)).toEqual(new Date(Date.UTC(2024, 5, 20, 12)))
    })

    it('returns null for Calgary titles that carry no date', () => {
        expect(titleDate('Game 14, SSK, CGY', 2024)).toBeNull()
    })

    it('does not read a club abbreviation as a month', () => {
        // "MAY" the month vs a stray token: only a month followed by a day counts.
        expect(titleDate('Saturday, SSK @ B.C., ', 2024)).toBeNull()
    })
})

describe('gameNumber', () => {
    it('reads a regular-season game number', () => {
        expect(gameNumber('Game 14, SSK, CGY')).toEqual({ n: 14, pre: false })
    })

    it('reads a preseason game number as preseason', () => {
        expect(gameNumber('Pre-Season Game 1, BC, CGY')).toEqual({ n: 1, pre: true })
    })

    it('returns null when the title has no game number', () => {
        expect(gameNumber('Week 5, Sat. July 6, ')).toBeNull()
    })
})
