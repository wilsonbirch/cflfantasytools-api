# syntax=docker/dockerfile:1

# --- Build stage: full install so postinstall's `prisma generate` (which needs
#     the prisma CLI, a devDep) can emit the client into src/generated ---
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Deps first for layer caching. prisma.config.ts + the schema are needed by the
# postinstall generate.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

COPY . .

# --- Runtime stage: prod-only deps, the generated client, and Chromium ---
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Chromium for the depth-chart scraper. Most clubs' pages are parsed with a
# plain fetch + linkedom; only the ones that need JS launch a browser, but the
# worker and web share one image so it must be present.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# --ignore-scripts skips postinstall: the prisma CLI is present now, but the
# generated client is copied from the build stage rather than re-generated.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./

# The Fly release command runs `prisma migrate deploy` from this image, so the
# migration history and the config that carries DATABASE_URL to the CLI have to
# be here. `prisma` and `dotenv` are runtime deps for the same reason — the
# schema is driver-adapter based and holds no url of its own.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./

# The schema engine `migrate deploy` needs. --ignore-scripts above skipped the
# download, and the CLI cannot fetch it at release time: it runs as USER node
# against a root-owned /app, and a deploy should not depend on the network
# reaching Prisma's CDN anyway. Taken from the build stage, which did download it.
COPY --from=build /app/node_modules/@prisma/engines ./node_modules/@prisma/engines

# The CLI refuses to start if it cannot write here, even when the engine is
# already in place — it checks the directory before deciding it needs nothing.
RUN chown -R node:node /app/node_modules/@prisma/engines

USER node
EXPOSE 4000
CMD ["node", "--import", "tsx", "src/index.ts"]
