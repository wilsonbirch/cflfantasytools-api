import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
    chronological,
    driveOutcome,
    groupIntoDrives,
    halfKey,
    nextPointOutcomes,
    type RawPlay,
} from '~/services/pbp/drives'

const payload = JSON.parse(readFileSync('test/fixtures/pbp/widget-payload.json', 'utf8')) as {
    data: { playByPlayInfo: { ALL: RawPlay[] } }
}
const realPlays = payload.data.playByPlayInfo.ALL

/** Minimal play; only the fields the drive logic reads are meaningful. */
const play = (p: Partial<RawPlay> & { id: string; teamId: string }): RawPlay => ({
    type: 'Run',
    subType: null,
    description: '#1 A.Back rush middle for 3 yards gain to the AAA30',
    clock: '10:00',
    timestamp: 0,
    phase: 'Regular',
    phaseQualifier: '1',
    isScoring: false,
    playStartPosition: '1st & 10 at AAA 33',
    ...p,
})

const HOME = '112939'
const AWAY = '106752'

describe('chronological', () => {
    it('reverses the feed, which serves newest first', () => {
        // Every one of the 40 captured 2026 fixtures arrives descending. Parsing
        // as given builds the whole game backwards.
        expect(realPlays[0].id).toBe('29-1')
        const ordered = chronological(realPlays)
        expect(ordered[0].id).toBe('0-1')
        expect(ordered[ordered.length - 1].id).toBe('29-1')
    })

    it('orders by drive then play, not by string', () => {
        // "10-1" sorts before "9-1" as text; it must not here.
        const ordered = chronological([
            play({ id: '10-1', teamId: HOME }),
            play({ id: '9-1', teamId: AWAY }),
            play({ id: '9-2', teamId: AWAY }),
        ])
        expect(ordered.map((p) => p.id)).toEqual(['9-1', '9-2', '10-1'])
    })

    it('does not mutate its input', () => {
        const input = [play({ id: '2-1', teamId: HOME }), play({ id: '1-1', teamId: AWAY })]
        chronological(input)
        expect(input.map((p) => p.id)).toEqual(['2-1', '1-1'])
    })
})

describe('halfKey', () => {
    it('splits the game at the interval', () => {
        expect(halfKey('Regular', '1')).toBe('H1')
        expect(halfKey('Regular', '2')).toBe('H1')
        expect(halfKey('Regular', '3')).toBe('H2')
        expect(halfKey('Regular', '4')).toBe('H2')
    })

    it('treats overtime as its own', () => {
        expect(halfKey('Overtime', '1')).toBe('OT')
    })
})

describe('groupIntoDrives', () => {
    it('groups a real game into its drives', () => {
        const drives = groupIntoDrives(chronological(realPlays))
        expect(drives).toHaveLength(30)
        expect(drives[0].number).toBe(0)
        expect(drives.map((d) => d.number)).toEqual(
            [...drives.map((d) => d.number)].sort((a, b) => a - b),
        )
    })

    it('gives every drive exactly one team', () => {
        for (const drive of groupIntoDrives(chronological(realPlays))) {
            expect(new Set(drive.plays.map((p) => p.teamId)).size).toBe(1)
        }
    })

    it('keeps kickoffs as their own drive, owned by the kicking team', () => {
        const drives = groupIntoDrives(chronological(realPlays))
        const kickoffs = drives.filter((d) => d.plays.every((p) => p.type === 'Kickoff'))
        expect(kickoffs.length).toBeGreaterThan(0)
        for (const d of kickoffs) expect(d.plays).toHaveLength(1)
    })

    it('records the quarter the drive started in', () => {
        const drives = groupIntoDrives([
            play({ id: '1-1', teamId: HOME, phaseQualifier: '3' }),
            play({ id: '1-2', teamId: HOME, phaseQualifier: '3' }),
        ])
        expect(drives[0].startQuarter).toBe(3)
        expect(drives[0].half).toBe('H2')
    })
})

