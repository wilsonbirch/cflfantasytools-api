# cflfantasytools-api

Backend API for cflfantasytools — GraphQL (Pothos + graphql-yoga) over Prisma/Postgres,
with a database-backed job queue and the CFL depth-chart scrapers.

This is the only service that talks to the database. `cflfantasytools-web` and
`cflfantasytools-native` are GraphQL clients; the contract between them is the
committed `schema.graphql` snapshot, which CI fails on if it drifts.

## Getting started

```bash
cp .env.example .env          # fill in DATABASE_URL and AUTH_JWT_SECRET
npm install                   # postinstall runs `prisma generate`
npx prisma migrate deploy
npm run db:seed               # 9 teams + their depth-chart scrape config
npm run dev                   # http://localhost:4000/graphql
npm run dev:worker            # job worker, in a second shell
```

## Checks

Run all of these before opening a PR — they mirror the five CI jobs exactly.

| Command                                                       | Catches                                      |
| ------------------------------------------------------------- | -------------------------------------------- |
| `npm run lint` / `npm run format:check`                       | style, unused vars                           |
| `npm run typecheck`                                           | whole-program type errors                    |
| `npm run schema:print && git diff --exit-code schema.graphql` | SDL drift — breaks web + native codegen      |
| `npm run test:coverage`                                       | unit + integration (Testcontainers Postgres) |
| `npm run boot-smoke` / `npm run boot-smoke:worker`            | boot failures and the SIGTERM contract       |
| `docker build -t cflfantasytools-api:ci .`                    | image assembly, incl. the Chromium install   |

Integration tests need a running Docker daemon; they spin up their own Postgres
and refuse any database whose name doesn't end in `_test`.

## Deploying

⚠️ **Create the apps in the `personal` org explicitly.** The global Fly login
(`wilsonbirch@gmail.com`) also has access to `onereview-898`, and this folder has
no `.envrc` scoping it to anything else — so an unqualified `fly apps create`
can put these apps in the OneReview org by mistake.

One environment, deliberately — this is a personal project with a single
operator, and a dev/prod split would double the cost and deploy ceremony for
no one's benefit.

```bash
fly apps create cflfantasytools-api --org personal
fly postgres create --name cflfantasytools-db --org personal
fly postgres attach cflfantasytools-db --app cflfantasytools-api

fly secrets import < .fly.secrets.env
fly deploy
```

### Deploys are automatic

`.github/workflows/deploy.yml` runs on every push to `main`: it applies pending
migrations through a proxy, runs `fly deploy`, then polls `/health` until the
new release answers. `workflow_dispatch` re-runs it by hand.

It carries no test jobs. `main` requires the five CI contexts and has `strict`
on, so a commit only lands after that exact tree went green on its PR.
Re-testing here would be byte-identical duplication. **Remove those required checks and
this workflow becomes unguarded**, and the suite has to move back into it.

Two repo secrets feed it:

| Secret          | What                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `FLY_API_TOKEN` | Two app-scoped deploy tokens, comma-joined — one for the API, one for the database. Deliberately not an org token. |
| `DATABASE_URL`  | The `.flycast` URL with its host swapped for `127.0.0.1:15432`.                                                    |

⚠️ **Keep migrations additive.** Between the migrate step and the machines
finishing their roll, the OLD code is live against the NEW schema. A migration
that drops or renames a column the running release still reads will break
production for the length of the deploy. Additive now, destructive in a later
release once nothing reads the old shape.

Rolling back is `fly releases` to find the version, then
`fly deploy --image <previous image>` — note that a rollback does NOT undo a
migration, which is the other reason to keep them additive.

### Applying a migration

Migrations run from a workstation through a proxy, since the runtime image
carries no Prisma CLI. The database and the role are both named
`cflfantasytools_api` — `fly postgres attach` names them after the app.

The password is not recoverable from `fly secrets list`, which prints digests
only. Read it off a running machine instead, where it is an ordinary env var:

```bash
fly ssh console -a cflfantasytools-api -C "printenv DATABASE_URL"
# postgres://cflfantasytools_api:PASSWORD@cflfantasytools-db.flycast:5432/cflfantasytools_api?sslmode=disable
```

Swap the host for the proxy and keep `?sslmode=disable` — the proxy is a plain
TCP tunnel and the server does not offer TLS on it:

```bash
fly proxy 15432:5432 -a cflfantasytools-db &
npx prisma migrate status                      # confirm what is pending
npx prisma migrate deploy
npx prisma migrate status                      # "Database schema is up to date!"
kill %1                                        # close the tunnel when done
```

⚠️ **`migrate deploy`, never `migrate dev`.** `deploy` only applies pending
migrations; `dev` diffs the schema and will offer to reset the database.

⚠️ **A `.env` holding the proxy URL points at production.** Only the port digit
separates it from a local database, so while the tunnel is up, `db:seed`,
`db:studio` and `db:migrate` all hit prod. Prefer passing the URL inline, or
keep it in a `.env.prod` you source deliberately:

```bash
DATABASE_URL="postgres://cflfantasytools_api:PASSWORD@127.0.0.1:15432/cflfantasytools_api?sslmode=disable" \
  npx prisma migrate deploy
```

Review the SQL before applying. Additive changes — new tables, nullable columns,
new enums — are safe to apply while `web` serves traffic; Postgres adds a
`NOT NULL DEFAULT` column as metadata only, without rewriting the table. A
non-concurrent `CREATE INDEX` locks the table against writes while it builds,
which is fine at this size but will not stay fine.

Two process groups run from one image: `web` (GraphQL + `/health`) and `worker`.

The worker runs **always-on** (`WORKER_IDLE_EXIT_MS=0`) because it keeps its own
recurring schedule in-process. A Fly machine schedule was the alternative, but
one silently stopped firing for five days on another project here — and a
capture job that stops silently is how the 2025 season was lost. Its VM is 1GB
rather than 512MB because it launches Chromium for club sites that need JS.

## Layout

```
prisma/schema.prisma     the only schema in the project
src/builder.ts           Pothos builder + the isUp probe
src/context.ts           bearer token -> AuthContext (null when anonymous)
src/lib/auth.server.ts   signs/verifies our own tokens; refresh-token hashing
src/lib/guards.server.ts requireAuth / requireAdmin — the ONLY security boundary
src/dao/                 Prisma access
src/schemas/             Pothos type + field modules, one per domain
src/services/            business logic
src/worker/              job loop, schedule rules, handlers
src/data/teams.ts        the nine clubs and their three id spaces
```

### A note on team identifiers

Three 1-to-9-ish id spaces exist and **none are interchangeable**:

|                                       | Ottawa | Saskatchewan |
| ------------------------------------- | ------ | ------------ |
| our `Team.id`                         | 9      | 1            |
| `gameZoneSquadId` (public JSON feeds) | 1      | 8            |
| `geniusTeamId` (play-by-play)         | 88019  | 106752       |

Always map through `abbreviation`. `test/unit/teams.test.ts` fails if anyone
"simplifies" this.
