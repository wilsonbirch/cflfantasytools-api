/**
 * Boot smoke test: start the REAL server process (src/index.ts), wait for it to
 * report ready, then query `isUp` over HTTP and assert it returns true.
 *
 * This catches a class of failures the in-process integration suite cannot — it
 * never runs the entrypoint/transport: boot crashes, bad API_PORT handling, ESM
 * module-resolution errors, Sentry init throwing, Prisma failing to connect at
 * startup. `isUp` exercises the whole chain: process → Yoga → Prisma → DB.
 *
 * Requires a reachable, migrated database (isUp runs a DB query).
 * Usage: npm run boot-smoke
 */
import { spawn } from 'node:child_process'

const PORT = process.env.API_PORT || '4100'
const READY_MARKER = 'api ready'
const BOOT_TIMEOUT_MS = 30_000
const POLL_MS = 200

function fail(message: string, logs: string): never {
    console.error(`✖ boot-smoke failed: ${message}`)
    if (logs.trim()) console.error(`--- server output ---\n${logs}`)
    process.exit(1)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
    const child = spawn('npx', ['tsx', '--env-file-if-exists=.env', 'src/index.ts'], {
        env: { ...process.env, API_PORT: PORT },
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    let logs = ''
    let ready = false
    let exitedEarly = false
    child.stdout.on('data', (d: Buffer) => (logs += d.toString()))
    child.stderr.on('data', (d: Buffer) => (logs += d.toString()))
    child.on('exit', (code) => {
        if (!ready) exitedEarly = true
        void code
    })

    const stop = () => {
        try {
            child.kill('SIGTERM')
        } catch {
            // already gone
        }
    }
    process.on('exit', stop)

    // Wait for the ready marker (or early exit / timeout).
    const startedAt = Date.now()
    while (!logs.includes(READY_MARKER)) {
        if (exitedEarly) fail(`server exited before logging "${READY_MARKER}"`, logs)
        if (Date.now() - startedAt > BOOT_TIMEOUT_MS) {
            stop()
            fail(`timed out after ${BOOT_TIMEOUT_MS}ms waiting for "${READY_MARKER}"`, logs)
        }
        await sleep(POLL_MS)
    }
    ready = true

    // Query isUp over real HTTP.
    try {
        const response = await fetch(`http://localhost:${PORT}/graphql`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: '{ isUp }' }),
        })
        const body = (await response.json()) as { data?: { isUp?: boolean }; errors?: unknown }
        if (!response.ok) fail(`HTTP ${response.status} from /graphql`, logs)
        if (body.errors) fail(`GraphQL errors: ${JSON.stringify(body.errors)}`, logs)
        if (body.data?.isUp !== true)
            fail(`expected isUp=true, got ${JSON.stringify(body.data)}`, logs)
    } catch (err) {
        fail(`request to /graphql failed: ${(err as Error).message}`, logs)
    } finally {
        stop()
    }

    console.log(`✔ boot-smoke OK — server booted on :${PORT} and isUp returned true`)
    process.exit(0)
}

main()
