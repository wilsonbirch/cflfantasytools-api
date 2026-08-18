import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '~/generated/prisma/client'

let _db: PrismaClient = {} as PrismaClient

declare global {
    var __db: PrismaClient | undefined
}

// Prisma 7 is driver-adapter based: pass an explicit pg adapter rather than a URL.
// The 60s transaction timeout is for the worker's batch writes (the depth-chart
// migration and feed sync both write hundreds of rows in one transaction);
// request-path transactions never come near it.
function createClient(): PrismaClient {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
    return new PrismaClient({
        adapter,
        transactionOptions: { timeout: 60_000, maxWait: 10_000 },
    })
}

if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    // Unit tests mock '~/lib/db.server'; integration tests inject via __setTestPrisma().
} else if (process.env.NODE_ENV === 'production') {
    _db = createClient()
} else {
    // Reuse one client across hot-reloads in development.
    if (!global.__db) global.__db = createClient()
    _db = global.__db
}

// Proxy so callers that capture `db` at import time (notably Pothos' PrismaPlugin
// in builder.ts) still see the live client after __setTestPrisma swaps it in tests.
export const db: PrismaClient = new Proxy({} as PrismaClient, {
    get(_, prop) {
        return Reflect.get(_db, prop)
    },
    has(_, prop) {
        return Reflect.has(_db, prop)
    },
})

export const __setTestPrisma = (client: PrismaClient): void => {
    _db = client
}

export * from '~/generated/prisma/client'
