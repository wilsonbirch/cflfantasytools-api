#!/usr/bin/env bash
# Off-by-default operation: power the stack up, collect, power it down.
#
# Production normally sits fully stopped — database, worker and web — so the
# only standing cost is the database volume. A collection run starts the
# database, starts the worker (which enqueues every scheduled job that is due
# on boot, drains the queue, then idle-exits), checks that the jobs actually
# succeeded, and stops the database again.
#
# Usage:
#   scripts/collect.sh run        # full collection; exits non-zero if any due job failed
#   scripts/collect.sh db-up      # start the database and wait until it is healthy
#   scripts/collect.sh db-down    # stop the database
#   scripts/collect.sh db-state   # prints "started" if every DB machine is up, else "stopped"
#
# Env:
#   KEEP_DB=1               leave the database running after `run` (for debugging)
#   WORKER_TIMEOUT_MIN=45   give up waiting for the worker after this long
#   FLY_API_TOKEN           in CI (the deploy workflow): deploy token for the api app
#   FLY_DB_TOKEN            in CI (the deploy workflow): deploy token for the database app
#   (Locally, leave both unset and flyctl uses your `fly auth login`.)
#
# Why a run is verified through jobHealth rather than the worker's exit code:
# the worker exits 0 after draining even if a job failed (failure is recorded
# on the Job row, and the worker's restart policy would otherwise loop it). So
# "the worker stopped" says nothing about the data. jobHealth reports when each
# kind last SUCCEEDED, which is the thing that matters — the failure that cost
# September and October 2026 was a job that ran and stored nothing.
set -euo pipefail

