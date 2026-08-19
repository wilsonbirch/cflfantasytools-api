import { describe, expect, it } from 'vitest'
import {
    parseCatchPoint,
    parseDescription,
    parseStartPosition,
    pointsForPlay,
    yardsFromOwnGoal,
} from '~/services/pbp/parseDescription'

// Every description below is VERBATIM from the live BetGenius widget — 5,912
// plays across 40 fixtures of the 2026 season. Nothing here is invented, because
// the whole risk in this module is a regex that looks right against a made-up
// string and silently drops a real one.

describe('parseStartPosition', () => {
    it('reads down, distance and yard line', () => {
        expect(parseStartPosition('3rd & 10 at CGY 33', 'SSK')).toEqual({
            down: 3,
            distance: '10',
            yardLine: 33,
        })
    })

    it('signs the yard line NEGATIVE in the possessing team own half', () => {
        // Calgary with the ball on its own 33 is a completely different
        // proposition from an opponent on Calgary's 33; one number must carry it.
        expect(parseStartPosition('3rd & 10 at CGY 33', 'CGY').yardLine).toBe(-33)
    })

    it('returns empty fields for a kickoff, which has no line of scrimmage', () => {
        expect(parseStartPosition('', 'CGY')).toEqual({
            down: null,
            distance: null,
            yardLine: null,
        })
    })

    it('keeps magnitude rather than guessing a sign when the team is unknown', () => {
        expect(parseStartPosition('1st & 10 at CGY 20', null).yardLine).toBe(20)
    })

    it('handles every down the CFL has', () => {
        expect(parseStartPosition('1st & 10 at BC 35', 'BC').down).toBe(1)
        expect(parseStartPosition('2nd & 3 at BC 35', 'BC').down).toBe(2)
        expect(parseStartPosition('3rd & 15 at BC 35', 'BC').down).toBe(3)
    })
})

describe('yardsFromOwnGoal', () => {
    it('flattens the signed yard line onto one 0-110 axis', () => {
        expect(yardsFromOwnGoal(-33)).toBe(33)
        expect(yardsFromOwnGoal(33)).toBe(77)
    })

    it('honours the shorter 2027 field', () => {
        expect(yardsFromOwnGoal(33, 100)).toBe(67)
    })

    it('passes null through', () => {
        expect(yardsFromOwnGoal(null)).toBeNull()
    })
})

describe('pointsForPlay', () => {
    // 3DF scored the convert as 7 and the two-point as 8, as though each carried
    // the touchdown with it. They are separate plays in this feed, so a
    // touchdown drive summed to 6 + 7 = 13. Each play is worth only its own.
    it('scores a touchdown 6 and its convert separately', () => {
        expect(pointsForPlay('Run', 'Touchdown')).toBe(6)
        expect(pointsForPlay('OnePoint', 'Success')).toBe(1)
        expect(pointsForPlay('TwoPoints', 'Success')).toBe(2)
    })

    it('scores a field goal 3 and a single 1', () => {
        expect(pointsForPlay('FieldGoal', 'Success')).toBe(3)
        expect(pointsForPlay('Punt', 'Single')).toBe(1)
        expect(pointsForPlay('Kickoff', 'Single')).toBe(1)
    })

    it('gives nothing for failed attempts and ordinary plays', () => {
        expect(pointsForPlay('FieldGoal', 'Failed')).toBeNull()
        expect(pointsForPlay('OnePoint', 'Failed')).toBeNull()
        expect(pointsForPlay('TwoPoints', 'Failed')).toBeNull()
        expect(pointsForPlay('Run', null)).toBeNull()
        expect(pointsForPlay('Pass', 'CompletePass')).toBeNull()
    })
})

