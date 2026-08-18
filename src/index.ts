import server from '~/app'
import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'

const port = Number(process.env.API_PORT) || 4000

server.listen(port, () => {
    logger.info('index', `🚀 api ready at http://localhost:${port}/graphql`)
})

// Graceful stop: let in-flight requests finish, then release the DB pool.
// Fly sends SIGTERM before stopping the machine.
process.on('SIGTERM', () => {
    logger.info('index', 'SIGTERM received; shutting down')
    server.close(() => {
        void db.$disconnect().finally(() => process.exit(0))
    })
})
