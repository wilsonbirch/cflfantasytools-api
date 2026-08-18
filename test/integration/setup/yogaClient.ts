import { createYoga, type YogaServerInstance } from 'graphql-yoga'
import type { GraphQLContext } from '~/context'

let _yoga: YogaServerInstance<object, GraphQLContext> | null = null

async function getYoga(): Promise<YogaServerInstance<object, GraphQLContext>> {
    if (!_yoga) {
        // Lazy import so __setTestPrisma (perTestSetup) runs before the schema module
        // wires builder.ts → db.server.
        const { schema } = await import('~/schema')
        const { createContext } = await import('~/context')
        _yoga = createYoga({
            schema,
            context: createContext,
            landingPage: false,
            graphiql: false,
            // Surface real error messages in tests instead of "Unexpected error".
            maskedErrors: false,
        })
    }
    return _yoga
}

export type GraphqlExecutionResult<T = unknown> = {
    data?: T | null
    errors?: Array<{
        message: string
        path?: ReadonlyArray<string | number>
        extensions?: Record<string, unknown>
        [k: string]: unknown
    }>
}

export async function executeOperation<T = unknown>(
    operation: {
        query: string
        variables?: Record<string, unknown>
        operationName?: string
    },
    options: { token?: string } = {},
): Promise<GraphqlExecutionResult<T>> {
    const yoga = await getYoga()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (options.token) headers.authorization = `Bearer ${options.token}`
    const response = await yoga.fetch(
        new Request('http://test.local/graphql', {
            method: 'POST',
            headers,
            body: JSON.stringify(operation),
        }),
    )
    return (await response.json()) as GraphqlExecutionResult<T>
}
