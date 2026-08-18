import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { execSync } from 'node:child_process'
import type { TestProject } from 'vitest/node'

let pg: StartedPostgreSqlContainer | undefined

export default async function setup(project: TestProject) {
    pg = await new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('cflft_test')
        .withUsername('test')
        .withPassword('test')
        .start()

    const databaseUrl = pg.getConnectionUri()

    // Apply the real migration history (not `db push`) so tests run the same SQL as production.
    execSync('npx prisma migrate deploy', {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: ['ignore', 'inherit', 'inherit'],
    })

    project.provide('databaseUrl', databaseUrl)

    return async () => {
        await pg?.stop()
    }
}

declare module 'vitest' {
    export interface ProvidedContext {
        databaseUrl: string
    }
}
