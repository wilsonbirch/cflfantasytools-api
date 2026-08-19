-- CreateTable
CREATE TABLE "EpValue" (
    "id" SERIAL NOT NULL,
    "ruleEra" "RuleEra" NOT NULL,
    "down" INTEGER NOT NULL,
    "distanceBucket" TEXT NOT NULL,
    "yardLineBucket" INTEGER NOT NULL,
    "expectedPoints" DOUBLE PRECISION NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "fittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EpValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EpValue_ruleEra_idx" ON "EpValue"("ruleEra");

-- CreateIndex
CREATE UNIQUE INDEX "EpValue_ruleEra_down_distanceBucket_yardLineBucket_key" ON "EpValue"("ruleEra", "down", "distanceBucket", "yardLineBucket");
