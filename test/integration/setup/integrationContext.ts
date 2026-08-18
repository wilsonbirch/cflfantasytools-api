import { PrismaPg } from '@prisma/adapter-pg'
import { inject } from 'vitest'
import { PrismaClient } from '~/generated/prisma/client'
import { __setTestPrisma } from '~/lib/db.server'

export type IntegrationContext = {
    prisma: PrismaClient
    teardown: () => Promise<void>
}

let _ctx: IntegrationContext | null = null

/**
 * Refuse to run against anything that isn't an obvious throwaway database.
 *
 * Carried over from 3DF's tests/helpers/db.ts, where it was the one guard
 * standing between a mistyped DATABASE_URL and a TRUNCATE of production. The
 * container URL from globalSetup always satisfies this; a stray .env does not.
 */
export function assertTestDatabase(databaseUrl: string): void {
    const name = new URL(databaseUrl).pathname.replace(/^\//, '').split('?')[0]
    if (!name.endsWith('_test')) {
        throw new Error(
            `Refusing to run integration tests against database "${name}" — the name must end in "_test".`,
        )
    }
}

export async function buildIntegrationContext(): Promise<IntegrationContext> {
    if (_ctx) return _ctx

    const databaseUrl = inject('databaseUrl')
    assertTestDatabase(databaseUrl)
    process.env.DATABASE_URL = databaseUrl
    if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test'

    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) })
    await prisma.$connect()
    // Inject into the db.server singleton so builder.ts's Proxy resolves to this client.
    __setTestPrisma(prisma)

    _ctx = {
        prisma,
        teardown: async () => {
            await prisma.$disconnect()
        },
    }
    return _ctx
}

export function getIntegrationContext(): IntegrationContext {
    if (!_ctx) {
        throw new Error('IntegrationContext not initialized — perTestSetup.ts must run first')
    }
    return _ctx
}

// Tables in no particular order — TRUNCATE ... CASCADE resolves FK order for us,
// and RESTART IDENTITY keeps autoincrement ids predictable across tests.
const TABLES = [
    'Play',
    'Drive',
    'Game',
    'ScrapeRun',
    'DepthChart',
    'DepthChartList',
    'NotificationSubscription',
    'TeamSource',
    'Team',
    'EmailDelivery',
    'Session',
    'Account',
    'Job',
]

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
    const list = TABLES.map((t) => `"${t}"`).join(', ')
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
}