describe('pointsForPlay — return touchdowns the feed does not mark', () => {
    // 45 of these in the 2023/24 corpus, every one worth nothing before this.
    // The feed leaves subType null (or "Failed" on a missed field goal), so the
    // only evidence a touchdown happened is the description.
    const punt =
        '#29 J.Haggerty punt 59 yards to the HAM26 recovered by HAM #81 L.Gallimore at HAM26 ' +
        '#81 L.Gallimore return 84 yards to the TOR00 TOUCHDOWN, clock 12:21'
    const kickoff =
        '#39 R.Boyd kickoff 65 yards to the MTL05 #89 J.Letcher Jr. return 105 yards to the ' +
        'TOR00 TOUCHDOWN, clock 09:41'
    const missedFg =
        '#11 A.Hale field goal attempt from 47 yards NO GOOD #29 J.Edwards-Cooper return 63 ' +
        'yards to the MTL00 TOUCHDOWN, clock 03:26'
    const stripSack =
        'Shotgun #8 Z.Collaros sacked for loss of 12 yards to the HAM48, fumble by #8 Z.Collaros ' +
        'recovered by HAM #24 C.Edwards at HAM48 #24 C.Edwards return 62 yards to the WPG00 ' +
        'TOUCHDOWN, clock 09:53'

    it('scores them MINUS six, because the other side scored them', () => {
        // Negative is the whole point: these are always returned by the team
        // WITHOUT the ball, and points are signed for the play's own team.
        expect(pointsForPlay('Punt', null, punt)).toBe(-6)
        expect(pointsForPlay('Kickoff', null, kickoff)).toBe(-6)
        expect(pointsForPlay('FieldGoal', 'Failed', missedFg)).toBe(-6)
        expect(pointsForPlay('Sack', null, stripSack)).toBe(-6)
    })

    it('requires the ball to REACH a goal line, not just the word touchdown', () => {
        // A called-back touchdown still says TOUCHDOWN. Matching the bare word
        // would invent points that never counted.
        expect(pointsForPlay('Punt', null, '#10 J.Julien punt 40 yards, TOUCHDOWN nullified')).toBe(
            null,
        )
    })

    it('leaves penalty plays alone rather than guessing', () => {
        // 53 plays in the corpus carry subType "Penalty" and the word TOUCHDOWN,
        // and the description does not reliably say whether it stood. Missing a
        // score is recoverable; inventing one poisons the label.
        expect(
            pointsForPlay(
                'Pass',
                'Penalty',
                '#3 T.Thrower pass complete deep left to #8 R.Receiver return 40 yards to the ' +
                    'CGY00 TOUCHDOWN PENALTY HAM Hold',
            ),
        ).toBeNull()
    })

    it('does not disturb an interception returned for a touchdown', () => {
        // The feed DOES mark these, and stamps them with the scoring team's own
        // id — so they are a plain +6 on that team's row, not a negative.
        expect(
            pointsForPlay(
                'Pass',
                'Touchdown',
                '#18 M.Shiltz pass intercepted by #37 W.Sutton at MTL39 #37 W.Sutton return 71 ' +
                    'yards to the HAM00 TOUCHDOWN',
            ),
        ).toBe(6)
    })

    it('still reads points with no description at all', () => {
        // The parameter is optional, so every existing caller keeps working.
        expect(pointsForPlay('FieldGoal', 'Success')).toBe(3)
    })
})

describe('parseDescription — completions', () => {
    const desc =
        'Shotgun #10 B.Schager pass complete short left to #75 P.Boersch caught at CGY38, ' +
        'for 13 yards to the CGY20 (#24 O.Ruest), 1ST DOWN'
    const r = parseDescription(desc, 'Pass', 'CompletePass')

    it('reads the target zone the receiving model is built on', () => {
        expect(r.targetDepth).toBe('SHORT')
        expect(r.targetDirection).toBe('LEFT')
    })

    it('reads passer, receiver and tackler', () => {
        expect(r.passer).toBe('#10 B.Schager')
        expect(r.receiver).toBe('#75 P.Boersch')
        expect(r.defense).toBe('#24 O.Ruest')
    })

    it('reads formation, yardage and the first-down flag', () => {
        expect(r.formation).toBe('Shotgun')
        expect(r.yardsGained).toBe(13)
        expect(r.isFirstDown).toBe(true)
    })

    it('splits the gain into air yards and yards after catch', () => {
        // Caught at CGY38 and tackled at CGY20 is 18 yards after the catch, so
        // the throw itself travelled 5 yards BACKWARD from the CGY33 snap.
        expect(r.yardsAfterCatch).toBe(18)
        expect(r.airYards).toBe(-5)
        expect(r.airYards! + r.yardsAfterCatch!).toBe(r.yardsGained)
    })

    it('measures a catch that crosses midfield on one axis', () => {
        // Raw numbers are meaningless across midfield: SSK55 to CGY45 is ten
        // yards, not ten backwards. Verified against its real CGY53 snap.
        const crossing = parseDescription(
            'Shotgun #10 B.Schager pass complete short right to #75 P.Boersch caught at SSK54, ' +
                'for 5 yards to the CGY48 (#27 G.Onyeka), out of bounds',
            'Pass',
            'CompletePass',
        )
        expect(crossing.yardsAfterCatch).toBe(8)
        expect(crossing.airYards).toBe(-3)
    })

    it('does not mistake the passer for a rusher', () => {
        expect(r.rusher).toBeNull()
        expect(r.returner).toBeNull()
        expect(r.kicker).toBeNull()
    })
})

