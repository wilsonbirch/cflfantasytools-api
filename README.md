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

```bash
fly apps create cflfantasytools-api-dev  --org personal
fly apps create cflfantasytools-api-prod --org personal

fly postgres create --name cflfantasytools-db-dev --org personal
fly postgres attach cflfantasytools-db-dev --app cflfantasytools-api-dev

fly secrets import --config fly.dev.toml < .fly.secrets.env
fly deploy --config fly.dev.toml
```

Two process groups run from one image: `web` (GraphQL + `/health`) and `worker`
(drains the `Job` table, then exits 0 so the machine stops). The worker VM is
1GB rather than 512MB because it launches Chromium for the club sites that need
JS — 512MB OOMs under Puppeteer.

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
