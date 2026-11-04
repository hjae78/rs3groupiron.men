-- CreateEnum
CREATE TYPE "PlayerVerificationStatus" AS ENUM ('unverified', 'plugin_verified');

-- CreateTable
CREATE TABLE "players" (
    "id" TEXT NOT NULL,
    "current_username" TEXT NOT NULL,
    "username_key" TEXT NOT NULL,
    "verification_status" "PlayerVerificationStatus" NOT NULL DEFAULT 'unverified',
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_username_history" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_username_history_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "members" ADD COLUMN     "player_id" TEXT;

-- CreateIndex
CREATE INDEX "players_username_key_idx" ON "players"("username_key");

-- CreateIndex: only a *verified* player exclusively owns a username; several
-- unverified players may still share one until someone actually verifies it.
CREATE UNIQUE INDEX "players_verified_username_key" ON "players"("username_key") WHERE "verification_status" = 'plugin_verified';

-- CreateIndex
CREATE INDEX "player_username_history_player_id_idx" ON "player_username_history"("player_id");

-- CreateIndex
CREATE INDEX "members_player_id_idx" ON "members"("player_id");

-- AddForeignKey
ALTER TABLE "player_username_history" ADD CONSTRAINT "player_username_history_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;
