import { GraphQLError } from 'graphql'
import { z } from 'zod'
import { builder } from '~/builder'
import { jobEnqueue } from '~/dao/job.server'
import { db } from '~/lib/db.server'
import { requireAdmin } from '~/lib/guards.server'
import { CoachingRoleEnum, JobStatusEnum, ScrapeStatusEnum } from '~/schemas/enums.server'
import { isStrategy, STRATEGIES } from '~/services/depthCharts/scrape/extractors'
import { JOB_HANDLERS } from '~/worker/handlers.server'
import type { Prisma } from '~/generated/prisma/client'

// The admin surface: scraper health, scrape config as data, and the job queue.
// Every field here calls requireAdmin — web's /admin redirect is UX, this is
// the enforcement. Retires scripts/syncTeamSourceConfig.ts once used.

const ADMIN = 'Admin only.'
const badInput = (message: string): GraphQLError =>
    new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } })
const clampLimit = (limit: number | null | undefined): number =>
    Math.min(Math.max(limit ?? 50, 1), 500)

builder.prismaObject('ScrapeRun', {
    fields: (t) => ({
        id: t.exposeInt('id'),
        status: t.expose('status', { type: ScrapeStatusEnum }),
        itemCount: t.exposeInt('itemCount', { nullable: true }),
        addedCount: t.exposeInt('addedCount', { nullable: true }),
        revisedCount: t.exposeInt('revisedCount', {
            nullable: true,
            description: 'Charts whose PDF changed under an unchanged link this run.',
        }),
        error: t.exposeString('error', { nullable: true }),
        startedAt: t.expose('startedAt', { type: 'DateTime' }),
        finishedAt: t.expose('finishedAt', { type: 'DateTime', nullable: true }),
        team: t.relation('Team'),
    }),
})

builder.prismaObject('Job', {
    fields: (t) => ({
        id: t.exposeInt('id'),
        kind: t.exposeString('kind'),
        payload: t.expose('payload', { type: 'JSON' }),
        status: t.expose('status', { type: JobStatusEnum }),
        attempts: t.exposeInt('attempts'),
        runAt: t.expose('runAt', { type: 'DateTime' }),
        startedAt: t.expose('startedAt', { type: 'DateTime', nullable: true }),
        finishedAt: t.expose('finishedAt', { type: 'DateTime', nullable: true }),
        error: t.exposeString('error', { nullable: true }),
        createdAt: t.expose('createdAt', { type: 'DateTime' }),
    }),
})

builder.prismaObject('TeamSource', {
    fields: (t) => ({
        id: t.exposeInt('id'),
        kind: t.exposeString('kind'),
        url: t.exposeString('url'),
        strategy: t.exposeString('strategy'),
        config: t.expose('config', { type: 'JSON' }),
        requiresBrowser: t.exposeBoolean('requiresBrowser'),
        enabled: t.exposeBoolean('enabled'),
        lastOkAt: t.expose('lastOkAt', { type: 'DateTime', nullable: true }),
        lastError: t.exposeString('lastError', { nullable: true }),
        lastItemCount: t.exposeInt('lastItemCount', { nullable: true }),
        updatedAt: t.expose('updatedAt', { type: 'DateTime' }),
        team: t.relation('Team'),
    }),
})

const TeamSourceInput = builder.inputType('TeamSourceInput', {
    description: 'Every field optional; omitted fields are left unchanged.',
    fields: (t) => ({
        url: t.string(),
        strategy: t.string(),
        config: t.field({ type: 'JSON' }),
        requiresBrowser: t.boolean(),
        enabled: t.boolean(),
    }),
})

const CoachingStaffInput = builder.inputType('CoachingStaffInput', {
    fields: (t) => ({
        teamSlug: t.string({ required: true }),
        role: t.field({ type: CoachingRoleEnum, required: true }),
        person: t.string({ required: true }),
        effectiveFrom: t.field({ type: 'DateTime', required: true }),
        effectiveTo: t.field({ type: 'DateTime' }),
    }),
})

const coachingStaffInput = z
    .object({
        teamSlug: z.string().min(1),
        role: z.enum(['HC', 'OC', 'DC']),
        person: z.string().trim().min(2).max(100),
        effectiveFrom: z.date(),
        effectiveTo: z.date().nullable(),
    })
    .refine((v) => v.effectiveTo === null || v.effectiveTo > v.effectiveFrom, {
        message: 'effectiveTo must be after effectiveFrom',
    })

// What an admin may write. The scrape job runs this config against a club's
// site, so a bad value here is a silent outage — validate at the boundary.
const teamSourcePatch = z.object({
    url: z.url({ protocol: /^https?$/ }).optional(),
    strategy: z
        .string()
        .refine(isStrategy, `strategy must be one of ${STRATEGIES.join(', ')}`)
        .optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    requiresBrowser: z.boolean().optional(),
    enabled: z.boolean().optional(),
})

