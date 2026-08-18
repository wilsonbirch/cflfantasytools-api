/**
 * Worker boot smoke test: start the REAL worker process (src/worker/index.ts),
 * wait for its ready marker, then SIGTERM it and assert a clean exit 0 — the
 * signal Fly's stop path sends and the graceful-shutdown contract the machine
 * lifecycle depends on.
 *
 * The boot is real, so the scheduled kinds enqueue and may start running before
 * the SIGTERM lands; the spawn env points the podcast feeds at a dead URL and
 * blanks the Sanity config so those jobs fail fast locally instead of doing
 * network work (they just land back PENDING for a retry — the exit stays 0).
 *
 * Requires a reachable, migrated database (the Job table is touched at boot).
 * Usage: npm run boot-smoke:worker
 */
import { spawn } from 'node:child_process'

const READY_MARKER = 'worker ready'
const BOOT_TIMEOUT_MS = 30_000
const EXIT_TIMEOUT_MS = 30_000
const POLL_MS = 200

function fail(message: string, logs: string): never {
    console.error(`✖ worker-boot-smoke failed: ${message}`)
    if (logs.trim()) console.error(`--- worker output ---\n${logs}`)
    process.exit(1)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
    // node runs the worker IN-PROCESS via `--import tsx` — no wrapper between
    // the SIGTERM and our handler. The tsx/npx bins spawn the app as a child
    // and forward signals racily (CI lost that race: exit 143 with the handler
    // installed but never reached). This mirrors the Fly [processes] command.
    const child = spawn(
        process.execPath,
        ['--env-file-if-exists=.env', '--import', 'tsx', 'src/worker/index.ts'],
        {
            env: {
                ...process.env,
                PODCAST_NMH_FREE_RSS_URL: 'http://127.0.0.1:9/dead-feed.xml',
                PODCAST_STORIES_FREE_RSS_URL: 'http://127.0.0.1:9/dead-feed.xml',
                SANITY_PROJECT_ID: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    )

    let logs = ''
    let exitCode: number | null = null
    let exited = false
    child.stdout.on('data', (d: Buffer) => (logs += d.toString()))
    child.stderr.on('data', (d: Buffer) => (logs += d.toString()))
    child.on('exit', (code) => {
        exited = true
        exitCode = code
    })

    const stop = () => {
        try {
            child.kill('SIGKILL')
        } catch {
            // already gone
        }
    }
    process.on('exit', stop)

    // Wait for the ready marker (logged before the first tick).
    const startedAt = Date.now()
    while (!logs.includes(READY_MARKER)) {
        if (exited) fail(`worker exited before logging "${READY_MARKER}"`, logs)
        if (Date.now() - startedAt > BOOT_TIMEOUT_MS) {
            stop()
            fail(`timed out after ${BOOT_TIMEOUT_MS}ms waiting for "${READY_MARKER}"`, logs)
        }
        await sleep(POLL_MS)
    }

    // SIGTERM must finish any in-flight job, disconnect, and exit 0.
    child.kill('SIGTERM')
    const termAt = Date.now()
    while (!exited) {
        if (Date.now() - termAt > EXIT_TIMEOUT_MS) {
            stop()
            fail(`worker did not exit within ${EXIT_TIMEOUT_MS}ms of SIGTERM`, logs)
        }
        await sleep(POLL_MS)
    }
    if (exitCode !== 0) fail(`expected exit code 0 after SIGTERM, got ${exitCode}`, logs)

    console.log('✔ worker-boot-smoke OK — worker booted, took SIGTERM, exited 0')
    process.exit(0)
}

main()
