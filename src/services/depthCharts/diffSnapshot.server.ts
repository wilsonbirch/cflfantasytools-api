import type { DepthChartItem } from './scrape/extractors'

// A scrape that collapses by more than this is treated as a page failure, not
// as the club deleting its charts. Real removals are gradual; a redesign or an
// error page is what makes a list fall off a cliff.
const COLLAPSE_THRESHOLD = 0.5

export type SnapshotDiff = {
    added: DepthChartItem[]
    removed: DepthChartItem[]
    // Same href, changed title — recorded but not treated as a new posting.
    retitled: DepthChartItem[]
    unchanged: number
}

export type DiffVerdict =
    | { kind: 'first-snapshot'; diff: SnapshotDiff }
    | { kind: 'changed'; diff: SnapshotDiff }
    | { kind: 'unchanged'; diff: SnapshotDiff }
    // Do not persist, do not notify — something is wrong with the page.
    | { kind: 'rejected'; reason: string; diff: SnapshotDiff }

/**
 * Compare a fresh scrape against the last stored snapshot.
 *
 * 3DF compared ARRAY LENGTHS and, on any difference, treated
 * `value[value.length - 1]` as the single new chart. That failed three ways: a
 * chart replaced in place was invisible (same count), a shrinking list emailed
 * every subscriber about an old chart, and two charts posted at once lost one.
 *
 * Identity here is the normalized href, so an in-place replacement registers,
 * every added item is reported, and a shrink produces no additions at all.
 */
export function diffSnapshot(
    previous: DepthChartItem[] | null,
    current: DepthChartItem[],
): DiffVerdict {
    const empty: SnapshotDiff = { added: [], removed: [], retitled: [], unchanged: 0 }

    // An empty scrape is a failure, not the club removing everything.
    if (current.length === 0) {
        return { kind: 'rejected', reason: 'scrape returned no items', diff: empty }
    }

    if (previous === null) {
        // Record silently. Without this the first sweep for a (team, year) would
        // notify every subscriber about every chart already on the page.
        return { kind: 'first-snapshot', diff: { ...empty, added: current } }
    }

    if (previous.length > 0 && current.length < previous.length * COLLAPSE_THRESHOLD) {
        return {
            kind: 'rejected',
            reason: `item count collapsed from ${previous.length} to ${current.length}`,
            diff: empty,
        }
    }

    const prevByHref = new Map(previous.map((i) => [i.href, i]))
    const currByHref = new Map(current.map((i) => [i.href, i]))

    const added = current.filter((i) => !prevByHref.has(i.href))
    const removed = previous.filter((i) => !currByHref.has(i.href))
    const retitled = current.filter((i) => {
        const before = prevByHref.get(i.href)
        return before !== undefined && before.title !== i.title
    })
    const unchanged = current.length - added.length - retitled.length

    const diff: SnapshotDiff = { added, removed, retitled, unchanged }
    const changed = added.length > 0 || removed.length > 0 || retitled.length > 0
    return { kind: changed ? 'changed' : 'unchanged', diff }
}
