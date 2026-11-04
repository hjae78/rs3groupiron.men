-- AlterTable
ALTER TABLE "players" ADD COLUMN     "tracking_id_hash" TEXT;

-- AlterTable
ALTER TABLE "player_verification_tokens" ADD COLUMN     "tracking_id_hash" TEXT;

-- CreateIndex
CREATE INDEX "players_username_key_tracking_id_hash_idx" ON "players"("username_key", "tracking_id_hash");