builder.queryFields((t) => ({
    scrapeRuns: t.prismaField({
        type: ['ScrapeRun'],
        description: 'Admin only. Newest first.',
        args: { teamSlug: t.arg.string(), limit: t.arg.int({ defaultValue: 50 }) },
        resolve: (query, _root, { teamSlug, limit }, ctx) => {
            requireAdmin(ctx)
            return db.scrapeRun.findMany({
                ...query,
                where: teamSlug ? { Team: { slug: teamSlug } } : {},
                orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
                take: clampLimit(limit),
            })
        },
    }),
    jobs: t.prismaField({
        type: ['Job'],
        description: 'Admin only. Newest first.',
        args: {
            kind: t.arg.string(),
            status: t.arg({ type: JobStatusEnum }),
            limit: t.arg.int({ defaultValue: 50 }),
        },
        resolve: (query, _root, { kind, status, limit }, ctx) => {
            requireAdmin(ctx)
            return db.job.findMany({
                ...query,
                where: { ...(kind ? { kind } : {}), ...(status ? { status } : {}) },
                orderBy: { id: 'desc' },
                take: clampLimit(limit),
            })
        },
    }),
    teamSources: t.prismaField({
        type: ['TeamSource'],
        description: ADMIN,
        resolve: (query, _root, _args, ctx) => {
            requireAdmin(ctx)
            return db.teamSource.findMany({ ...query, orderBy: { Team: { name: 'asc' } } })
        },
    }),
}))

builder.mutationFields((t) => ({
    upsertCoachingStaff: t.prismaField({
        type: 'CoachingStaff',
        description:
            'Admin only. Upserts on (team, role, person, effectiveFrom); co-coordinators are two rows.',
        args: { input: t.arg({ type: CoachingStaffInput, required: true }) },
        resolve: async (query, _root, { input }, ctx) => {
            requireAdmin(ctx)
            const parsed = coachingStaffInput.safeParse({
                ...input,
                effectiveTo: input.effectiveTo ?? null,
            })
            if (!parsed.success) throw badInput(z.prettifyError(parsed.error))
            const { teamSlug, role, person, effectiveFrom, effectiveTo } = parsed.data
            const team = await db.team.findUnique({
                where: { slug: teamSlug },
                select: { id: true },
            })
            if (!team) throw badInput(`Unknown team "${teamSlug}"`)
            return db.coachingStaff.upsert({
                ...query,
                where: {
                    teamId_role_person_effectiveFrom: {
                        teamId: team.id,
                        role,
                        person,
                        effectiveFrom,
                    },
                },
                update: { effectiveTo },
                create: { teamId: team.id, role, person, effectiveFrom, effectiveTo },
            })
        },
    }),
    deleteCoachingStaff: t.boolean({
        description: 'Admin only. Idempotent: deleting a missing row returns false.',
        args: { id: t.arg.int({ required: true }) },
        resolve: async (_root, { id }, ctx) => {
            requireAdmin(ctx)
            const { count } = await db.coachingStaff.deleteMany({ where: { id } })
            return count === 1
        },
    }),
    updateTeamSource: t.prismaField({
        type: 'TeamSource',
        description: ADMIN,
        args: {
            id: t.arg.int({ required: true }),
            input: t.arg({ type: TeamSourceInput, required: true }),
        },
        resolve: async (query, _root, { id, input }, ctx) => {
            requireAdmin(ctx)
            // Strip nulls: GraphQL "omitted" and "null" both mean "leave alone".
            const given = Object.fromEntries(
                Object.entries(input).filter(([, v]) => v !== null && v !== undefined),
            )
            const parsed = teamSourcePatch.safeParse(given)
            if (!parsed.success) throw badInput(z.prettifyError(parsed.error))
            const existing = await db.teamSource.findUnique({ where: { id }, select: { id: true } })
            if (!existing) {
                throw new GraphQLError(`No team source ${id}`, {
                    extensions: { code: 'NOT_FOUND' },
                })
            }
            const { config, ...rest } = parsed.data
            return db.teamSource.update({
                ...query,
                where: { id },
                data: { ...rest, ...(config ? { config: config as Prisma.InputJsonObject } : {}) },
            })
        },
    }),
    enqueueJob: t.prismaField({
        type: 'Job',
        description: 'Admin only. Unknown kinds are rejected with BAD_USER_INPUT.',
        args: { kind: t.arg.string({ required: true }), payload: t.arg({ type: 'JSON' }) },
        resolve: async (query, _root, { kind, payload }, ctx) => {
            requireAdmin(ctx)
            const name = kind.trim()
            // The handler map is the one list of kinds; the worker would fail an
            // unknown one for good anyway, but a typo deserves an answer now.
            if (!Object.hasOwn(JOB_HANDLERS, name)) {
                throw badInput(
                    `Unknown job kind "${name}"; expected one of ${Object.keys(JOB_HANDLERS).join(', ')}`,
                )
            }
            if (payload != null && (typeof payload !== 'object' || Array.isArray(payload))) {
                throw badInput('payload must be a JSON object')
            }
            const job = await jobEnqueue(name, (payload ?? {}) as Prisma.InputJsonObject)
            return db.job.findUniqueOrThrow({ ...query, where: { id: job.id } })
        },
    }),
}))
