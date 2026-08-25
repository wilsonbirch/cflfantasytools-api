-- Lost fumbles, parsed from play text (parser v3 re-parses every stored game).
ALTER TABLE "Play" ADD COLUMN "fumbleLostBy" TEXT;

-- Projected lost fumbles per game; rows fitted before this existed read 0.
ALTER TABLE "Projection" ADD COLUMN "fumblesLost" DOUBLE PRECISION NOT NULL DEFAULT 0;