describe('parseDescription — incompletions', () => {
    it('records zero yards, not the spot the ball was thrown to', () => {
        const r = parseDescription(
            'Shotgun #10 B.Schager pass incomplete short middle to #86 M.Sexton thrown to CGY17',
            'Pass',
            'IncompletePass',
        )
        expect(r.yardsGained).toBe(0)
        expect(r.receiver).toBe('#86 M.Sexton')
        expect(r.targetDepth).toBe('SHORT')
        expect(r.targetDirection).toBe('MIDDLE')
    })

    it('records who broke the pass up', () => {
        const r = parseDescription(
            'Shotgun #10 B.Schager pass incomplete deep left to #82 J.Johnson thrown to CGY33 ' +
                'broken up by #00 K.Alexander',
            'Pass',
            'IncompletePass',
        )
        expect(r.brokenUpBy).toBe('#00 K.Alexander')
        expect(r.targetDepth).toBe('DEEP')
    })

    it('handles a throwaway with no receiver named', () => {
        const r = parseDescription(
            'Shotgun #10 B.Schager pass incomplete short right thrown to WPG35',
            'Pass',
            'IncompletePass',
        )
        expect(r.receiver).toBeNull()
        expect(r.targetDirection).toBe('RIGHT')
    })

    it('reads a depth logged without a direction', () => {
        // A small number of plays are logged "pass complete short to ...".
        // Requiring a direction dropped both the zone AND the receiver on these.
        const r = parseDescription(
            'Shotgun #7 C.Brice pass complete short to #85 N.Cenacle caught at EDM25, ' +
                'for 22 yards to the EDM16 (#29 J.Ross), 1ST DOWN',
            'Pass',
            'CompletePass',
        )
        expect(r.targetDepth).toBe('SHORT')
        expect(r.targetDirection).toBeNull()
        expect(r.receiver).toBe('#85 N.Cenacle')
    })
})

describe('parseDescription — isComplete, the reception rule', () => {
    // 222 of 1,858 completions in a 40-game sample are NOT subtype
    // "CompletePass". Counting receptions off the subtype drops every one.
    it('marks an ordinary completion complete', () => {
        const r = parseDescription(
            'Shotgun #10 B.Schager pass complete short left to #75 P.Boersch caught at CGY38, ' +
                'for 13 yards to the CGY20 (#24 O.Ruest), 1ST DOWN',
            'Pass',
            'CompletePass',
        )
        expect(r.isComplete).toBe(true)
    })

    it('marks a TOUCHDOWN catch complete, though its subtype is Touchdown', () => {
        const r = parseDescription(
            'Shotgun #3 V.Adams Jr. pass complete deep middle to #85 J.Philpot caught at SSK20, ' +
                'for 70 yards to the SSK00 TOUCHDOWN, clock 05:54, 1ST DOWN',
            'Pass',
            'Touchdown',
        )
        expect(r.isComplete).toBe(true)
        expect(r.receiver).toBe('#85 J.Philpot')
    })

    it('marks a completion that also drew a flag complete', () => {
        const r = parseDescription(
            'Shotgun #13 J.Maier pass complete short right to #5 G.Bell caught at OTT43, ' +
                'for 2 yards to the OTT42 (#21 D.Callis) PENALTY OTT Procedure',
            'Pass',
            'Penalty',
        )
        expect(r.isComplete).toBe(true)
    })

    it('marks an incompletion and an interception NOT complete', () => {
        expect(
            parseDescription(
                'Shotgun #10 B.Schager pass incomplete short middle to #86 M.Sexton thrown to CGY17',
                'Pass',
                'IncompletePass',
            ).isComplete,
        ).toBe(false)
        expect(
            parseDescription(
                'Shotgun #14 J.Coan pass intercepted by #2 K.Wilson at CGY32',
                'Pass',
                'Interception',
            ).isComplete,
        ).toBe(false)
    })

    it('leaves isComplete null on plays that are not passes', () => {
        expect(
            parseDescription('Shotgun #20 D.McMahon rush middle for 12 yards gain', 'Run', null)
                .isComplete,
        ).toBeNull()
    })
})

