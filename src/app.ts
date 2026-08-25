import { createYoga } from 'graphql-yoga'
import { createServer } from 'node:http'
import { createContext } from '~/context'
import { handleDepthChartFile, matchDepthChartFile } from '~/routes/depthChartFiles.server'
import { handleHealth } from '~/routes/health.server'
import { handleUnsubscribe, matchUnsubscribe } from '~/routes/unsubscribe.server'
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
    const fileId = req.method === 'GET' ? matchDepthChartFile(req.url ?? '') : null
    if (fileId !== null) {
        void handleDepthChartFile(fileId, res)
        return
    }
    // GET is the link click; POST is the RFC 8058 one-click header.
    if (
        (req.method === 'GET' || req.method === 'POST') &&
        ((req.url ?? '') === '/unsubscribe' || (req.url ?? '').startsWith('/unsubscribe?'))
    ) {
        void handleUnsubscribe(matchUnsubscribe(req.url ?? ''), res)
        return
    }
    yoga(req, res)
})

export default server
