import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { chronological, driveOutcome, groupIntoDrives, type RawPlay } from '~/services/pbp/drives'
import { pointsForPlay } from '~/services/pbp/parseDescription'
import { repairLegacyPlays } from '~/services/pbp/legacyRepair'

// Every row below is real: lifted verbatim from the 2023 legacy payloads.
const snippets = JSON.parse(
    readFileSync('test/fixtures/pbp/legacy-snippets.json', 'utf8'),
) as Record<string, RawPlay[]>
const rows = (name: string): RawPlay[] => chronological(snippets[name])
const ids = (plays: RawPlay[]) => plays.map((p) => p.id)

const OTT = '88019'
const WPG = '110380'
const MTL = '86680'
const CGY = '112939'

describe('repairLegacyPlays: ghost copies', () => {
    it('drops the copy of the next drive left on the end of this one, stamped with the wrong team', () => {
        // OTT–WPG 2023 (9889304). Drive 2 is Ottawa's three-and-out — then 2-4..2-7
        // repeat Winnipeg's 3-4..3-7 under Ottawa's id: Zach Collaros completing
        // passes for Ottawa, and a Winnipeg field goal scored for Ottawa.
        const raw = rows('ghostRunWrongTeam_9889304')
        const ghost = raw.find((p) => p.id === '2-4')
        expect(ghost?.teamId).toBe(OTT)
        expect(ghost?.description).toContain('Z.Collaros')

        const { plays, dropped, summary } = repairLegacyPlays(raw)

        expect(ids(dropped).sort()).toEqual(
            ['2-4', '2-5', '2-6', '2-7', '4-4', '4-5', '4-6', '4-7', '4-8', '4-9', '4-10'].sort(),
        )
        expect(summary.duplicatesDropped).toBe(11)

        // Drive 4 hid a whole Winnipeg touchdown (4-9) inside an Ottawa drive.
        const drives = groupIntoDrives(plays)
        expect(drives.map((d) => [d.number, d.geniusTeamId, d.plays.length])).toEqual([
            [2, OTT, 3],
            [3, WPG, 7],
            [4, OTT, 3],
            [5, WPG, 10],
        ])
        // No Collaros play survives under Ottawa's id.
        expect(plays.filter((p) => p.teamId === OTT && p.description.includes('Collaros'))).toEqual(
            [],
        )
    })

    it('reads the team from the named player when the clock cannot decide', () => {
        // MTL–TOR 2023 (9889303). The whole stretch has no clock, and 22-5..22-10
        // repeat Montreal's 23-5..23-10 — a Fajardo touchdown drive — under
        // Toronto's id. The earlier copy is the ghost here; only Fajardo's other
        // plays for Montreal say so.
        const { dropped } = repairLegacyPlays(rows('ghostRunNoClock_9889303'))
        expect(ids(dropped)).toEqual(['22-5', '22-6', '22-7', '22-8', '22-9', '22-10'])
        expect(dropped.find((p) => p.subType === 'Touchdown')?.teamId).not.toBe(MTL)
    })

    it('reads the game clock when both copies carry the same team', () => {
        // BC–CGY 2023 (9888992). Calgary's touchdown drive appears as 14-2..14-7
        // AND 15-2..15-7, both under Calgary. Drive 15 opens with the kickoff
        // that FOLLOWED the touchdown (11:03), so its copies sit out of time.
        const { plays, dropped } = repairLegacyPlays(rows('ghostSameTeam_9888992'))
        expect(ids(dropped)).toEqual(['15-2', '15-3', '15-4', '15-5', '15-6', '15-7'])
        const drives = groupIntoDrives(plays)
        expect(drives.find((d) => d.number === 14)?.plays).toHaveLength(7)
        expect(ids(drives.find((d) => d.number === 15)?.plays ?? [])).toEqual(['15-1'])
    })

    it('keeps the copy that sits in time even when the ghost is the older row', () => {
        // Same game: Calgary's 36-yard field goal is 24-6 and again 25-6, the
        // second copy under BC's id after BC's own punt at 4:51. Here the GHOST
        // has the older timestamp, which is why timestamps cannot decide.
        const raw = rows('ghostFieldGoalWrongTeam_9888992')
        const [a, b] = raw.filter((p) => p.type === 'FieldGoal')
        expect([a.teamId, b.teamId]).toEqual([CGY, '93775'])
        expect(b.timestamp).toBeLessThan(a.timestamp)

        const { plays, dropped } = repairLegacyPlays(raw)
        expect(ids(dropped)).toEqual(['25-6'])
        expect(plays.find((p) => p.type === 'FieldGoal')?.teamId).toBe(CGY)
    })

    it('drops a field goal keyed twice in a row', () => {
        // WPG–HAM 2023 (9889284): one 32-yard kick, two rows, six points.
        const raw = rows('fieldGoalKeyedTwice_9889284')
        const score = (ps: RawPlay[]) =>
            ps.reduce((n, p) => n + (pointsForPlay(p.type, p.subType, p.description) ?? 0), 0)
        expect(score(raw.filter((p) => p.type === 'FieldGoal'))).toBe(6)

        const { plays, dropped } = repairLegacyPlays(raw)
        expect(dropped).toHaveLength(1)
        expect(score(plays.filter((p) => p.type === 'FieldGoal'))).toBe(3)
    })

    it('keeps identical rows that are drives apart: two real converts by one kicker', () => {
        // OTT 2023 (9888991): two converts, no clock on either, identical text.
        const raw = rows('convertsFarApart_9888991')
        expect(raw[0].description).toBe(raw[1].description)
        const { plays, summary } = repairLegacyPlays(raw)
        expect(plays).toHaveLength(2)
        expect(summary.duplicatesDropped).toBe(0)
    })

    it('never merges overtime possessions, which can match on every field', () => {
        // CGY–MTL 2024 (10798074), 19–19: consecutive overtime possessions each
        // end in a 42-yard Paredes field goal, 3rd & 10 at the MTL 35, clock
        // 00:00. Two real kicks; merging them took the game off its final.
        const raw = rows('overtimeFieldGoals_10798074')
        const kicks = raw.filter((p) => p.description.includes('from 42 yards GOOD'))
        expect(ids(kicks)).toEqual(['26-3', '27-4'])
        expect(kicks[0].description).toBe(kicks[1].description)

        const { plays, dropped } = repairLegacyPlays(raw)
        expect(dropped).toEqual([])
        expect(plays).toHaveLength(raw.length)
    })
})

