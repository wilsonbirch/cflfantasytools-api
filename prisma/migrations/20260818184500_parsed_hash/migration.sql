-- Replaces the updatedAt > parsedAt staleness test, which could never be false:
-- writing parsedAt bumps updatedAt on the same row, so every game looked stale
-- on every run.
ALTER TABLE "Game" ADD COLUMN "parsedHash" TEXT;

-- Backfill already-parsed games so this change does not trigger one needless
-- full re-parse of the corpus.
UPDATE "Game" SET "parsedHash" = md5("response") WHERE "parsedAt" IS NOT NULL;
