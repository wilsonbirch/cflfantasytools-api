-- CreateEnum
CREATE TYPE "FeedStatus" AS ENUM ('OK', 'UNCHANGED', 'INVALID', 'FETCH_FAILED');

-- CreateEnum
CREATE TYPE "PlayerPosition" AS ENUM ('QUARTERBACK', 'RUNNING_BACK', 'WIDE_RECEIVER', 'OTHER');

-- CreateTable
CREATE TABLE "FeedSnapshot" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" "FeedStatus" NOT NULL,
    "payload" JSONB,
    "error" TEXT,
    "itemCount" INTEGER,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Player" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "gameZoneId" INTEGER NOT NULL,
    "feedId" INTEGER,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "teamId" INTEGER,
    "position" "PlayerPosition" NOT NULL DEFAULT 'OTHER',
    "status" TEXT,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "injuredTextEn" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "missedSyncs" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerStatSnapshot" (
    "id" SERIAL NOT NULL,
    "playerId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "cost" INTEGER,
    "avgPoints" DOUBLE PRECISION,
    "projectedScores" DOUBLE PRECISION,
    "weekSalaryChange" INTEGER,
    "totalPoints" DOUBLE PRECISION,
    "stats" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerStatSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gameweek" (
    "id" SERIAL NOT NULL,
    "gameZoneId" INTEGER NOT NULL,
    "feedId" INTEGER,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Gameweek_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" SERIAL NOT NULL,
    "gameZoneId" INTEGER NOT NULL,
    "gameweekId" INTEGER NOT NULL,
    "homeTeamId" INTEGER,
    "awayTeamId" INTEGER,
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "status" TEXT NOT NULL,
    "venue" TEXT,
    "date" TIMESTAMP(3),
    "year" INTEGER NOT NULL,
    "geniusFixtureId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerGameweekPoints" (
    "id" SERIAL NOT NULL,
    "playerId" INTEGER NOT NULL,
    "gameweekId" INTEGER NOT NULL,
    "matchId" INTEGER,
    "points" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PlayerGameweekPoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeedSnapshot_source_fetchedAt_idx" ON "FeedSnapshot"("source", "fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Player_uuid_key" ON "Player"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "Player_gameZoneId_key" ON "Player"("gameZoneId");

-- CreateIndex
CREATE INDEX "Player_teamId_position_idx" ON "Player"("teamId", "position");

-- CreateIndex
CREATE INDEX "Player_lastName_idx" ON "Player"("lastName");

-- CreateIndex
CREATE INDEX "PlayerStatSnapshot_playerId_capturedAt_idx" ON "PlayerStatSnapshot"("playerId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Gameweek_gameZoneId_key" ON "Gameweek"("gameZoneId");

-- CreateIndex
CREATE INDEX "Gameweek_year_idx" ON "Gameweek"("year");

-- CreateIndex
CREATE UNIQUE INDEX "Match_gameZoneId_key" ON "Match"("gameZoneId");

-- CreateIndex
CREATE UNIQUE INDEX "Match_geniusFixtureId_key" ON "Match"("geniusFixtureId");

-- CreateIndex
CREATE INDEX "Match_year_date_idx" ON "Match"("year", "date");

-- CreateIndex
CREATE INDEX "PlayerGameweekPoints_gameweekId_idx" ON "PlayerGameweekPoints"("gameweekId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerGameweekPoints_playerId_gameweekId_key" ON "PlayerGameweekPoints"("playerId", "gameweekId");

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerStatSnapshot" ADD CONSTRAINT "PlayerStatSnapshot_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_gameweekId_fkey" FOREIGN KEY ("gameweekId") REFERENCES "Gameweek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_homeTeamId_fkey" FOREIGN KEY ("homeTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_awayTeamId_fkey" FOREIGN KEY ("awayTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerGameweekPoints" ADD CONSTRAINT "PlayerGameweekPoints_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerGameweekPoints" ADD CONSTRAINT "PlayerGameweekPoints_gameweekId_fkey" FOREIGN KEY ("gameweekId") REFERENCES "Gameweek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerGameweekPoints" ADD CONSTRAINT "PlayerGameweekPoints_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE SET NULL ON UPDATE CASCADE;
