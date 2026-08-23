import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseChartText } from '~/services/depthCharts/parseChart'

// `pdftotext -layout` output of every club's real chart for the week of
// 2026-08-20/23, captured with test/fixtures/depth-charts/pdf/*.pdf. The
// expectations below were read off the PDFs by eye: the starting five in
// Wilson's vocabulary, numbers counting OUTSIDE-IN, S = field, WK = boundary.
const text = (club: string) =>
    readFileSync(`test/fixtures/depth-charts/pdf/${club}-2026-08.txt`, 'utf8')

const starters = (club: string): Record<string, string> => {
    const r = parseChartText(text(club))
    if (r.status !== 'OK') throw new Error(`${club}: ${r.reason}`)
    return Object.fromEntries(
        r.positions
            .filter((p) => p.depth === 1)
            .map((p) => [p.position, `${p.jersey} ${p.player}`]),
    )
}

describe('parseChartText — every club, real charts', () => {
    it('Calgary (Weak/Boundary left, Strong/Field right)', () => {
        expect(starters('CGY')).toEqual({
            '1WK': '4 JONES',
            '2WK': '85 PHILPOT',
            '1S': '14 BARNES',
            '2S': '87 BROOKS',
            '3S': '17 BRISSETT',
        })
    })

    it('Saskatchewan stacks an SB under the WR at the same width: the WR row is outside', () => {
        expect(starters('SSK')).toEqual({
            '1WK': '80 DJETE',
            '2WK': '3 K. JOHNSON',
            '1S': '18 DUNCAN-BUSBY',
            '2S': '19 EMILUS',
            '3S': '88 JOHNSON III',
        })
    })

    it('BC (Boundary / Field, "5 51 COUTURE" double numbers on the line)', () => {
        expect(starters('BC')).toEqual({
            '1WK': '4 HATCHER',
            '2WK': '84 JACKSON',
            '1S': '86 COTTOY',
            '2S': '18 MCINNIS',
            '3S': '83 BERRYHILL',
        })
    })

    it('Edmonton ("41 | REID*" separators, an R slot and [bracketed] names)', () => {
        expect(starters('EDM')).toEqual({
            '1WK': '3 MACK',
            '2WK': '18 CEPHUS',
            '1S': '11 JULIEN-GRANT',
            '2S': '88 LUTHER',
            '3S': "6 O'LEARY-ORANGE",
        })
    })

    it('Winnipeg (a TE slot that is not a receiver; outside SB drawn wider than the WR)', () => {
        expect(starters('WPG')).toEqual({
            '1WK': '80 WILSON',
            '2WK': '12 WHITE',
            '1S': '82 COBB',
            '2S': '83 NIELD',
            '3S': '10 DEMSKI',
        })
    })

    it('Hamilton ("89- LAWLER" dashes; the WR label two rows up sits closer than the SB)', () => {
        expect(starters('HAM')).toEqual({
            '1WK': '89 LAWLER',
            '2WK': '85 SMITH',
            '1S': '8 WHEATFALL',
            '2S': '7 MITCHELL',
            '3S': '14 GITTENS JR',
        })
    })

    it('Toronto (a third SB labelled on its own row)', () => {
        expect(starters('TOR')).toEqual({
            '1WK': '86 COXIE',
            '2WK': '82 KAHMANN',
            '1S': '83 UNGERER III',
            '2S': '87 HERSLOW',
            '3S': '10 MITAL',
        })
    })

    it('Ottawa (a one-letter nationality column beside every name)', () => {
        expect(starters('OTT')).toEqual({
            '1WK': '85 MCDONALD',
            '2WK': '2 HARDY',
            '1S': '83 PIMPLETON',
            '2S': '7 EBERHARDT',
            '3S': '81 WHITE',
        })
    })

    it('Montreal (bilingual: REC for every slot, Court / Boundary, Large / Field)', () => {
        expect(starters('MTL')).toEqual({
            '1WK': '15 HOLLINS',
            '2WK': '85 SNEAD',
            '1S': '6 PHILPOT',
            '2S': '17 SPIEKER',
            '3S': '88 DUBOIS',
        })
    })

    it('reads depth from the order under a slot', () => {
        const r = parseChartText(text('CGY'))
        if (r.status !== 'OK') throw new Error(r.reason)
        const wk2 = r.positions.filter((p) => p.position === '2WK').map((p) => [p.depth, p.player])
        expect(wk2).toEqual([
            [1, 'PHILPOT'],
            [2, 'AJOU'],
        ])
    })

    it('never puts a lineman, back or quarterback in a receiver slot', () => {
        for (const club of ['SSK', 'BC', 'CGY', 'EDM', 'WPG', 'HAM', 'TOR', 'OTT', 'MTL']) {
            const r = parseChartText(text(club))
            if (r.status !== 'OK') throw new Error(`${club}: ${r.reason}`)
            const names = r.positions.map((p) => p.player)
            for (const notAReceiver of [
                'COLLAROS',
                'ROURKE',
                'ADAMS',
                'HARRIS',
                'OLIVEIRA',
                'FERLAND',
                'DANIELS',
                'FORD',
                'MAIER',
                'ALEXANDER',
            ]) {
                expect(names, `${club} ${notAReceiver}`).not.toContain(notAReceiver)
            }
            // Exactly five starting slots, two on the boundary and three on the field.
            expect(
                r.positions
                    .filter((p) => p.depth === 1)
                    .map((p) => p.position)
                    .sort(),
                club,
            ).toEqual(['1S', '1WK', '2S', '2WK', '3S'])
        }
    })

    it('reports a page without a diagram as unsupported rather than inventing one', () => {
        expect(parseChartText('TORONTO ARGONAUTS\nNo. Name Pos\n1 SMITH WR\n')).toEqual({
            status: 'FAILED',
            reason: expect.stringMatching(/no offensive line row/),
        })
    })

    it('honours a diagram drawn with the boundary on the right', () => {
        // Calgary's chart mirrored: swap the side labels and the starters flip.
        const mirrored = text('CGY').replace(
            /Weak\/Boundary(\s+)Strong\/Field/,
            'Strong/Field$1Weak/Boundary',
        )
        const r = parseChartText(mirrored)
        if (r.status !== 'OK') throw new Error(r.reason)
        expect(r.weakSide).toBe('right')
        const one = r.positions.find((p) => p.position === '1S' && p.depth === 1)
        expect(one?.player).toBe('JONES')
    })
})
