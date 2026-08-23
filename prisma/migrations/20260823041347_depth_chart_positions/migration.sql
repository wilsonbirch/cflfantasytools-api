-- CreateEnum
CREATE TYPE "DepthChartParseStatus" AS ENUM ('OK', 'UNSUPPORTED', 'FAILED');

-- AlterTable
ALTER TABLE "DepthChart" ADD COLUMN     "parseError" TEXT,
ADD COLUMN     "parseStatus" "DepthChartParseStatus",
ADD COLUMN     "parsedFileId" INTEGER;

-- CreateTable
CREATE TABLE "DepthChartPosition" (
    "id" SERIAL NOT NULL,
    "depthChartId" INTEGER NOT NULL,
    "teamId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "position" TEXT NOT NULL,
    "player" TEXT NOT NULL,
    "jersey" INTEGER,
    "depth" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepthChartPosition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DepthChartPosition_teamId_year_idx" ON "DepthChartPosition"("teamId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "DepthChartPosition_depthChartId_position_depth_key" ON "DepthChartPosition"("depthChartId", "position", "depth");

-- AddForeignKey
ALTER TABLE "DepthChartPosition" ADD CONSTRAINT "DepthChartPosition_depthChartId_fkey" FOREIGN KEY ("depthChartId") REFERENCES "DepthChart"("id") ON DELETE CASCADE ON UPDATE CASCADE;
