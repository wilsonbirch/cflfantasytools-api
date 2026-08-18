-- CreateEnum
CREATE TYPE "RuleEra" AS ENUM ('PRE_2026', 'E2026', 'E2027');

-- CreateEnum
CREATE TYPE "PassDepth" AS ENUM ('SHORT', 'DEEP');

-- CreateEnum
CREATE TYPE "PassDirection" AS ENUM ('LEFT', 'MIDDLE', 'RIGHT');

-- AlterTable
ALTER TABLE "Drive" ADD COLUMN     "startQuarter" INTEGER;

-- AlterTable
ALTER TABLE "Game" ADD COLUMN     "parsedAt" TIMESTAMP(3),
ADD COLUMN     "playCount" INTEGER,
ADD COLUMN     "ruleEra" "RuleEra";

-- AlterTable
ALTER TABLE "Play" ADD COLUMN     "airYards" INTEGER,
ADD COLUMN     "brokenUpBy" TEXT,
ADD COLUMN     "formation" TEXT,
ADD COLUMN     "isComplete" BOOLEAN,
ADD COLUMN     "isFirstDown" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isNoPlay" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isTurnover" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kickDistance" INTEGER,
ADD COLUMN     "kickIsGood" BOOLEAN,
ADD COLUMN     "penaltyName" TEXT,
ADD COLUMN     "penaltyTeam" TEXT,
ADD COLUMN     "penaltyYards" INTEGER,
ADD COLUMN     "points" INTEGER,
ADD COLUMN     "returner" TEXT,
ADD COLUMN     "ruleEra" "RuleEra",
ADD COLUMN     "targetDepth" "PassDepth",
ADD COLUMN     "targetDirection" "PassDirection",
ADD COLUMN     "yardsAfterCatch" INTEGER;

-- CreateIndex
CREATE INDEX "Game_parsedAt_idx" ON "Game"("parsedAt");

-- CreateIndex
CREATE INDEX "Play_ruleEra_targetDepth_targetDirection_idx" ON "Play"("ruleEra", "targetDepth", "targetDirection");

-- CreateIndex
CREATE INDEX "Play_receiver_idx" ON "Play"("receiver");

-- CreateIndex
CREATE INDEX "Play_passer_idx" ON "Play"("passer");

-- CreateIndex
CREATE INDEX "Play_rusher_idx" ON "Play"("rusher");