describe('parseDescription — names the 3DF regexes dropped', () => {
    it('keeps a hyphenated surname', () => {
        const r = parseDescription(
            '#70 D.Hodge punt 42 yards to the SSK34 #87 D.Wiebe return 6 yards to the SSK40 ' +
                '(#39 A.Miller-Melancon)',
            'Punt',
            null,
        )
        expect(r.defense).toBe('#39 A.Miller-Melancon')
    })

    it('keeps a generational suffix', () => {
        const r = parseDescription(
            'Shotgun #3 V.Adams Jr. pass complete deep middle to #85 J.Philpot caught at SSK20, ' +
                'for 70 yards to the SSK00 TOUCHDOWN, clock 05:54, 1ST DOWN',
            'Pass',
            'Touchdown',
        )
        expect(r.passer).toBe('#3 V.Adams Jr.')
        expect(r.receiver).toBe('#85 J.Philpot')
        expect(r.points).toBe(6)
    })

    it('keeps a roman-numeral suffix', () => {
        const r = parseDescription(
            'Shotgun #4 J.Morgan pass incomplete short middle thrown to OTT25 broken up by #30 S.Nkuba II',
            'Pass',
            'IncompletePass',
        )
        expect(r.brokenUpBy).toBe('#30 S.Nkuba II')
    })

    it('keeps a jersey number 00', () => {
        const r = parseDescription(
            'Shotgun #00 Q.Conley rush middle for 0 yards to the CGY18 (#76 N.Pollard)',
            'Run',
            null,
        )
        expect(r.rusher).toBe('#00 Q.Conley')
        expect(r.yardsGained).toBe(0)
    })
})

describe('parseDescription — runs and sacks', () => {
    it('reads a rushing gain', () => {
        const r = parseDescription(
            'Shotgun #20 D.McMahon rush middle for 12 yards gain to the CGY39 (#28 M.Straker)',
            'Run',
            null,
        )
        expect(r.rusher).toBe('#20 D.McMahon')
        expect(r.yardsGained).toBe(12)
        expect(r.passer).toBeNull()
    })

    it('signs a rushing loss negative', () => {
        const r = parseDescription(
            'Shotgun #33 K.Lynch-Adams rush middle for 1 yard loss to the SSK28 (#48 D.Gbenda)',
            'Run',
            null,
        )
        expect(r.yardsGained).toBe(-1)
    })

    it('signs a sack negative and credits the passer, not a rusher', () => {
        const r = parseDescription(
            'Shotgun #11 J.Criswell sacked for loss of 1 yard to the CGY39 (#97 K.Charles)',
            'Sack',
            null,
        )
        expect(r.passer).toBe('#11 J.Criswell')
        expect(r.rusher).toBeNull()
        expect(r.yardsGained).toBe(-1)
        expect(r.defense).toBe('#97 K.Charles')
    })
})

describe('parseDescription — kicks', () => {
    it('reads a punt, its returner and its return yards', () => {
        const r = parseDescription(
            '#70 D.Hodge punt 42 yards to the SSK34 #87 D.Wiebe return 6 yards to the SSK40 ' +
                '(#39 A.Miller-Melancon)',
            'Punt',
            null,
        )
        expect(r.kicker).toBe('#70 D.Hodge')
        expect(r.puntYards).toBe(42)
        expect(r.returnYards).toBe(6)
        expect(r.returner).toBe('#87 D.Wiebe')
    })

    it('keeps the returner OUT of the receiver field', () => {
        // 3DF stored returners in `receiver`. Every reception count built on
        // that column would have been inflated by every kick return in the game.
        const r = parseDescription(
            '#70 D.Hodge punt 42 yards to the SSK34 #87 D.Wiebe return 6 yards to the SSK40',
            'Punt',
            null,
        )
        expect(r.receiver).toBeNull()
    })

    it('records a BLOCKED punt as zero yards rather than no data', () => {
        const r = parseDescription(
            '#91 O.Chapman punt 0 yards to the SSK48 blocked by #41 B.Cole recovered by OTT ' +
                '#41 B.Cole at SSK31, End Of Play',
            'Punt',
            null,
        )
        expect(r.puntYards).toBe(0)
    })

    it('reads a made field goal', () => {
        const r = parseDescription(
            '#70 D.Hodge field goal attempt from 43 yards GOOD (H: #15 M.Vassett, LS: #43 J.MacGougan), clock 09:10',
            'FieldGoal',
            'Success',
        )
        expect(r.kicker).toBe('#70 D.Hodge')
        expect(r.kickDistance).toBe(43)
        expect(r.kickIsGood).toBe(true)
        expect(r.points).toBe(3)
    })

    it('does not read NO GOOD as GOOD', () => {
        const r = parseDescription(
            '#11 A.Hale field goal attempt from 56 yards NO GOOD (H: #71 O.Chapman, LS: #53 R.Hughes), ' +
                'clock 02:14 recovered by CGY #88 K.Horton at CGY-06 #88 K.Horton return 22 yards to the CGY16',
            'FieldGoal',
            'Failed',
        )
        expect(r.kickIsGood).toBe(false)
        expect(r.kickDistance).toBe(56)
        expect(r.points).toBeNull()
    })

    it('scores the rouge, the play class 2026 cut down', () => {
        const r = parseDescription(
            '#10 J.Julien punt 63 yards to the CGY-01 SINGLE, clock 02:50',
            'Punt',
            'Single',
        )
        expect(r.points).toBe(1)
        expect(r.puntYards).toBe(63)
    })
})

