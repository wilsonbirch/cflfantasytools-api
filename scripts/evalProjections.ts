/**
 * Hold-out evaluation of the projection model, in fantasy points.
 *
 * For each hold-out gameweek the model is fitted AS OF the week's start — it
 * sees nothing from that week on — and its projected fantasy points are scored
 * against what players actually did (PlayerGameweekPoints). Two baselines:
 *
 *   - season average: the player's mean points over the season's earlier weeks
 *   - Game Zone:      their projectedScores from the newest snapshot before
 *                     the week started (only exists where snapshots do)
 *
 * MAEs are reported on the players every method can score, so the comparison
 * is like for like. Usage (any database with 2026 data — usually prod via the
 * tunnel, .env.prod):
 *
 *   npx tsx --env-file-if-exists=/dev/null scripts/evalProjections.ts \
 *     [--year 2026] [--weeks 9,10,11] [--prior 1]
 *
 * --prior sweeps PLAYER_PRIOR_GAMES without editing the model.
 */
import { db } from '~/lib/db.server'
import { fantasyPoints } from '~/services/fantasy/scoring'
import { seasonGameweeks } from '~/services/gamezone/gameweeks.server'
import { fitGameweek } from '~/services/projections/fitProjections.server'

const flag = (name: string): string | undefined => {
    const i = process.argv.indexOf(name)
    return i >= 0 ? process.argv[i + 1] : undefined
}

const year = Number(flag('--year') ?? 2026)
const weeks = (flag('--weeks') ?? '9,10,11').split(',').map(Number)
const prior = flag('--prior') ? Number(flag('--prior')) : undefined

const mae = (pairs: [number, number][]): number =>
    pairs.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / pairs.length

type Row = { playerId: number; position: string; actual: number; ours: number; gz: number | null }

async function main(): Promise<void> {
    const season = await seasonGameweeks(year)
    const players = await db.player.findMany({ select: { id: true, position: true } })
    const positionOf = new Map(players.map((p) => [p.id, p.position]))

    const rows: Row[] = []
    const avgPairs: [number, number][] = []
    for (const week of weeks) {
        const gw = season.find((g) => g.week === week)
        if (!gw?.startDate) {
            console.error(`week ${week}: no gameweek or no startDate, skipped`)
            continue
        }
        const asOf = gw.startDate
        const fitted = await fitGameweek(gw.id, asOf, prior)
        const ours = new Map(fitted.map((r) => [r.playerId, fantasyPoints(r)]))

        const actuals = await db.playerGameweekPoints.findMany({
            where: { gameweekId: gw.id },
            select: { playerId: true, points: true },
        })

        // Season-average baseline: the player's mean over earlier weeks.
        const earlier = await db.playerGameweekPoints.findMany({
            where: { Gameweek: { year, startDate: { lt: asOf } } },
            select: { playerId: true, points: true },
        })
        const sums = new Map<number, { n: number; sum: number }>()
        for (const e of earlier) {
            const s = sums.get(e.playerId) ?? { n: 0, sum: 0 }
            s.n += 1
            s.sum += e.points
            sums.set(e.playerId, s)
        }

        // Game Zone's own projection, as it stood before the week started.
        const snaps = await db.playerStatSnapshot.findMany({
            where: { year, capturedAt: { lt: asOf }, projectedScores: { not: null } },
            select: { playerId: true, projectedScores: true },
            orderBy: { capturedAt: 'asc' },
        })
        const gz = new Map(snaps.map((s) => [s.playerId, s.projectedScores!]))

        for (const a of actuals) {
            const our = ours.get(a.playerId)
            if (our === undefined) continue
            rows.push({
                playerId: a.playerId,
                position: positionOf.get(a.playerId) ?? '?',
                actual: a.points,
                ours: our,
                gz: gz.get(a.playerId) ?? null,
            })
            const s = sums.get(a.playerId)
            if (s) avgPairs.push([a.points, s.sum / s.n])
        }
        console.log(`week ${week}: ${actuals.length} actuals, ${fitted.length} projected`)
    }

    if (rows.length === 0) {
        console.error('nothing to evaluate')
        process.exit(1)
    }

    console.log(`\n=== ${rows.length} player-weeks scored (prior=${prior ?? 'default'}) ===`)
    console.log(`model MAE          ${mae(rows.map((r) => [r.actual, r.ours])).toFixed(2)}`)
    console.log(`season-average MAE ${mae(avgPairs).toFixed(2)}  (${avgPairs.length} scorable)`)
    const both = rows.filter((r) => r.gz !== null)
    if (both.length > 0) {
        console.log(`\n--- vs Game Zone, same ${both.length} player-weeks ---`)
        console.log(`model MAE     ${mae(both.map((r) => [r.actual, r.ours])).toFixed(2)}`)
        console.log(`Game Zone MAE ${mae(both.map((r) => [r.actual, r.gz!])).toFixed(2)}`)
    }
    for (const pos of ['QUARTERBACK', 'RUNNING_BACK', 'WIDE_RECEIVER']) {
        const sub = rows.filter((r) => r.position === pos)
        if (sub.length === 0) continue
        const gzSub = sub.filter((r) => r.gz !== null)
        console.log(
            `${pos.padEnd(14)} n=${String(sub.length).padStart(3)}  model ${mae(sub.map((r) => [r.actual, r.ours])).toFixed(2)}` +
                (gzSub.length > 0
                    ? `  gz ${mae(gzSub.map((r) => [r.actual, r.gz!])).toFixed(2)} (n=${gzSub.length})`
                    : ''),
        )
    }
    process.exit(0)
}

void main()
