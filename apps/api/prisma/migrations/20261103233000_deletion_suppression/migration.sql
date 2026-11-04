-- CreateTable
CREATE TABLE "deletion_suppressions" (
    "id" TEXT NOT NULL,
    "username_key_hash" TEXT NOT NULL,
    "suppressed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cooldown_until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deletion_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deletion_suppressions_username_key_hash_idx" ON "deletion_suppressions"("username_key_hash");
