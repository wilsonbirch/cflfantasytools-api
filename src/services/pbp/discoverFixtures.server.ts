import { logger } from '~/lib/logger.server'

const fileName = 'services/pbp/discoverFixtures'

// cfl.ca was rebuilt on Nuxt partway through 2026. The schedule page no longer
// links to per-game pages with the BetGenius id in a tracker embed; instead it
// server-renders the whole season into a `__NUXT_DATA__` payload, and every
// fixture in it carries `genius.id` directly. One request now resolves the
// season, where the old page needed ~80.
//
// The old shape failed SILENTLY: the link regex matched nothing, discovery
// returned [], and capture "succeeded" with 0 games from early September 2026
// until it was noticed in November. Discovery now throws on an empty result.
export const SCHEDULE_URL = 'https://cfl.ca/schedule/'

export type DiscoveredFixture = {
    // CFL's own game id (the `/games/{id}` route on cfl.ca).
    cflGameId: number
    // BetGenius fixture id — the key the play-by-play feeds take, and Game.id.
    fixtureId: number
    // Kickoff, UTC. Null when the schedule omits it.
    startAt: Date | null
}

const NUXT_DATA = /<script[^>]*\bid="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/

/**
 * Rebuild the object graph from Nuxt's flattened payload.
 *
 * The payload is `devalue` output: a flat array where every object and array
 * holds INDICES into that array rather than values, and an array whose first
 * element is a string is a typed value (`["Reactive", 3]`, `["Date", "…"]`).
 * Deliberately tolerant of types it does not know — a wrapper it cannot name
 * is unwrapped to its first argument rather than failing the whole season over
 * a framework detail. Objects are registered before their children are
 * hydrated, so shared and cyclic references resolve without recursing forever.
 */
export function unflattenNuxtPayload(values: unknown[]): unknown {
    const hydrated = new Map<number, unknown>()

    const hydrate = (index: unknown): unknown => {
        // Negative indices are devalue's sentinels (undefined, holes, NaN, ±∞, -0).
        if (typeof index !== 'number' || index < 0 || index >= values.length) return undefined
        if (hydrated.has(index)) return hydrated.get(index)

        const value = values[index]
        if (value === null || typeof value !== 'object') {
            hydrated.set(index, value)
            return value
        }

        if (Array.isArray(value)) {
            if (typeof value[0] === 'string') {
                const [type, ...args] = value as [string, ...unknown[]]
                let out: unknown
                switch (type) {
                    case 'Date':
                    case 'BigInt':
                    case 'RegExp':
                        out = args[0]
                        break
                    case 'Set': {
                        const arr: unknown[] = []
                        hydrated.set(index, arr)
                        for (const a of args) arr.push(hydrate(a))
                        return arr
                    }
                    case 'null': {
                        // A null-prototype object: alternating key, value-index.
                        const obj: Record<string, unknown> = {}
                        hydrated.set(index, obj)
                        for (let i = 0; i + 1 < args.length; i += 2) {
                            obj[String(args[i])] = hydrate(args[i + 1])
                        }
                        return obj
                    }
                    case 'Map':
                    case 'Object':
                        // Not used for anything discovery reads; keep the shape inert.
                        out = undefined
                        break
                    default:
                        // Reactive, ShallowReactive, Ref, ShallowRef, EmptyRef, … —
                        // Vue wrappers whose payload is their single argument.
                        out = hydrate(args[0])
                }
                hydrated.set(index, out)
                return out
            }
            const arr: unknown[] = []
            hydrated.set(index, arr)
            for (const i of value) arr.push(hydrate(i))
            return arr
        }

        const obj: Record<string, unknown> = {}
        hydrated.set(index, obj)
        for (const [k, i] of Object.entries(value)) obj[k] = hydrate(i)
        return obj
    }

    return hydrate(0)
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Every fixture in the schedule page, deduplicated on fixture id, in kickoff
 * order.
 *
 * Found by shape rather than by path: the payload's key names
 * (`schedule-75-primary`) embed a season id that changes every year, and a
 * path-based lookup would break on the first day of 2027. The shape has to be
 * a FIXTURE's, though — teams and venues on the same page also carry `ID` and
 * `genius.id`, and matching on those alone picked up 18 of them as games.
 */
export function parseScheduleFixtures(scheduleHtml: string): DiscoveredFixture[] {
    const m = scheduleHtml.match(NUXT_DATA)
    if (!m) return []

    let values: unknown
    try {
        values = JSON.parse(m[1])
    } catch {
        return []
    }
    if (!Array.isArray(values)) return []

    const found = new Map<number, DiscoveredFixture>()
    const seen = new Set<unknown>()
    const stack: unknown[] = [unflattenNuxtPayload(values)]

    while (stack.length > 0) {
        const node = stack.pop()
        if (node === null || typeof node !== 'object' || seen.has(node)) continue
        seen.add(node)

        if (Array.isArray(node)) {
            stack.push(...node)
            continue
        }
        if (!isRecord(node)) continue

        const genius = node.genius
        if (
            typeof node.ID === 'number' &&
            // Present, not necessarily numeric: the Grey Cup is listed with
            // null teams until the finals are played.
            'home_team_id' in node &&
            'away_team_id' in node &&
            isRecord(genius) &&
            typeof genius.id === 'number'
        ) {
            const parsed = typeof node.start_at === 'string' ? new Date(node.start_at) : null
            const startAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null
            // The same fixture can be referenced from more than one store; keep
            // whichever copy knows its kickoff.
            if (!found.has(genius.id) || (startAt && !found.get(genius.id)?.startAt)) {
                found.set(genius.id, { cflGameId: node.ID, fixtureId: genius.id, startAt })
            }
        }
        stack.push(...Object.values(node))
    }

    return [...found.values()].sort(
        (a, b) =>
            (a.startAt?.getTime() ?? Infinity) - (b.startAt?.getTime() ?? Infinity) ||
            a.fixtureId - b.fixtureId,
    )
}

/**
 * Resolve the season's fixtures from the cfl.ca schedule page.
 *
 * Throws when the page yields nothing. A season always has fixtures; zero means
 * the page changed shape, and reporting that as a successful capture of nothing
 * is exactly how September and October 2026 went missing.
 */
export async function discoverFixtures(
    fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredFixture[]> {
    const res = await fetchImpl(SCHEDULE_URL, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`schedule fetch failed: HTTP ${res.status}`)

    const fixtures = parseScheduleFixtures(await res.text())
    if (fixtures.length === 0) {
        throw new Error(
            'schedule yielded 0 fixtures — cfl.ca has likely changed shape; ' +
                'refresh test/fixtures/pbp/schedule.html and fix parseScheduleFixtures',
        )
    }

    logger.info(fileName, `schedule lists ${fixtures.length} fixtures`)
    return fixtures
}
