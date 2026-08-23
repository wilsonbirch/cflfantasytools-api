import { describe, expect, it } from 'vitest'
import {
    buildEpLookup,
    distanceBucket,
    epaForPlays,
    EP_SOURCE_ERA,
    epSourceEras,
    fitCells,
    yardLineBucket,
    type EpaPlay,
    type EpCell,
    type TrainingRow,
} from '~/services/epa/epModel'

describe('EP_SOURCE_ERA', () => {
    it('prices 2026 from the 2023/24 surface, because the field did not change', () => {
        expect(EP_SOURCE_ERA.E2026).toBe('PRE_2026')
        expect(EP_SOURCE_ERA.PRE_2026).toBe('PRE_2026')
    })

    it('prices 2027 from NOTHING', () => {
        // The field goes 110 -> 100, end zones 20 -> 15, and the goalposts move
        // to the back, adding ~15 yards to every field goal. The yard-line axis
        // is a different axis and field-position value is not linear, so there
        // is no rescaling. No EPA beats a plausible wrong one.
        expect(EP_SOURCE_ERA.E2027).toBeNull()
    })
})

describe('epSourceEras', () => {
    it('tries the borrowed prior first, then the era itself', () => {
        expect(epSourceEras('E2026')).toEqual(['PRE_2026', 'E2026'])
        expect(epSourceEras('PRE_2026')).toEqual(['PRE_2026'])
    })

    it('lets 2027 be priced only from 2027 plays', () => {
        expect(epSourceEras('E2027')).toEqual(['E2027'])
    })
})

describe('distanceBucket', () => {
    it('buckets yards to go', () => {
        expect(distanceBucket(1)).toBe('1-3')
        expect(distanceBucket(3)).toBe('1-3')
        expect(distanceBucket(4)).toBe('4-6')
        expect(distanceBucket(10)).toBe('7-10')
        expect(distanceBucket(11)).toBe('11+')
        expect(distanceBucket(35)).toBe('11+')
    })
})

describe('yardLineBucket', () => {
    it('bands the field in tens from the possessing team own goal', () => {
        expect(yardLineBucket(0)).toBe(0)
        expect(yardLineBucket(9)).toBe(0)
        expect(yardLineBucket(10)).toBe(1)
        expect(yardLineBucket(105)).toBe(10)
    })

    it('clamps a yard line logged outside the field', () => {
        // Returns are logged past the goal line; a phantom bucket 11 would be a
        // cell of one play that the lookup could then read.
        expect(yardLineBucket(130)).toBe(10)
        expect(yardLineBucket(-5)).toBe(0)
    })

    it('narrows the field in 2027', () => {
        // 100 yards is ten bands, not eleven.
        expect(yardLineBucket(95, 100)).toBe(9)
        expect(yardLineBucket(105, 100)).toBe(9)
    })
})

describe('fitCells', () => {
    const row = (over: Partial<TrainingRow> = {}): TrainingRow => ({
        down: 1,
        distance: 10,
        yardsFromOwnGoal: 55,
        nextPointOutcome: 3,
        ...over,
    })

    it('averages the label within a bin', () => {
        const cells = fitCells([
            row({ nextPointOutcome: 7 }),
            row({ nextPointOutcome: 3 }),
            row({ nextPointOutcome: -7 }),
        ])

        expect(cells).toHaveLength(1)
        expect(cells[0].expectedPoints).toBeCloseTo(1, 10)
        expect(cells[0].sampleSize).toBe(3)
    })

    it('keeps negative labels, which are drives that ended in a score against', () => {
        const cells = fitCells([row({ nextPointOutcome: -7 }), row({ nextPointOutcome: -3 })])

        expect(cells[0].expectedPoints).toBe(-5)
    })

    it('separates bins by down, distance and field position', () => {
        const cells = fitCells([
            row(),
            row({ down: 2 }),
            row({ distance: 1 }),
            row({ yardsFromOwnGoal: 15 }),
        ])

        expect(cells).toHaveLength(4)
    })

    it('emits thin cells rather than dropping them', () => {
        // A cell of one play is a real observation the lookup can pool. Dropping
        // it here would hide where the corpus is empty.
        const cells = fitCells([row({ yardsFromOwnGoal: 5 })])

        expect(cells).toHaveLength(1)
        expect(cells[0].sampleSize).toBe(1)
    })

    it('returns nothing for an empty corpus rather than throwing', () => {
        expect(fitCells([])).toEqual([])
    })
})

