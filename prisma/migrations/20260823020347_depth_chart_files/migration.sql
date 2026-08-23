-- AlterTable
ALTER TABLE "ScrapeRun" ADD COLUMN     "revisedCount" INTEGER;

-- CreateTable
CREATE TABLE "DepthChartFile" (
    "id" SERIAL NOT NULL,
    "depthChartId" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "contentType" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepthChartFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DepthChartFile_depthChartId_fetchedAt_idx" ON "DepthChartFile"("depthChartId", "fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DepthChartFile_depthChartId_sha256_key" ON "DepthChartFile"("depthChartId", "sha256");

-- AddForeignKey
ALTER TABLE "DepthChartFile" ADD CONSTRAINT "DepthChartFile_depthChartId_fkey" FOREIGN KEY ("depthChartId") REFERENCES "DepthChart"("id") ON DELETE CASCADE ON UPDATE CASCADE;
