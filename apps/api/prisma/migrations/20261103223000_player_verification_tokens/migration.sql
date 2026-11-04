-- CreateTable
CREATE TABLE "player_verification_tokens" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "player_verification_tokens_token_hash_idx" ON "player_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "player_verification_tokens_player_id_idx" ON "player_verification_tokens"("player_id");

-- AddForeignKey
ALTER TABLE "player_verification_tokens" ADD CONSTRAINT "player_verification_tokens_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;
