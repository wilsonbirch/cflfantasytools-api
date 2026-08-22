-- AlterTable
ALTER TABLE "Game" ADD COLUMN     "awayGeniusTeamId" TEXT,
ADD COLUMN     "homeGeniusTeamId" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Game_homeGeniusTeamId_idx" ON "Game"("homeGeniusTeamId");

-- CreateIndex
CREATE INDEX "Game_awayGeniusTeamId_idx" ON "Game"("awayGeniusTeamId");

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_homeGeniusTeamId_fkey" FOREIGN KEY ("homeGeniusTeamId") REFERENCES "Team"("geniusTeamId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_awayGeniusTeamId_fkey" FOREIGN KEY ("awayGeniusTeamId") REFERENCES "Team"("geniusTeamId") ON DELETE SET NULL ON UPDATE CASCADE;
