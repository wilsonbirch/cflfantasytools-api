import { builder } from '~/builder'
import { jobStaleness } from '~/services/health/staleness.server'

const JobHealth = builder.objectRef<{
    kind: string
    lastSuccessAt: Date | null
    ageMs: number | null
    expectedEveryMs: number
    isStale: boolean
}>('JobHealth')

builder.objectType(JobHealth, {
    description: 'Freshness of one scheduled background job.',
    fields: (t) => ({
        kind: t.exposeString('kind'),
        lastSuccessAt: t.field({
            type: 'DateTime',
            nullable: true,
            resolve: (h) => h.lastSuccessAt,
        }),
        ageMinutes: t.int({
            nullable: true,
            resolve: (h) => (h.ageMs === null ? null : Math.round(h.ageMs / 60_000)),
        }),
        expectedEveryMinutes: t.int({ resolve: (h) => Math.round(h.expectedEveryMs / 60_000) }),
        isStale: t.exposeBoolean('isStale'),
    }),
})

builder.queryFields((t) => ({
    // Deliberately unauthenticated: it exposes only job names and timestamps,
    // and being able to check "is capture still running" without credentials is
    // the point. Nothing here reveals data or configuration.
    jobHealth: t.field({
        type: [JobHealth],
        description: 'Whether each scheduled job has run recently enough.',
        resolve: () => jobStaleness(),
    }),
}))