describe('repairLegacyPlays: copies the clock cannot separate', () => {
    it('keeps the convert after the kept touchdown, not the one after its ghost', () => {
        // EDM 2023 (9889302). 32-2..32-9 repeat Edmonton's touchdown drive after
        // the onside kick at 00:57; the convert is at 00:57 too, so both copies
        // of it sit in time. The touchdown's ghost (32-8) is out of time and
        // dropped, and the convert goes with the touchdown it follows.
        const { dropped } = repairLegacyPlays(rows('convertTie_9889302'))
        expect(ids(dropped)).toEqual([
            '32-2',
            '32-3',
            '32-4',
            '32-5',
            '32-6',
            '32-7',
            '32-8',
            '32-9',
        ])
    })

    it('does the same when only the touchdown and its convert are copied', () => {
        // BC–CGY 2023 (9889320): 16-2/16-3 repeat 15-2/15-3 behind the kickoff.
        const { dropped } = repairLegacyPlays(rows('convertTie_9889320'))
        expect(ids(dropped)).toEqual(['16-2', '16-3'])
    })

    it('keeps the convert after a pick-six in the drive of the side that threw it', () => {
        // CGY–WPG 2023 (9889323). Winnipeg kicks a field goal (21-7), then Houston
        // returns an interception for a touchdown (22-1, in Calgary's drive) and
        // Castillo converts: 22-2, stamped Winnipeg, in CALGARY's drive — the feed
        // files a defensive score's convert there. 21-8 is its ghost, left on the
        // end of Winnipeg's field-goal drive. Its team matching its drive's owner
        // proves nothing: preferring that kept the ghost.
        const { plays, dropped } = repairLegacyPlays(rows('pickSixConvert_9889323'))
        expect(ids(dropped)).toEqual(['21-8'])

        // So the labels: Winnipeg's drive scored its field goal and nothing more;
        // Calgary's drive conceded the pick-six and its convert.
        const teamOf = (id: string) =>
            ({
                [WPG]: { abbreviation: 'WPG', name: 'Winnipeg' },
                [CGY]: { abbreviation: 'CGY', name: 'Calgary' },
            })[id]
        const outcome = (n: number) =>
            driveOutcome(
                groupIntoDrives(plays).find((d) => d.number === n)!,
                teamOf,
            ).points
        expect(outcome(21)).toBe(3)
        expect(outcome(22)).toBe(-7)
    })

    it('puts the end of the second quarter before the start of the third', () => {
        // BC 2023 (9888992): a Q2 00:00 run repeated as 13-2, after the Q3
        // opening kickoff at 15:00. Read as the same instant, the ghost won.
        const { dropped } = repairLegacyPlays(rows('quarterBoundary_9888992'))
        expect(ids(dropped)).toEqual(['13-2'])
    })
})

