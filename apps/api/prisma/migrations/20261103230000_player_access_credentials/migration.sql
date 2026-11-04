-- CreateTable
CREATE TABLE "player_access_credentials" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['portal']::TEXT[],
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_access_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "player_access_credentials_token_hash_idx" ON "player_access_credentials"("token_hash");

-- CreateIndex
CREATE INDEX "player_access_credentials_player_id_idx" ON "player_access_credentials"("player_id");

-- AddForeignKey
ALTER TABLE "player_access_credentials" ADD CONSTRAINT "player_access_credentials_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;
