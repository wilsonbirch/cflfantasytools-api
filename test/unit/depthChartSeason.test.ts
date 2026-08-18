import { describe, expect, it } from 'vitest'
import { getDepthChartInfo } from '~/services/depthCharts/season.server'

// Ported from 3DF unchanged, deliberately. The boundaries are hardcoded dates,
// which is wrong in principle — the 2026 season actually opened June 4, not
// June 5 — but changing behaviour during a port hides which bugs are new. The
// correct fix is deriving both from the Gameweek rows the feed already provides.
describe('getDepthChartInfo', () => {
    it('calls anything before June 5 preseason', () => {
        expect(getDepthChartInfo(new Date('2026-05-18T12:00:00Z')).season).toBe('pre')
    })

    it('calls anything after October 31 postseason', () => {
        expect(getDepthChartInfo(new Date('2026-11-15T12:00:00Z')).season).toBe('post')
    })

    it('calls mid-season regular', () => {
        expect(getDepthChartInfo(new Date('2026-08-17T12:00:00Z')).season).toBe('regular')
    })

    it('counts weeks from the first Sunday of the regular season', () => {
        // 2026-06-05 is a Friday, so week 1 starts Sunday 2026-06-07.
        expect(getDepthChartInfo(new Date('2026-06-07T12:00:00Z')).week).toBe(1)
        expect(getDepthChartInfo(new Date('2026-06-14T12:00:00Z')).week).toBe(2)
    })

    it('never reports a week below 1, even inside the boundary gap', () => {
        // Between June 5 and the first Sunday the elapsed time is negative.
        expect(getDepthChartInfo(new Date('2026-06-06T12:00:00Z')).week).toBe(1)
    })

    it('defaults preseason to week 1', () => {
        expect(getDepthChartInfo(new Date('2026-03-01T12:00:00Z')).week).toBe(1)
    })
})