describe('repairLegacyPlays: subtypes the play text contradicts', () => {
    const one = (name: string) => {
        const { plays } = repairLegacyPlays(rows(name))
        expect(plays).toHaveLength(1)
        return { before: rows(name)[0], after: plays[0] }
    }
    const points = (p: RawPlay) => pointsForPlay(p.type, p.subType, p.description)

    it('clears a Touchdown subtype on a play that gained two yards', () => {
        // EDM at BC 2023 (9889289): "rush middle for 2 yards gain to the BC52",
        // subtype Touchdown. Edmonton was shut out 22–0.
        const { before, after } = one('touchdownWithoutTouchdown_9889289')
        expect(points(before)).toBe(6)
        expect(after.subType).toBeNull()
        expect(after.isScoring).toBe(false)
        expect(points(after)).toBeNull()
    })

    it('gives a cleared pass the subtype the feed would have given it', () => {
        // WPG–HAM 2023 (9889284): a 3-yard completion carried as a Touchdown. A
        // Pass with no subtype is a combination the feed never produces.
        const { before, after } = one('passTouchdownWithoutTouchdown_9889284')
        expect(before.subType).toBe('Touchdown')
        expect(after.subType).toBe('CompletePass')
        expect(points(after)).toBeNull()
    })

    it('leaves a real touchdown alone when its text just lacks a goal-line spot', () => {
        // "to the CGY00, End Of Play TOUCHDOWN" — real, scored, and kept.
        const { before, after } = one('realTouchdownNoGoalLine_9889305')
        expect(after).toBe(before)
    })

    it('stops scoring a field goal that was nullified by penalty', () => {
        const { before, after } = one('fieldGoalNullified_9888990')
        expect(points(before)).toBe(3)
        expect(points(after)).toBeNull()
    })

    it('stops scoring a field goal row that is a NO PLAY penalty', () => {
        const { before, after } = one('fieldGoalNoPlay_9889316')
        expect(before.description).toMatch(/^PENALTY .* NO PLAY$/)
        expect(points(before)).toBe(3)
        expect(points(after)).toBeNull()
    })

    it('stops scoring a missed-field-goal return touchdown that was nullified', () => {
        const { before, after } = one('missedFieldGoalReturnNullified_9889298')
        expect(points(before)).toBe(-6)
        expect(points(after)).toBeNull()
    })

    it('scores the single conceded on a missed field goal', () => {
        // "NO GOOD ... End Of Play SINGLE" arrives as Failed and scored nothing.
        const { before, after } = one('missedFieldGoalSingle_9889298')
        expect(points(before)).toBeNull()
        expect(after.subType).toBe('Single')
        expect(points(after)).toBe(1)
    })
})

describe('repairLegacyPlays: a ghost the duplicate test cannot see', () => {
    it('does not score a missed-field-goal single for a side that was not kicking', () => {
        // OTT–MTL 2023 (9889353): Maltos's miss for Montreal is 1-9, and again
        // 2-6 under Ottawa's id with the return yardage edited (0 yards, not
        // 4), so it is not a duplicate. Both say SINGLE; only Montreal's counts.
        // Maltos's later kicks in the same game are in, as in the full payload:
        // they are what says which side he kicks for.
        const { plays } = repairLegacyPlays(
            chronological([
                ...snippets['ghostMissedFieldGoal_9889353'],
                ...snippets['strayConvert_9889353'],
            ]),
        )
        const kick = (id: string) => plays.find((p) => p.id === id)
        expect(kick('1-9')?.subType).toBe('Single')
        expect(kick('1-9')?.teamId).toBe(MTL)
        expect(kick('2-6')?.subType).toBe('Failed')
        expect(kick('2-6')?.teamId).toBe(OTT)
    })
})

describe('repairLegacyPlays: a clean payload', () => {
    it.each(['widget-payload.json', 'widget-payload-13419716.json'])(
        'changes nothing in the 2026 fixture %s',
        (file) => {
            const payload = JSON.parse(readFileSync(`test/fixtures/pbp/${file}`, 'utf8')) as {
                data: { playByPlayInfo: { ALL: RawPlay[] } }
            }
            const raw = chronological(payload.data.playByPlayInfo.ALL)
            const { plays, dropped, summary } = repairLegacyPlays(raw)
            expect(dropped).toEqual([])
            expect(Object.values(summary).every((n) => n === 0)).toBe(true)
            // Same rows, same objects — not merely equal copies.
            expect(plays).toHaveLength(raw.length)
            plays.forEach((p, i) => expect(p).toBe(raw[i]))
        },
    )

    it('does not mutate its input', () => {
        const raw = rows('touchdownWithoutTouchdown_9889289')
        const snapshot = structuredClone(raw)
        repairLegacyPlays(raw)
        expect(raw).toEqual(snapshot)
    })
})
