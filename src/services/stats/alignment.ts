// Matching play-text names ("#85 J.Philpot") to depth-chart slots. PURE.

export type ChartSlot = { position: string; player: string; jersey: number | null; depth: number }

const letters = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '')

/** "#85 J.Philpot" -> { jersey: 85, surname: "philpot" }; "V.Adams Jr." keeps the suffix. */
export function splitPlayText(player: string): { jersey: number | null; surname: string } {
    const m = player.match(/^#?(\d{1,2})\s+(.*)$/)
    const name = m ? m[2] : player
    const jersey = m ? Number(m[1]) : null
    // Drop the first initial(s): "J.Philpot", "K. Johnson", "A.J.Ouellette".
    const surname = name.replace(/^(?:[A-Za-z]\.\s*)+/, '')
    return { jersey, surname: letters(surname) }
}

/** Chart names print a lone initial for duplicates: "K. JOHNSON" -> "johnson". */
const chartSurname = (player: string): string => letters(player.replace(/^(?:[A-Za-z]\.\s*)+/, ''))

/**
 * The slot a play-text name occupies on a chart, or null.
 *
 * Jersey number is the primary key — it is unique on a club in a given week —
 * and the surname guards against a stale chart: the two must be compatible
 * (one a prefix of the other, so "Adams Jr." matches "ADAMS" and "Letcher Jr"
 * matches "LETCHER JR"). When the surname disagrees but the jersey is worn by
 * exactly one slot on the chart, the jersey wins: clubs abbreviate
 * ("A.-BERGLUND" for Adeyemi-Berglund) and the feed hyphenates differently.
 * Lowest depth wins if a name somehow appears twice.
 */
export function alignmentFor(player: string, slots: ChartSlot[]): string | null {
    const { jersey, surname } = splitPlayText(player)
    if (jersey === null) return null
    const byJersey = slots.filter((s) => s.jersey === jersey).sort((a, b) => a.depth - b.depth)
    if (byJersey.length === 0) return null
    const compatible = byJersey.find((s) => {
        const c = chartSurname(s.player)
        return (
            c.length > 0 && surname.length > 0 && (c.startsWith(surname) || surname.startsWith(c))
        )
    })
    if (compatible) return compatible.position
    return byJersey.length === 1 ? byJersey[0].position : null
}

/**
 * The most common slot a player held across a season's charts (any depth),
 * ties broken toward the outside (1S over 2S) and then alphabetically so the
 * answer is stable.
 */
export function primaryAlignment(player: string, slots: ChartSlot[][]): string | null {
    const counts = new Map<string, number>()
    for (const chart of slots) {
        const p = alignmentFor(player, chart)
        if (p) counts.set(p, (counts.get(p) ?? 0) + 1)
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    return ranked[0]?.[0] ?? null
}
