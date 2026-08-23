// Receiver alignment from a depth-chart PDF's `pdftotext -layout` text. PURE.
//
// Every club publishes the same thing: a field diagram, offence drawn under the
// defence, receivers spread across the width of the page with the line of
// scrimmage (LT LG C RG RT) in the middle. The text layout keeps the columns,
// so a name's horizontal position IS its alignment. That is exactly the axis
// Wilson's vocabulary is built on (see docs/memory/project-receiver-position-
// taxonomy.md): numbers count OUTSIDE-IN, S = strong/field side, WK =
// weak/boundary side, and the side is read off the diagram's own labels.
//
// Nine clubs, one parser. The clubs differ in label spelling (WR/REC/R for a
// receiver slot, "BL / OT" for a tackle), name decoration ("41 | REID*",
// "29- NITYCHORUK", "[ 0 | WILLIAMS* DA ]", "9 MATTHEW - DA   A") and which
// side of the page is the boundary — and in nothing structural.

export type ParsedPosition = {
    /** 1S, 2S, 3S, 1WK, 2WK, ... */
    position: string
    player: string
    jersey: number | null
    /** 1 = starter. */
    depth: number
}

export type ParseResult =
    | { status: 'OK'; positions: ParsedPosition[]; weakSide: 'left' | 'right' }
    | { status: 'FAILED'; reason: string }

type Token = { text: string; start: number; end: number }

/** Split a layout line into tokens separated by two or more spaces. */
function tokenize(line: string): Token[] {
    const tokens: Token[] = []
    const re = /\S+(?: \S+)*/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
        tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length })
    }
    return tokens
}

const center = (t: Token): number => (t.start + t.end) / 2

// Label tokens as the clubs print them. A receiver slot is WR, SB, REC or R.
// Every OTHER short all-caps label (QB, RB, FB, TE, "QA / QB", C, LT, ...) is
// kept as a column too, so a name under it is claimed by it and never drifts
// into a neighbouring receiver slot: TE/FB/RB are not receivers in this
// vocabulary.
const RECEIVER_LABEL = /^(WR|SB|REC|R)$/
// Two or three letters (or the lone C): Ottawa prints a one-letter nationality
// column beside every name, which must not read as a label.
const OTHER_LABEL = /^(?:[A-Z]{2,3}(?:\s*\/\s*[A-Z]{1,3})?|C)$/
const CENTRE_LABEL = /^C$/
const STOP_LABEL = /^(K|P|K\/P|P\/K|LS|KR|PR|KR\s*\/\s*PR|BP \/ K|BD \/ P|SLR \/ LS|RET)$/

// "85 MCDONALD", "41 | REID*", "29- NITYCHORUK", "5 51 COUTURE" (a second
// number printed for an OL replacement), "3 K. JOHNSON*", "91 - A.-BERGLUND".
const PLAYER =
    /^(?:\d{1,2}\s+)?(\d{1,2})\s*[-|]?\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'.]*(?:[ -][A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'.]*)*)/

function parsePlayer(raw: string): { jersey: number; name: string } | null {
    const text = raw.replace(/[[\]{}<>]/g, ' ').trim()
    const m = text.match(PLAYER)
    if (!m) return null
    // Trailing nationality / status letters the clubs append: "MATTHEW - DA",
    // "MORGAN (GTD)", OTT's lone "A"/"N"/"G" column is its own token already.
    const name = m[2]
        .replace(/\s+(DA|GTD|A|N|G)$/, '')
        .replace(/\s+$/, '')
        .trim()
    if (!name) return null
    return { jersey: Number(m[1]), name }
}

type Column = { x: number; row: number; label: string; receiver: boolean }

/**
 * Parse page text (first page is enough; roster pages follow) into positions.
 */
