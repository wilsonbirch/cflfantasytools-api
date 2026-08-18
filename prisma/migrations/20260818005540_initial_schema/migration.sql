-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ScrapeStatus" AS ENUM ('OK', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "Account" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "accountId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "rotatedFromId" INTEGER,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameFr" TEXT,
    "shortName" TEXT,
    "city" TEXT,
    "geniusTeamId" TEXT,
    "gameZoneSquadId" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamSource" (
    "id" SERIAL NOT NULL,
    "teamId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'depth-chart',
    "url" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "requiresBrowser" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastItemCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationSubscription" (
    "id" SERIAL NOT NULL,
    "accountId" INTEGER NOT NULL,
    "teamId" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepthChartList" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "teamId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "value" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepthChartList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepthChart" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "teamId" INTEGER NOT NULL,
    "depthChartListId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "season" TEXT NOT NULL,
    "week" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepthChart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScrapeRun" (
    "id" SERIAL NOT NULL,
    "teamId" INTEGER NOT NULL,
    "status" "ScrapeStatus" NOT NULL,
    "itemCount" INTEGER,
    "addedCount" INTEGER,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ScrapeRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDelivery" (
    "id" SERIAL NOT NULL,
    "accountId" INTEGER,
    "kind" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "resendId" TEXT,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "batchKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Game" (
    "id" INTEGER NOT NULL,
    "uuid" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Drive" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "gameId" INTEGER NOT NULL,
    "geniusTeamId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "isScoring" BOOLEAN NOT NULL DEFAULT false,
    "points" INTEGER,
    "nextPointOutcome" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Drive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Play" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "gameId" INTEGER NOT NULL,
    "geniusTeamId" TEXT NOT NULL,
    "driveId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "subtype" TEXT,
    "description" TEXT NOT NULL,
    "clock" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "phase" TEXT NOT NULL,
    "phaseQualifier" TEXT NOT NULL,
    "isScoring" BOOLEAN NOT NULL DEFAULT false,
    "startPosition" TEXT NOT NULL,
    "endPosition" TEXT,
    "down" INTEGER,
    "distance" TEXT,
    "yardLine" INTEGER,
    "kicker" TEXT,
    "passer" TEXT,
    "rusher" TEXT,
    "receiver" TEXT,
    "defense" TEXT,
    "yardsGained" INTEGER,
    "puntYards" INTEGER,
    "returnYards" INTEGER,
    "epa" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Play_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_uuid_key" ON "Account"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "Account_email_key" ON "Account"("email");

-- CreateIndex
CREATE INDEX "Account_role_idx" ON "Account"("role");

-- CreateIndex
CREATE UNIQUE INDEX "Session_uuid_key" ON "Session"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_accountId_revokedAt_idx" ON "Session"("accountId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Team_uuid_key" ON "Team"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "Team_slug_key" ON "Team"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Team_abbreviation_key" ON "Team"("abbreviation");

-- CreateIndex
CREATE UNIQUE INDEX "Team_geniusTeamId_key" ON "Team"("geniusTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_gameZoneSquadId_key" ON "Team"("gameZoneSquadId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamSource_teamId_kind_key" ON "TeamSource"("teamId", "kind");

-- CreateIndex
CREATE INDEX "NotificationSubscription_teamId_enabled_idx" ON "NotificationSubscription"("teamId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationSubscription_accountId_teamId_key" ON "NotificationSubscription"("accountId", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "DepthChartList_uuid_key" ON "DepthChartList"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "DepthChartList_teamId_year_key" ON "DepthChartList"("teamId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "DepthChart_uuid_key" ON "DepthChart"("uuid");

-- CreateIndex
CREATE INDEX "DepthChart_teamId_year_idx" ON "DepthChart"("teamId", "year");

-- CreateIndex
CREATE INDEX "ScrapeRun_teamId_startedAt_idx" ON "ScrapeRun"("teamId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDelivery_resendId_key" ON "EmailDelivery"("resendId");

-- CreateIndex
CREATE INDEX "EmailDelivery_batchKey_idx" ON "EmailDelivery"("batchKey");

-- CreateIndex
CREATE INDEX "EmailDelivery_status_idx" ON "EmailDelivery"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Game_uuid_key" ON "Game"("uuid");

-- CreateIndex
CREATE INDEX "Game_year_idx" ON "Game"("year");

-- CreateIndex
CREATE UNIQUE INDEX "Drive_uuid_key" ON "Drive"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "Drive_gameId_number_key" ON "Drive"("gameId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Play_uuid_key" ON "Play"("uuid");

-- CreateIndex
CREATE INDEX "Play_type_down_idx" ON "Play"("type", "down");

-- CreateIndex
CREATE UNIQUE INDEX "Play_gameId_driveId_number_key" ON "Play"("gameId", "driveId", "number");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE INDEX "Job_kind_createdAt_idx" ON "Job"("kind", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamSource" ADD CONSTRAINT "TeamSource_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepthChartList" ADD CONSTRAINT "DepthChartList_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepthChart" ADD CONSTRAINT "DepthChart_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepthChart" ADD CONSTRAINT "DepthChart_depthChartListId_fkey" FOREIGN KEY ("depthChartListId") REFERENCES "DepthChartList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScrapeRun" ADD CONSTRAINT "ScrapeRun_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Drive" ADD CONSTRAINT "Drive_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Drive" ADD CONSTRAINT "Drive_geniusTeamId_fkey" FOREIGN KEY ("geniusTeamId") REFERENCES "Team"("geniusTeamId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Play" ADD CONSTRAINT "Play_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Play" ADD CONSTRAINT "Play_driveId_fkey" FOREIGN KEY ("driveId") REFERENCES "Drive"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Play" ADD CONSTRAINT "Play_geniusTeamId_fkey" FOREIGN KEY ("geniusTeamId") REFERENCES "Team"("geniusTeamId") ON DELETE CASCADE ON UPDATE CASCADE;
