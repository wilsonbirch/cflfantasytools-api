import { createYoga } from 'graphql-yoga'
import { createServer } from 'node:http'
import { createContext } from '~/context'
import { handleHealth } from '~/routes/health.server'
import { schema } from '~/schema'

export const yoga = createYoga({
    schema,
    context: createContext,
    graphiql: process.env.NODE_ENV !== 'production',
    landingPage: false,
})

// Routes needing the raw body (webhooks) or that must stay dependency-free
// (health) are handled before Yoga; everything else is GraphQL.
export const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        handleHealth(req, res)
        return
    }
    yoga(req, res)
})

export default server
