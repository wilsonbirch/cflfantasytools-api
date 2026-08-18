import { describe, expect, it } from 'vitest'
import { currentSeasonYear, ruleEraForYear } from '~/lib/season.server'

// The era boundaries are the reason historical play-by-play cannot be pooled
// into one fitted model. See docs/memory/project-cfl-rule-eras.md.
describe('ruleEraForYear', () => {
    it.each([2022, 2023, 2024, 2025])('treats %i as the pre-2026 era', (y) => {
        expect(ruleEraForYear(y)).toBe('PRE_2026')
    })

    it('treats 2026 as its own era — the rouge changed, the field did not', () => {
        expect(ruleEraForYear(2026)).toBe('E2026')
    })

    it.each([2027, 2028, 2035])('treats %i as the post-field-change era', (y) => {
        // 2027 shortens the field and moves the goalposts, which changes the
        // yard-line domain an expected-points model is fitted over.
        expect(ruleEraForYear(y)).toBe('E2027')
    })

    it('never pools 2025 and 2026 into the same era', () => {
        expect(ruleEraForYear(2025)).not.toBe(ruleEraForYear(2026))
    })
})

describe('currentSeasonYear', () => {
    it('uses the calendar year', () => {
        expect(currentSeasonYear(new Date('2026-08-17T00:00:00Z'))).toBe(2026)
    })

    it('keeps attributing the off-season to the year just played', () => {
        // A January pull still belongs to the season that finished in November.
        expect(currentSeasonYear(new Date('2026-01-05T00:00:00Z'))).toBe(2026)
    })
})
