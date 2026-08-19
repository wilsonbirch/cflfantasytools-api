import { describe, expect, it } from 'vitest'
import { CORPUS_YEARS, evaluateLegacyGame } from '~/services/pbp/importLegacyGames.server'

const FIXTURE_ID = 9888986

const payload = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
        data: {
            betGeniusFixtureId: String(FIXTURE_ID),
            playByPlayInfo: { ALL: [{ id: '1-1' }, { id: '1-2' }] },
            ...over,
        },
    })

const row = (over: Partial<{ id: number; year: number; response: string }> = {}) => ({
    id: FIXTURE_ID,
    year: 2023,
    response: payload(),
    ...over,
})

describe('CORPUS_YEARS', () => {
    // The single most consequential constant in the EPA work: 2022 is a partial
    // capture (22 plays/game, 41% of them scoring) and fitting on it would make
    // every play look far likelier to score than it is.
    it('is 2023 and 2024 only, never 2022', () => {
        expect([...CORPUS_YEARS]).toEqual([2023, 2024])
        expect(CORPUS_YEARS).not.toContain(2022)
    })
})

describe('evaluateLegacyGame', () => {
    it('accepts a well-formed row and keys it on the payload fixture id', () => {
        const result = evaluateLegacyGame(row())

        expect(result).toMatchObject({ ok: true, fixtureId: FIXTURE_ID, year: 2023, plays: 2 })
    })

    it('carries the raw response through untouched', () => {
        const response = payload()
        const result = evaluateLegacyGame(row({ response }))

        // The blob is the only surviving copy of this play-by-play. The importer
        // must never normalize, re-encode or prettify it on the way in.
        expect(result.ok && result.response).toBe(response)
    })

    it('rejects a response that is not JSON', () => {
        const result = evaluateLegacyGame(row({ response: 'not json at all' }))

        expect(result.ok).toBe(false)
        expect(result.ok === false && result.reason).toContain('not valid JSON')
    })

    it('rejects a payload with no fixture id', () => {
        const result = evaluateLegacyGame(row({ response: payload({ betGeniusFixtureId: null }) }))

        expect(result.ok).toBe(false)
        expect(result.ok === false && result.reason).toContain('betGeniusFixtureId')
    })

    it('rejects a non-numeric fixture id rather than coercing it', () => {
        const result = evaluateLegacyGame(row({ response: payload({ betGeniusFixtureId: 'abc' }) }))

        expect(result.ok).toBe(false)
    })

    it('refuses a row whose payload describes a different fixture', () => {
        // The dangerous case: importing under the wrong id would overwrite a
        // DIFFERENT game's payload. Refuse rather than guess which id is right.
        const result = evaluateLegacyGame(
            row({ response: payload({ betGeniusFixtureId: '10798150' }) }),
        )

        expect(result.ok).toBe(false)
        expect(result.ok === false && result.reason).toContain('mislabelled')
    })

    it('treats an empty play list as skippable, not as corruption', () => {
        const result = evaluateLegacyGame(
            row({ response: payload({ playByPlayInfo: { ALL: [] } }) }),
        )

        expect(result.ok).toBe(false)
        expect(result.ok === false && result.reason).toContain('has no plays')
    })

    it('treats a missing play list the same way', () => {
        const result = evaluateLegacyGame(row({ response: payload({ playByPlayInfo: {} }) }))

        expect(result.ok).toBe(false)
        expect(result.ok === false && result.reason).toContain('has no plays')
    })

    it('preserves the row year rather than deriving it from the payload', () => {
        // Era scoping keys off the season, and the legacy table is the authority
        // on which season a game belongs to.
        const result = evaluateLegacyGame(row({ year: 2024 }))

        expect(result.ok && result.year).toBe(2024)
    })
})