describe('buildEpLookup', () => {
    const cell = (over: Partial<EpCell> = {}): EpCell => ({
        down: 1,
        distanceBucket: '7-10',
        yardLineBucket: 5,
        expectedPoints: 1.5,
        sampleSize: 100,
        ...over,
    })

    it('reads a well-sampled cell directly', () => {
        const ep = buildEpLookup([cell()], 50)

        expect(ep(1, 10, 55)).toBe(1.5)
    })

    it('pools across distance when the exact cell is too thin', () => {
        // 10 plays at 1st & 1 is not an estimate. The other distances at the
        // same down and field position are the nearest honest thing.
        const ep = buildEpLookup(
            [
                cell({ distanceBucket: '1-3', expectedPoints: 9, sampleSize: 10 }),
                cell({ distanceBucket: '7-10', expectedPoints: 2, sampleSize: 90 }),
            ],
            50,
        )

        // Sample-weighted: (9*10 + 2*90) / 100 — NOT the mean of 9 and 2.
        expect(ep(1, 2, 55)).toBeCloseTo(2.7, 10)
    })

    it('pools across downs when a whole down is too thin', () => {
        const ep = buildEpLookup(
            [
                cell({ down: 3, distanceBucket: '11+', expectedPoints: 9, sampleSize: 5 }),
                cell({ down: 1, expectedPoints: 1, sampleSize: 200 }),
            ],
            50,
        )

        expect(ep(3, 20, 55)).toBeCloseTo((9 * 5 + 1 * 200) / 205, 10)
    })

    it('returns null for a field position the corpus never saw', () => {
        // Not a league average. An EPA of null means "not measured", and that
        // distinction is the difference between an honest model and a confident
        // one.
        const ep = buildEpLookup([cell()], 50)

        expect(ep(1, 10, 5)).toBeNull()
    })

    it('returns null from an empty surface', () => {
        expect(buildEpLookup([], 50)(1, 10, 55)).toBeNull()
    })
})

// ---------------------------------------------------------------------------
// EPA
// ---------------------------------------------------------------------------

const HOME = 'HOME'
const AWAY = 'AWAY'

const p = (over: Partial<EpaPlay> = {}): EpaPlay => ({
    driveTeamId: HOME,
    playTeamId: HOME,
    half: 'H1',
    down: 1,
    distance: 10,
    yardsFromOwnGoal: 55,
    points: null,
    isNoPlay: false,
    ...over,
})

/** A flat surface: every state is worth 1 point. Isolates the sequence logic. */
const flat = () => () => 1

describe('epaForPlays', () => {
    it('is the change in expected points between two states', () => {
        const ep = (_d: number, _dist: number, ygo: number) => (ygo === 55 ? 1 : 4)

        const [first] = epaForPlays([p(), p({ yardsFromOwnGoal: 80 })], ep)

        expect(first).toBe(3)
    })

    it('values a touchdown at what a touchdown is worth', () => {
        // Not at the expected value of the kickoff that follows it.
        const [epa] = epaForPlays(
            [p({ points: 6 }), p({ down: null, yardsFromOwnGoal: null })],
            flat(),
        )

        expect(epa).toBe(5)
    })

    it('charges a pick-six to the offence, not to the team whose row it is', () => {
        // The single most important sign in the whole calculation. The feed
        // stamps the touchdown with the RETURNING team's id.
        const [epa] = epaForPlays([p({ playTeamId: AWAY, points: 6 })], flat())

        expect(epa).toBe(-7)
    })

    it('charges an unmarked return touchdown to the punting team', () => {
        // Those arrive already negative for the team whose play it is.
        const [epa] = epaForPlays([p({ points: -6 })], flat())

        expect(epa).toBe(-7)
    })

    it('negates the next state when possession changes hands', () => {
        const [punt] = epaForPlays([p(), p({ driveTeamId: AWAY, playTeamId: AWAY })], flat())

        // Handing the opponent a state worth 1 costs 2: losing your own 1 and
        // giving them theirs.
        expect(punt).toBe(-2)
    })

    it('stops at the half rather than crossing it', () => {
        const [epa] = epaForPlays([p(), p({ half: 'H2' })], flat())

        // A punt with forty seconds left is not punished by the third quarter.
        expect(epa).toBeNull()
    })

    it('skips over plays with no state to find the next real one', () => {
        const ep = (_d: number, _dist: number, ygo: number) => (ygo === 55 ? 1 : 4)

        const [epa] = epaForPlays(
            [
                p(),
                // A convert and a kickoff: no down, no line of scrimmage.
                p({ down: null, distance: null, yardsFromOwnGoal: null }),
                p({ yardsFromOwnGoal: 80 }),
            ],
            ep,
        )

        expect(epa).toBe(3)
    })

    it('gives no EPA to a play with no state', () => {
        const values = epaForPlays([p({ down: null, yardsFromOwnGoal: null })], flat())

        expect(values).toEqual([null])
    })

    it('gives no EPA to a penalty that wiped the snap', () => {
        // NO PLAY occupied no down. It did not happen.
        const values = epaForPlays([p({ isNoPlay: true }), p()], flat())

        expect(values[0]).toBeNull()
    })

    it('does not treat a wiped snap as the next state either', () => {
        const ep = (_d: number, _dist: number, ygo: number) =>
            ygo === 55 ? 1 : ygo === 70 ? 99 : 4

        const [epa] = epaForPlays(
            [p(), p({ isNoPlay: true, yardsFromOwnGoal: 70 }), p({ yardsFromOwnGoal: 80 })],
            ep,
        )

        expect(epa).toBe(3)
    })

    it('gives no EPA when the surface cannot price the state', () => {
        expect(epaForPlays([p()], () => null)).toEqual([null])
    })

    it('gives no EPA to the last play of a half', () => {
        expect(epaForPlays([p()], flat())).toEqual([null])
    })

    it('rounds to three decimals rather than storing float noise', () => {
        const ep = (_d: number, _dist: number, ygo: number) => (ygo === 55 ? 0.1 : 0.3)

        const [epa] = epaForPlays([p(), p({ yardsFromOwnGoal: 80 })], ep)

        expect(epa).toBe(0.2)
    })
})