APP=${APP:-cflfantasytools-api}
DB_APP=${DB_APP:-cflfantasytools-db}
API_URL=${API_URL:-https://cflfantasytools-api.fly.dev}
WORKER_TIMEOUT_MIN=${WORKER_TIMEOUT_MIN:-45}
DB_TIMEOUT_SEC=${DB_TIMEOUT_SEC:-300}
FLY=${FLY:-flyctl}

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Run flyctl with the token for the app it touches. Each token is a deploy
# token scoped to one app, so a leaked database token cannot deploy the api and
# vice versa. With neither set (a workstation), flyctl uses the login.
fly_for() {
    local app=$1 token
    shift
    if [ "$app" = "$DB_APP" ]; then token=${FLY_DB_TOKEN:-}; else token=${FLY_API_TOKEN:-}; fi
    if [ -n "$token" ]; then FLY_API_TOKEN=$token "$FLY" "$@"; else "$FLY" "$@"; fi
}

machines_json() { fly_for "$1" machines list -a "$1" --json; }

db_ids() { machines_json "$DB_APP" | jq -r '.[].id'; }

worker_ids() {
    machines_json "$APP" | jq -r '.[] | select(.config.metadata.fly_process_group == "worker") | .id'
}

machine_state() { machines_json "$1" | jq -r --arg id "$2" '.[] | select(.id == $id) | .state'; }

db_state() {
    if machines_json "$DB_APP" | jq -e 'length > 0 and all(.[]; .state == "started")' >/dev/null; then
        echo started
    else
        echo stopped
    fi
}

db_healthy() {
    machines_json "$DB_APP" | jq -e '
        length > 0 and all(.[];
            .state == "started" and (.checks | length > 0) and all(.checks[]; .status == "passing"))
    ' >/dev/null
}

db_up() {
    for id in $(db_ids); do
        if [ "$(machine_state "$DB_APP" "$id")" != started ]; then
            log "starting database machine $id"
            fly_for "$DB_APP" machine start "$id" -a "$DB_APP" >/dev/null
        fi
    done
    local deadline=$(( $(date +%s) + DB_TIMEOUT_SEC ))
    until db_healthy; do
        [ "$(date +%s)" -lt "$deadline" ] || die "database not healthy after ${DB_TIMEOUT_SEC}s"
        sleep 5
    done
    log "database healthy"
}

db_down() {
    for id in $(db_ids); do
        if [ "$(machine_state "$DB_APP" "$id")" = started ]; then
            log "stopping database machine $id"
            fly_for "$DB_APP" machine stop "$id" -a "$DB_APP" >/dev/null
        fi
    done
}

workers_stopped() {
    machines_json "$APP" | jq -e '
        [.[] | select(.config.metadata.fly_process_group == "worker")]
        | length > 0 and all(.[]; .state == "stopped" or .state == "suspended")
    ' >/dev/null
}

stop_workers() {
    for id in $(worker_ids); do
        fly_for "$APP" machine stop "$id" -a "$APP" >/dev/null || true
    done
}

# jobHealth, through the web machine. web has min_machines_running = 0, so this
# request is what starts it; allow for the cold start.
job_health() {
    local body='{"query":"{ jobHealth { kind ageMinutes expectedEveryMinutes } }"}'
    for _ in $(seq 1 12); do
        if out=$(curl -sS -m 60 -H 'content-type: application/json' -d "$body" "$API_URL/graphql") &&
            echo "$out" | jq -e '.data.jobHealth' >/dev/null 2>&1; then
            echo "$out"
            return 0
        fi
        sleep 10
    done
    die "jobHealth unreachable: ${out:-no response}"
}

run() {
    local started_at elapsed_min
    trap 'cleanup' EXIT

    db_up
    started_at=$(date +%s)

    local ids
    ids=$(worker_ids)
    [ -n "$ids" ] || die "no worker machine in $APP"
    for id in $ids; do
        if [ "$(machine_state "$APP" "$id")" != started ]; then
            log "starting worker machine $id"
            fly_for "$APP" machine start "$id" -a "$APP" >/dev/null
        fi
    done

    # Give the worker a moment to leave "stopped" before polling for it to return there.
    sleep 15
    local deadline=$(( started_at + WORKER_TIMEOUT_MIN * 60 ))
    until workers_stopped; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
            log "worker still running after ${WORKER_TIMEOUT_MIN}m; stopping it"
            stop_workers
            die "collection timed out"
        fi
        sleep 20
    done
    elapsed_min=$(( ( $(date +%s) - started_at ) / 60 + 2 ))
    log "worker drained and stopped after ~$(( elapsed_min - 2 ))m"

    # A kind passes if it SUCCEEDED during this run, or was not due (its last
    # success is younger than its interval — e.g. two runs in the same hour).
    # Anything else was due, ran or should have, and did not succeed.
    local health
    health=$(job_health)
    echo "$health" | jq -r --argjson run "$elapsed_min" '
        .data.jobHealth[]
        | [ .kind,
            (if .ageMinutes == null then "never"
             elif .ageMinutes <= $run then "ok (this run)"
             elif .ageMinutes < .expectedEveryMinutes then "ok (not due)"
             else "FAILED — last success \(.ageMinutes)m ago" end) ]
        | @tsv' | column -t -s $'\t' >&2

    local failed
    failed=$(echo "$health" | jq -r --argjson run "$elapsed_min" '
        [.data.jobHealth[]
         | select(.ageMinutes == null or (.ageMinutes > $run and .ageMinutes >= .expectedEveryMinutes))
         | .kind] | join(", ")')
    [ -z "$failed" ] || die "job(s) did not succeed: $failed — see: $FLY logs -a $APP"
    log "collection complete"
}

cleanup() {
    local code=$?
    if [ "${KEEP_DB:-0}" = 1 ]; then
        log "KEEP_DB=1: leaving the database running"
    else
        # Never stop the database under a worker that is still writing.
        workers_stopped || stop_workers
        db_down
    fi
    exit "$code"
}

command -v jq >/dev/null || die "jq is required"
command -v "$FLY" >/dev/null || die "$FLY is required"
# In CI the api token alone would fall through to the database calls and fail
# with an opaque auth error; say what is actually missing.
if [ -n "${FLY_API_TOKEN:-}" ] && [ -z "${FLY_DB_TOKEN:-}" ]; then
    die "FLY_API_TOKEN is set but FLY_DB_TOKEN is not — the database app needs its own token"
fi

case "${1:-}" in
    run) run ;;
    db-up) db_up ;;
    db-down) db_down ;;
    db-state) db_state ;;
    *) sed -n '2,/^set -euo/p' "$0" | sed '$d' >&2; exit 2 ;;
esac
