import server from '~/app'
import { db } from '~/lib/db.server'
import { logger } from '~/lib/logger.server'
import { startScheduleTicker } from '~/services/health/scheduleTicker.server'

const port = Number(process.env.API_PORT) || 4000

server.listen(port, () => {
    logger.info('index', `🚀 api ready at http://localhost:${port}/graphql`)
})

// web is always-on, so it owns the schedule trigger and wakes the sleeping
// worker. Enabled per-environment via SCHEDULE_TICKER_ENABLED so a local shell
// or a test never starts enqueueing real jobs.
startScheduleTicker()

// Graceful stop: let in-flight requests finish, then release the DB pool.
// Fly sends SIGTERM before stopping the machine.
process.on('SIGTERM', () => {
    logger.info('index', 'SIGTERM received; shutting down')
    server.close(() => {
        void db.$disconnect().finally(() => process.exit(0))
    })
})
