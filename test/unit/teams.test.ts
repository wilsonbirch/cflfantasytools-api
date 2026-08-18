import { describe, expect, it } from 'vitest'
import { TEAMS } from '~/data/teams'

// These are guardrails against the single most dangerous mistake in this port:
// three different 1-9 (and numeric) id spaces that look interchangeable and are not.
describe('team seed data', () => {
    it('covers all nine clubs', () => {
        expect(TEAMS).toHaveLength(9)
    })

    it.each(['slug', 'abbreviation', 'geniusTeamId', 'gameZoneSquadId', 'legacyTeamId'] as const)(
        'has a unique %s for every team',
        (key) => {
            const values = TEAMS.map((t) => t[key])
            expect(new Set(values).size).toBe(TEAMS.length)
        },
    )

    it('does NOT let Game Zone squad ids be confused with legacy 3DF ids', () => {
        // If these ever coincide, someone has "simplified" the mapping and the
        // data is now silently attributed to the wrong clubs.
        const identical = TEAMS.filter((t) => t.gameZoneSquadId === t.legacyTeamId)
        expect(identical).toEqual([])
    })

    it('pins Ottawa to the ids that prove the two spaces are reversed', () => {
        const ott = TEAMS.find((t) => t.abbreviation === 'OTT')
        expect(ott?.gameZoneSquadId).toBe(1)
        expect(ott?.legacyTeamId).toBe(9)
    })

    it('uses current-season depth chart URLs', () => {
        const stale = TEAMS.filter((t) => /\/20(2[0-5])[-/]/.test(t.depthChartUrl))
        expect(stale.map((t) => t.abbreviation)).toEqual([])
    })

    it('only references implemented extractor strategies', () => {
        const known = new Set(['tableRowCells', 'tableCellLookback', 'cardList'])
        for (const t of TEAMS) expect(known.has(t.strategy)).toBe(true)
    })
})
