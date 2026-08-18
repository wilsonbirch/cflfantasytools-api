import 'dotenv/config'
import { defineConfig } from 'prisma/config'

// DATABASE_URL is only needed for migrate/CLI DB ops; `prisma generate` (run on
// every install, including no-DB CI jobs) must not require it. Read it leniently
// so generate never throws when the var is unset.
export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: {
        path: 'prisma/migrations',
        seed: 'tsx prisma/seed.ts',
    },
    datasource: {
        url: process.env.DATABASE_URL ?? '',
    },
})
