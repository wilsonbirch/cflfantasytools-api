import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { toStoredPayload } from '~/services/pbp/capturePbp.server'

// The same game, Montreal v Ottawa 2026 week 12 (fixture 13419716), captured
// twice: from the old single widget endpoint in August, and from the new
// per-widget feeds in November. Normalization must reproduce the old payload.
const legacy = JSON.parse(readFileSync('test/fixtures/pbp/widget-payload-13419716.json', 'utf8'))
const pbp = JSON.parse(readFileSync('test/fixtures/pbp/feed-playbyplay-13419716.json', 'utf8'))
const scoreboard = JSON.parse(
    readFileSync('test/fixtures/pbp/feed-scoreboard-13419716.json', 'utf8'),
)

type Play = { id: string; playStartPosition: string }
const byId = (plays: Play[]) => new Map(plays.map((p) => [p.id, p]))

describe('toStoredPayload', () => {
    const stored = toStoredPayload(pbp, scoreboard)

    it('yields the same plays as the old endpoint, field for field', () => {
        const old = byId(legacy.data.playByPlayInfo.ALL as Play[])
        const now = byId(stored.data.playByPlayInfo.ALL as unknown as Play[])
        expect([...now.keys()].sort()).toEqual([...old.keys()].sort())

        for (const [id, play] of old) {
            // Genius has since filled in one start position the old capture
            // carried blank. That is an upstream correction, not a format drift.
            if (id === '1-3') {
                expect(play.playStartPosition).toBe('')
                expect(now.get(id)?.playStartPosition).toBe('3rd & 0 at OTT 50')
                continue
            }
            expect(now.get(id)).toEqual(play)
        }
    })

    it('drops the highlights reel, which only repeats plays', () => {
        expect(stored.data.playByPlayInfo.ALL).toHaveLength(140)
    })

    it('carries the match identity the linker and parser read', () => {
        expect(stored.data.matchInfo.homeTeam?.competitorId).toBe(
            legacy.data.matchInfo.homeTeam.competitorId,
        )
        expect(stored.data.matchInfo.awayTeam?.competitorId).toBe(
            legacy.data.matchInfo.awayTeam.competitorId,
        )
        expect(new Date(stored.data.matchInfo.scheduledStartTime ?? '')).toEqual(
            new Date(legacy.data.matchInfo.scheduledStartTime),
        )
        expect(stored.data.matchInfo.roundName).toBe('Week 12')
    })

    it('turns the scoreboard strings into the integer final the parser expects', () => {
        expect(stored.data.scoreboardInfo).toEqual({
            matchStatus: 'PostMatch',
            homeScore: legacy.data.scoreboardInfo.homeScore,
            awayScore: legacy.data.scoreboardInfo.awayScore,
        })
    })

    it('keeps overtime plays', () => {
        const ot = toStoredPayload(
            {
                data: {
                    details: {
                        playByPlayInfo: {
                            Q4: [{ id: '30-1', phase: 'Regular' }],
                            OT: [{ id: '31-1', phase: 'Overtime' }],
                        },
                    },
                },
            },
            scoreboard,
        )
        expect(ot.data.playByPlayInfo.ALL.map((p) => p.id).sort()).toEqual(['30-1', '31-1'])
    })

    it('is empty, not an error, for a fixture that has not been played', () => {
        const empty = toStoredPayload(
            { data: { status: { status: 'AVAILABLE' }, details: { playByPlayInfo: {} } } },
            scoreboard,
        )
        expect(empty.data.playByPlayInfo.ALL).toEqual([])
    })
})
