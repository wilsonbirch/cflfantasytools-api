-- CreateTable
CREATE TABLE "Projection" (
    "id" SERIAL NOT NULL,
    "playerId" INTEGER NOT NULL,
    "gameweekId" INTEGER NOT NULL,
    "fittedAt" TIMESTAMP(3) NOT NULL,
    "opponentTeamId" INTEGER,
    "alignment" TEXT,
    "games" INTEGER NOT NULL,
    "passAttempts" DOUBLE PRECISION NOT NULL,
    "passingYards" DOUBLE PRECISION NOT NULL,
    "passingTouchdowns" DOUBLE PRECISION NOT NULL,
    "interceptions" DOUBLE PRECISION NOT NULL,
    "rushAttempts" DOUBLE PRECISION NOT NULL,
    "rushingYards" DOUBLE PRECISION NOT NULL,
    "rushingTouchdowns" DOUBLE PRECISION NOT NULL,
    "targets" DOUBLE PRECISION NOT NULL,
    "receptions" DOUBLE PRECISION NOT NULL,
    "receivingYards" DOUBLE PRECISION NOT NULL,
    "receivingTouchdowns" DOUBLE PRECISION NOT NULL,
    "epa" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Projection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Projection_gameweekId_fittedAt_idx" ON "Projection"("gameweekId", "fittedAt");

-- CreateIndex
CREATE INDEX "Projection_playerId_gameweekId_idx" ON "Projection"("playerId", "gameweekId");

-- AddForeignKey
ALTER TABLE "Projection" ADD CONSTRAINT "Projection_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Projection" ADD CONSTRAINT "Projection_gameweekId_fkey" FOREIGN KEY ("gameweekId") REFERENCES "Gameweek"("id") ON DELETE CASCADE ON UPDATE CASCADE;