describe('driveOutcome', () => {
    it('sums a touchdown and its convert to 7, not 13', () => {
        // 3DF scored the convert as 7 in its own right, on top of the 6 already
        // counted for the touchdown.
        const [drive] = groupIntoDrives([
            play({
                id: '1-1',
                teamId: HOME,
                type: 'Run',
                subType: 'Touchdown',
                description: '#12 J.Love rush right for 1 yard gain to the SSK00 TOUCHDOWN',
                isScoring: true,
            }),
            play({
                id: '1-2',
                teamId: HOME,
                type: 'OnePoint',
                subType: 'Success',
                description:
                    '#22 J.McAtamney kick attempt good (H: #15 M.Vassett, LS: #43 J.MacGougan)',
                isScoring: true,
            }),
        ])
        expect(driveOutcome(drive)).toEqual({ points: 7, isScoring: true })
    })

    it('scores a field goal drive 3', () => {
        const [drive] = groupIntoDrives([
            play({ id: '1-1', teamId: HOME }),
            play({
                id: '1-2',
                teamId: HOME,
                type: 'FieldGoal',
                subType: 'Success',
                description: '#70 D.Hodge field goal attempt from 43 yards GOOD',
                isScoring: true,
            }),
        ])
        expect(driveOutcome(drive).points).toBe(3)
    })

    it('gives a punt drive no points at all, not zero', () => {
        const [drive] = groupIntoDrives([play({ id: '1-1', teamId: HOME })])
        expect(driveOutcome(drive)).toEqual({ points: null, isScoring: false })
    })

    it('scores a conceded single', () => {
        const [drive] = groupIntoDrives([
            play({
                id: '1-1',
                teamId: HOME,
                type: 'Punt',
                subType: 'Single',
                description: '#10 J.Julien punt 63 yards to the CGY-01 SINGLE, clock 02:50',
                isScoring: true,
            }),
        ])
        expect(driveOutcome(drive).points).toBe(1)
    })

    it('scores a pick-six AGAINST the team that threw it', () => {
        // The real shape of drive 660 in the 2023/24 corpus: Hamilton has the
        // ball, Shiltz is intercepted, Montreal returns it 71 yards and converts.
        // The feed stamps both scoring plays with MONTREAL's id.
        //
        // Summing unsigned gave Hamilton +7 for throwing a pick-six — a 14-point
        // sign error in the expected-points label, and the single worst thing
        // that can be in a training set.
        const [drive] = groupIntoDrives([
            play({ id: '1-1', teamId: HOME }),
            play({
                id: '1-2',
                teamId: AWAY,
                type: 'Pass',
                subType: 'Touchdown',
                description:
                    'Shotgun #18 M.Shiltz pass intercepted by #37 W.Sutton at MTL39 ' +
                    '#37 W.Sutton return 71 yards to the HAM00 TOUCHDOWN',
                isScoring: true,
            }),
            play({
                id: '1-3',
                teamId: AWAY,
                type: 'OnePoint',
                subType: 'Success',
                description: '#15 D.Cote kick attempt good (H: #36 J.Zema, LS: #50 L.Bourassa)',
                isScoring: true,
            }),
        ])

        expect(driveOutcome(drive)).toEqual({ points: -7, isScoring: true })
    })

    it('scores a punt return touchdown against the punting team', () => {
        // Drive 121 in the corpus. The return touchdown carries NO subtype, so it
        // was worth nothing at all, while the convert that followed it was
        // credited +1 to the team that had just been scored on.
        const [drive] = groupIntoDrives([
            play({ id: '1-1', teamId: HOME }),
            play({
                id: '1-2',
                teamId: HOME,
                type: 'Punt',
                subType: null,
                description:
                    '#29 J.Haggerty punt 59 yards to the HAM26 recovered by HAM #81 L.Gallimore ' +
                    'at HAM26 #81 L.Gallimore return 84 yards to the TOR00 TOUCHDOWN, clock 12:21',
            }),
            play({
                id: '1-3',
                teamId: AWAY,
                type: 'OnePoint',
                subType: 'Success',
                description: '#3 E.Ratke kick attempt good (H: #79 B.Flint, LS: #58 G.Whyte)',
                isScoring: true,
            }),
        ])

        expect(driveOutcome(drive)).toEqual({ points: -7, isScoring: true })
    })

    it('still counts a defensive score as a scoring drive', () => {
        // isScoring keys off "points were scored on this drive", not off the sign.
        // Getting this wrong would make nextPointOutcome skip straight past a
        // pick-six to the following drive.
        const [drive] = groupIntoDrives([
            play({ id: '1-1', teamId: HOME }),
            play({
                id: '1-2',
                teamId: AWAY,
                type: 'Pass',
                subType: 'Touchdown',
                description: '#5 A.Passer pass intercepted by #9 B.Back return 40 yards TOUCHDOWN',
                isScoring: true,
            }),
        ])

        expect(driveOutcome(drive)).toEqual({ points: -6, isScoring: true })
    })
})

