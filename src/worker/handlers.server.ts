export type JobHandler = (payload: unknown) => Promise<void>

// Job kind -> handler. A kind with no handler here is failed for good rather
// than retried (see loop.ts) — retrying an unknown kind can never succeed.
// Handlers land with their features: depth-chart-check in phase 3,
// gamezone-sync in phase 4.
export const JOB_HANDLERS: Record<string, JobHandler> = {}
