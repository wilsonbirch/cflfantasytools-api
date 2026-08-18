import { describe, expect, it } from 'vitest'
import { diffSnapshot } from '~/services/depthCharts/diffSnapshot.server'

const item = (href: string, title = 'Week 1') => ({ href, title })
const A = item('https://x.test/w1.pdf')
const B = item('https://x.test/w2.pdf')
const C = item('https://x.test/w3.pdf')

// 3DF compared ARRAY LENGTHS and, on any difference, treated the last element as
// the single new chart. Each test below is a way that failed.
describe('diffSnapshot', () => {
    it('reports a genuinely new chart', () => {
        const v = diffSnapshot([A], [A, B])
        expect(v.kind).toBe('changed')
        expect(v.diff.added).toEqual([B])
    })

    it('reports EVERY new chart, not just the last', () => {
        // Two charts posted between sweeps: 3DF would have emailed about one.
        const v = diffSnapshot([A], [A, B, C])
        expect(v.diff.added).toEqual([B, C])
    })

    it('detects a chart replaced IN PLACE', () => {
        // Same count, different document. Invisible to a length comparison.
        const v = diffSnapshot([A, B], [A, item('https://x.test/w2-corrected.pdf')])
        expect(v.kind).toBe('changed')
        expect(v.diff.added.map((i) => i.href)).toEqual(['https://x.test/w2-corrected.pdf'])
        expect(v.diff.removed).toEqual([B])
    })

    it('adds nothing when the list SHRINKS', () => {
        // 3DF took value[length-1] on any length change, so a removal emailed
        // every subscriber about an old chart.
        const v = diffSnapshot([A, B, C], [A, B])
        expect(v.diff.added).toEqual([])
        expect(v.diff.removed).toEqual([C])
    })

    it('treats a retitled chart as changed but not newly posted', () => {
        const v = diffSnapshot([A], [item(A.href, 'Week 1 (updated)')])
        expect(v.kind).toBe('changed')
        expect(v.diff.added).toEqual([])
        expect(v.diff.retitled).toHaveLength(1)
    })

    it('reports no change when nothing moved', () => {
        expect(diffSnapshot([A, B], [A, B]).kind).toBe('unchanged')
    })
})

describe('safety gates', () => {
    it('rejects an empty scrape rather than reading it as a mass deletion', () => {
        const v = diffSnapshot([A, B], [])
        expect(v.kind).toBe('rejected')
        expect(v.kind === 'rejected' && v.reason).toMatch(/no items/)
    })

    it('rejects a collapse of more than half', () => {
        // A redesign or an error page, not a club deleting its season.
        const v = diffSnapshot([A, B, C, item('https://x.test/w4.pdf')], [A])
        expect(v.kind).toBe('rejected')
        expect(v.kind === 'rejected' && v.reason).toMatch(/collapsed/)
    })

    it('allows a modest shrink', () => {
        expect(diffSnapshot([A, B, C], [A, B]).kind).toBe('changed')
    })

    it('records the first snapshot silently', () => {
        // Without this the first sweep would notify about every chart already
        // on the page.
        const v = diffSnapshot(null, [A, B])
        expect(v.kind).toBe('first-snapshot')
        expect(v.diff.added).toEqual([A, B])
    })

    it('still rejects an empty first scrape', () => {
        expect(diffSnapshot(null, []).kind).toBe('rejected')
    })
})
