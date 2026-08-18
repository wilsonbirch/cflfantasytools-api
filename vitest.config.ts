import { defineConfig } from 'vitest/config'

const sharedResolve = {
    alias: {
        '~/': '/src/',
    },
} as const

export default defineConfig({
    resolve: sharedResolve,
    test: {
        // Enforced only with --coverage (npm run test:coverage). Scoped to business
        // logic: app.ts/index.ts run only in the boot-smoke subprocess, and the
        // generated Prisma client is not ours to cover.
        coverage: {
            provider: 'v8',
            include: ['src/dao/**', 'src/services/**', 'src/schemas/**', 'src/lib/**'],
            exclude: ['src/generated/**', 'src/lib/db.server.ts', 'src/lib/logger.server.ts'],
            reporter: ['text', 'text-summary'],
            thresholds: {
                statements: 90,
                branches: 85,
                functions: 90,
                lines: 90,
            },
        },
        projects: [
            {
                resolve: sharedResolve,
                test: {
                    name: 'unit',
                    environment: 'node',
                    globals: true,
                    include: ['test/unit/**/*.test.ts'],
                },
            },
            {
                resolve: sharedResolve,
                test: {
                    name: 'integration',
                    environment: 'node',
                    globals: true,
                    globalSetup: 'test/integration/setup/globalSetup.ts',
                    setupFiles: 'test/integration/setup/perTestSetup.ts',
                    include: ['test/integration/**/*.test.ts'],
                    testTimeout: 30_000,
                    hookTimeout: 60_000,
                    // One shared Postgres container; serialize workers so the
                    // per-test TRUNCATE doesn't race.
                    pool: 'threads',
                    maxWorkers: 1,
                },
            },
        ],
    },
})
