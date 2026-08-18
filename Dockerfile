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

# --ignore-scripts skips postinstall (the prisma CLI is a devDep and absent here);
# the generated client is copied from the build stage instead.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./

USER node
EXPOSE 4000
CMD ["node", "--import", "tsx", "src/index.ts"]
