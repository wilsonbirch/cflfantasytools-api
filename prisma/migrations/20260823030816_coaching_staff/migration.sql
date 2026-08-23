-- CreateEnum
CREATE TYPE "CoachingRole" AS ENUM ('HC', 'OC', 'DC');

-- CreateTable
CREATE TABLE "CoachingStaff" (
    "id" SERIAL NOT NULL,
    "teamId" INTEGER NOT NULL,
    "role" "CoachingRole" NOT NULL,
    "person" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachingStaff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoachingStaff_teamId_effectiveFrom_idx" ON "CoachingStaff"("teamId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "CoachingStaff_teamId_role_person_effectiveFrom_key" ON "CoachingStaff"("teamId", "role", "person", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "CoachingStaff" ADD CONSTRAINT "CoachingStaff_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