describe('nextPointOutcomes with a defensive score', () => {
    const pickSix = (id: string, offence: string, defence: string) => [
        play({ id: `${id}-1`, teamId: offence }),
        play({
            id: `${id}-2`,
            teamId: defence,
            type: 'Pass',
            subType: 'Touchdown',
            description: '#5 A.Passer pass intercepted by #9 B.Back return 40 yards TOUCHDOWN',
            isScoring: true,
        }),
    ]

    it('labels the drive that threw the interception negative', () => {
        const drives = groupIntoDrives(pickSix('1', HOME, AWAY))

        // The team with the ball loses 6 on its own drive.
        expect(nextPointOutcomes(drives)).toEqual([-6])
    })

    it('labels an earlier opposing drive positive', () => {
        const drives = groupIntoDrives([
            play({ id: '1-1', teamId: AWAY }),
            ...pickSix('2', HOME, AWAY),
        ])

        // AWAY punts, then HOME throws a pick-six to AWAY: from AWAY's first
        // drive the next score is +6 to AWAY, and from HOME's drive it is -6.
        expect(nextPointOutcomes(drives)).toEqual([6, -6])
    })
})

describe('nextPointOutcomes', () => {
    const drivesOf = (...specs: [string, string, string, Partial<RawPlay>?][]) =>
        groupIntoDrives(
            specs.map(([id, team, quarter, extra]) =>
                play({ id, teamId: team, phaseQualifier: quarter, ...extra }),
            ),
        )

    const touchdown = {
        type: 'Run',
        subType: 'Touchdown',
        description: '#1 A.Back rush right for 4 yards gain to the AAA00 TOUCHDOWN',
        isScoring: true,
    }

    it('signs the next score POSITIVE for the team that goes on to score it', () => {
        const drives = drivesOf(['1-1', HOME, '1'], ['2-1', HOME, '1', touchdown])
        expect(nextPointOutcomes(drives)).toEqual([6, 6])
    })

    it('signs it NEGATIVE when the opponent scores next', () => {
        const drives = drivesOf(['1-1', HOME, '1'], ['2-1', AWAY, '1', touchdown])
        expect(nextPointOutcomes(drives)).toEqual([-6, 6])
    })

    it('does NOT let a score carry back across the interval', () => {
        // A punt with a minute left in the half is not rewarded by a touchdown
        // after the break — the possession did not carry over.
        const drives = drivesOf(['1-1', HOME, '2'], ['2-1', HOME, '3', touchdown])
        expect(nextPointOutcomes(drives)).toEqual([null, 6])
    })

    it('returns NULL, not zero, when the half ends with no further score', () => {
        // Zero would teach the model that possession at midfield is worthless.
        const drives = drivesOf(['1-1', HOME, '1'], ['2-1', AWAY, '2'])
        expect(nextPointOutcomes(drives)).toEqual([null, null])
    })

    it('keeps overtime separate from the second half', () => {
        const drives = drivesOf(
            ['1-1', HOME, '4'],
            ['2-1', HOME, '1', { ...touchdown, phase: 'Overtime' }],
        )
        expect(nextPointOutcomes(drives)).toEqual([null, 6])
    })

    it('looks past a non-scoring drive to the next one that scores', () => {
        const drives = drivesOf(
            ['1-1', HOME, '1'],
            ['2-1', AWAY, '1'],
            ['3-1', HOME, '1'],
            ['4-1', AWAY, '1', touchdown],
        )
        expect(nextPointOutcomes(drives)).toEqual([-6, 6, -6, 6])
    })

    it('produces a usable label on a real game', () => {
        const drives = groupIntoDrives(chronological(realPlays))
        const labels = nextPointOutcomes(drives)
        expect(labels).toHaveLength(drives.length)
        // Every non-null label is a real CFL scoring value.
        for (const l of labels) {
            if (l !== null) expect([1, 2, 3, 6, 7, 8]).toContain(Math.abs(l))
        }
        expect(labels.some((l) => l !== null)).toBe(true)
    })
})