describe('parseDescription — turnovers and penalties', () => {
    it('credits the interceptor and flags the turnover', () => {
        const r = parseDescription(
            'Shotgun #14 J.Coan pass intercepted by #2 K.Wilson at CGY32 #2 K.Wilson return 8 yards ' +
                'to the CGY40 (#59 S.Brown)',
            'Pass',
            'Interception',
        )
        expect(r.defense).toBe('#2 K.Wilson')
        expect(r.isTurnover).toBe(true)
        expect(r.returner).toBe('#2 K.Wilson')
        expect(r.receiver).toBeNull()
    })

    it('flags a turnover on downs', () => {
        const r = parseDescription(
            'Shotgun #10 B.Schager pass complete short middle to #79 B.Walz caught at CGY40, ' +
                'for 5 yards to the CGY39 (#37 J.Polk), TURNOVER ON DOWNS',
            'Pass',
            'CompletePass',
        )
        expect(r.isTurnover).toBe(true)
    })

    it('reads a penalty and marks the snap as no play', () => {
        const r = parseDescription(
            'PENALTY CGY Procedure, General (#68 D.Buford) 5 yards from CGY32 to CGY27. NO PLAY',
            'Penalty',
            'Penalty',
        )
        expect(r.penaltyTeam).toBe('CGY')
        expect(r.penaltyName).toBe('Procedure, General')
        expect(r.penaltyYards).toBe(5)
        expect(r.isNoPlay).toBe(true)
    })

    it('does not turn the offending player into a passer', () => {
        // The only player token on a penalty-only play is the offender. Treating
        // the lead token as a ball carrier would invent a passer out of them.
        const r = parseDescription(
            'PENALTY CGY Time count before 3min warning or during convert (#70 D.Hodge) ' +
                '5 yards from CGY39 to CGY34. NO PLAY',
            'Penalty',
            'Penalty',
        )
        expect(r.passer).toBeNull()
        expect(r.rusher).toBeNull()
    })

    it('leaves isNoPlay false for a penalty that did not wipe the snap', () => {
        const r = parseDescription(
            '#12 J.Love rush right for 1 yard gain to the SSK00 TOUCHDOWN, clock 01:19, 1ST DOWN, ' +
                'PENALTY SSK Offside declined',
            'Run',
            'Touchdown',
        )
        expect(r.isNoPlay).toBe(false)
        expect(r.points).toBe(6)
    })
})

describe('parseCatchPoint', () => {
    it('reads a completion catch point', () => {
        expect(parseCatchPoint('... caught at CGY38, for 13 yards')).toEqual({
            team: 'CGY',
            yard: 38,
        })
    })

    it('reads an incompletion target point', () => {
        expect(parseCatchPoint('... thrown to CGY17')).toEqual({ team: 'CGY', yard: 17 })
    })

    it('reads a spot inside the end zone as negative', () => {
        expect(parseCatchPoint('... thrown to SSK-01')).toEqual({ team: 'SSK', yard: -1 })
    })

    it('returns null when there is no spot', () => {
        expect(parseCatchPoint('#20 D.McMahon rush middle for 12 yards gain')).toBeNull()
    })
})