export function parseChartText(text: string): ParseResult {
    const lines = text.split('\n')

    // Which side of the page is the boundary. Every club prints it on the
    // defensive half of the diagram; default to boundary-left, which all nine
    // do today, if the line is ever dropped.
    let weakSide: 'left' | 'right' = 'left'
    for (const line of lines) {
        const weak = line.search(/weak|boundary|court/i)
        const strong = line.search(/strong|field|large/i)
        if (weak >= 0 && strong >= 0) {
            weakSide = weak < strong ? 'left' : 'right'
            break
        }
    }

    // The offensive line row: a lone "C" with receiver labels either side of it.
    let olRow = -1
    let midline = 0
    for (let i = 0; i < lines.length; i++) {
        const tokens = tokenize(lines[i])
        const c = tokens.find((t) => CENTRE_LABEL.test(t.text))
        const receivers = tokens.filter((t) => RECEIVER_LABEL.test(t.text))
        if (c && receivers.length >= 2) {
            olRow = i
            midline = center(c)
            break
        }
    }
    if (olRow < 0) return { status: 'FAILED', reason: 'no offensive line row (C with WR/REC)' }

    // From the OL row down to the kickers: every label is a column on its row,
    // every "NN NAME" token is a name. A name belongs to the nearest column of
    // the nearest label row at or above it — rows are searched newest first, so
    // a name printed under the SB row is an SB even when a WR label two rows up
    // happens to sit closer horizontally (Hamilton's right side does exactly
    // that).
    const columns: Column[] = []
    const names: { line: number; x: number; jersey: number; name: string }[] = []
    for (let i = olRow; i < lines.length; i++) {
        const tokens = tokenize(lines[i])
        if (/ROSTER|NUMERICAL|ALPHABETICAL/i.test(lines[i])) break
        if (tokens.some((t) => STOP_LABEL.test(t.text))) break
        for (const t of tokens) {
            if (RECEIVER_LABEL.test(t.text)) {
                columns.push({ x: center(t), row: i, label: t.text, receiver: true })
            } else if (OTHER_LABEL.test(t.text)) {
                columns.push({ x: center(t), row: i, label: t.text, receiver: false })
            } else {
                const p = parsePlayer(t.text)
                if (p) names.push({ line: i, x: center(t), ...p })
            }
        }
    }
    const receiverColumns = columns.filter((c) => c.receiver)
    if (receiverColumns.length < 3) {
        return { status: 'FAILED', reason: `only ${receiverColumns.length} receiver column(s)` }
    }

    const TOLERANCE = 12
    const assign = (n: { line: number; x: number }): Column | null => {
        const rows = [...new Set(columns.filter((c) => c.row <= n.line).map((c) => c.row))].sort(
            (a, b) => b - a,
        )
        for (const row of rows) {
            let best: Column | null = null
            for (const c of columns) {
                if (c.row !== row) continue
                if (best === null || Math.abs(c.x - n.x) < Math.abs(best.x - n.x)) best = c
            }
            if (best && Math.abs(best.x - n.x) <= TOLERANCE) return best
        }
        return null
    }

    // Side and rank per receiver column: distance from the centre, outside in.
    // Two slots at (nearly) the same width keep the diagram's top-down order —
    // Saskatchewan stacks an SB label directly under the WR, Winnipeg draws its
    // outside SB four characters wider than the WR — so the WR row is the outside.
    // ponytail: a 6-character tie window is a layout heuristic, not geometry;
    // widen or make it per-club if a chart ever draws a slot deliberately inside
    // by that little.
    const SAME_WIDTH = 6
    const side = (c: Column): 'left' | 'right' => (c.x < midline ? 'left' : 'right')
    const width = (c: Column): number => Math.abs(c.x - midline)
    const ranked = new Map<Column, string>()
    for (const s of ['left', 'right'] as const) {
        const cols = receiverColumns
            .filter((c) => side(c) === s)
            .sort((a, b) =>
                Math.abs(width(a) - width(b)) <= SAME_WIDTH ? a.row - b.row : width(b) - width(a),
            )
        const suffix = s === weakSide ? 'WK' : 'S'
        cols.forEach((c, i) => ranked.set(c, `${i + 1}${suffix}`))
    }

    const depthByColumn = new Map<Column, number>()
    const positions: ParsedPosition[] = []
    for (const n of names) {
        const col = assign(n)
        if (!col || !col.receiver) continue
        const depth = (depthByColumn.get(col) ?? 0) + 1
        depthByColumn.set(col, depth)
        if (depth > 3) continue
        positions.push({ position: ranked.get(col)!, player: n.name, jersey: n.jersey, depth })
    }
    if (positions.length === 0) return { status: 'FAILED', reason: 'no receivers found' }
    return { status: 'OK', positions, weakSide }
}
