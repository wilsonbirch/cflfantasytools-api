import { afterAll, beforeAll, beforeEach } from 'vitest'
import { buildIntegrationContext, getIntegrationContext, resetDatabase } from './integrationContext'

beforeAll(async () => {
    await buildIntegrationContext()
})

afterAll(async () => {
    await getIntegrationContext().teardown()
})

beforeEach(async () => {
    await resetDatabase(getIntegrationContext().prisma)
})
