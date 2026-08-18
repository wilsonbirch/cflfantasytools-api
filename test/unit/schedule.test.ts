import { describe, expect, it } from 'vitest'
import { dueScheduledKinds, type ScheduleRule } from '~/worker/schedule.server'

const HOUR = 60 * 60 * 1000
const now = new Date('2026-08-17T09:30:00Z')

describe('dueScheduledKinds', () => {
    it('fires a rule that has never run', () => {
        const rules: ScheduleRule[] = [{ kind: 'sweep', everyMs: 6 * HOUR }]
        expect(dueScheduledKinds(now, { sweep: null }, rules)).toEqual(['sweep'])
    })

    it('holds an interval rule that ran recently', () => {
        const rules: ScheduleRule[] = [{ kind: 'sweep', everyMs: 6 * HOUR }]
        const lastRun = new Date(now.getTime() - HOUR)
        expect(dueScheduledKinds(now, { sweep: lastRun }, rules)).toEqual([])
    })

    it('fires an interval rule once the interval has elapsed', () => {
        const rules: ScheduleRule[] = [{ kind: 'sweep', everyMs: 6 * HOUR }]
        const lastRun = new Date(now.getTime() - 7 * HOUR)
        expect(dueScheduledKinds(now, { sweep: lastRun }, rules)).toEqual(['sweep'])
    })

    it('fires a daily rule only during its UTC hour', () => {
        const rules: ScheduleRule[] = [{ kind: 'nightly', atUtcHour: 9, minGapMs: 20 * HOUR }]
        const yesterday = new Date(now.getTime() - 24 * HOUR)
        expect(dueScheduledKinds(now, { nightly: yesterday }, rules)).toEqual(['nightly'])

        const wrongHour = new Date('2026-08-17T11:30:00Z')
        expect(dueScheduledKinds(wrongHour, { nightly: yesterday }, rules)).toEqual([])
    })

    it('does not double-fire a daily rule within its minimum gap', () => {
        const rules: ScheduleRule[] = [{ kind: 'nightly', atUtcHour: 9, minGapMs: 20 * HOUR }]
        const earlierSameHour = new Date(now.getTime() - 10 * 60 * 1000)
        expect(dueScheduledKinds(now, { nightly: earlierSameHour }, rules)).toEqual([])
    })
})
