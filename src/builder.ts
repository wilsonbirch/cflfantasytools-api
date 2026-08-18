import SchemaBuilder from '@pothos/core'
import ErrorsPlugin from '@pothos/plugin-errors'
import PrismaPlugin from '@pothos/plugin-prisma'
import { DateTimeResolver, JSONResolver } from 'graphql-scalars'
import type { GraphQLContext } from '~/context'
import type PrismaTypes from '~/generated/pothos-types'
import { getDatamodel } from '~/generated/pothos-types'
import { db } from '~/lib/db.server'

export const builder = new SchemaBuilder<{
    Context: GraphQLContext
    Scalars: {
        DateTime: { Input: Date; Output: Date }
        JSON: { Input: unknown; Output: unknown }
    }
    PrismaTypes: PrismaTypes
}>({
    plugins: [ErrorsPlugin, PrismaPlugin],
    prisma: {
        // The Proxy from db.server, so __setTestPrisma swaps are visible at query time.
        client: db,
        // Prisma 7 no longer exposes DMMF on the client — Pothos takes the
        // datamodel from the generated types module instead.
        dmmf: getDatamodel(),
    },
    errors: {
        defaultTypes: [Error],
    },
})

builder.addScalarType('DateTime', DateTimeResolver, {})
builder.addScalarType('JSON', JSONResolver, {})

builder.queryType({
    fields: (t) => ({
        // Liveness probe — succeeds only if the DB is actually reachable, which
        // is what makes it worth more than a static 200 from /health.
        isUp: t.boolean({
            resolve: async () => {
                await db.account.count()
                return true
            },
        }),
    }),
})

// No mutationType yet: an object type with zero fields is invalid GraphQL and
// breaks client codegen. Phase 2 declares it alongside the first auth mutation,
// after which domain modules attach fields via builder.mutationFields(...).
