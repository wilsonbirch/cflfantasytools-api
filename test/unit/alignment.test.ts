import { describe, expect, it } from 'vitest'
import { alignmentFor, primaryAlignment, splitPlayText } from '~/services/stats/alignment'

// Calgary's week-12 chart, as parsed.
const CGY = [
    { position: '1WK', player: 'JONES', jersey: 4, depth: 1 },
    { position: '2WK', player: 'PHILPOT', jersey: 85, depth: 1 },
    { position: '2WK', player: 'AJOU', jersey: 89, depth: 2 },
    { position: '1S', player: 'BARNES', jersey: 14, depth: 1 },
    { position: '2S', player: 'BROOKS', jersey: 87, depth: 1 },
    { position: '3S', player: 'BRISSETT', jersey: 17, depth: 1 },
]

describe('splitPlayText', () => {
    it('separates the jersey from the surname and drops initials', () => {
        expect(splitPlayText('#85 J.Philpot')).toEqual({ jersey: 85, surname: 'philpot' })
        expect(splitPlayText('#3 V.Adams Jr.')).toEqual({ jersey: 3, surname: 'adamsjr' })
        expect(splitPlayText('#89 K.Schaffer-Baker')).toEqual({
            jersey: 89,
            surname: 'schafferbaker',
        })
        expect(splitPlayText('Team')).toEqual({ jersey: null, surname: 'team' })
    })
})

describe('alignmentFor', () => {
    it('matches on jersey and a compatible surname', () => {
        expect(alignmentFor('#85 J.Philpot', CGY)).toBe('2WK')
        expect(alignmentFor('#14 D.Barnes', CGY)).toBe('1S')
        expect(alignmentFor('#89 J.Ajou', CGY)).toBe('2WK')
    })

    it('lets the jersey decide when the club abbreviates the name', () => {
        const mtl = [{ position: '2S', player: 'A.-BERGLUND', jersey: 91, depth: 1 }]
        expect(alignmentFor('#91 I.Adeyemi-Berglund', mtl)).toBe('2S')
    })

    it('refuses a jersey worn by someone else on a stale chart, unless it is unambiguous', () => {
        const two = [
            { position: '1S', player: 'SMITH', jersey: 80, depth: 1 },
            { position: '2S', player: 'SMITH', jersey: 80, depth: 2 },
        ]
        expect(alignmentFor('#80 J.Jones', two)).toBeNull()
        expect(alignmentFor('#80 J.Smith', two)).toBe('1S')
    })

    it('returns null for a player not on the chart, or a name with no jersey', () => {
        expect(alignmentFor('#12 J.Love', CGY)).toBeNull()
        expect(alignmentFor('Team', CGY)).toBeNull()
        expect(alignmentFor('#85 J.Philpot', [])).toBeNull()
    })

    it('handles suffixes and lone initials on the chart', () => {
        const ssk = [
            { position: '2WK', player: 'K. JOHNSON', jersey: 3, depth: 1 },
            { position: '1WK', player: 'LETCHER JR', jersey: 1, depth: 2 },
        ]
        expect(alignmentFor('#3 K.Johnson', ssk)).toBe('2WK')
        expect(alignmentFor('#1 J.Letcher Jr.', ssk)).toBe('1WK')
    })
})

describe('primaryAlignment', () => {
    it('takes the most common slot over the season, ties toward the outside', () => {
        const week1 = [{ position: '2S', player: 'BROOKS', jersey: 87, depth: 1 }]
        const week2 = [{ position: '3S', player: 'BROOKS', jersey: 87, depth: 1 }]
        const week3 = [{ position: '3S', player: 'BROOKS', jersey: 87, depth: 1 }]
        expect(primaryAlignment('#87 M.Brooks', [week1, week2, week3])).toBe('3S')
        expect(primaryAlignment('#87 M.Brooks', [week1, week2])).toBe('2S')
        expect(primaryAlignment('#87 M.Brooks', [])).toBeNull()
    })
})
