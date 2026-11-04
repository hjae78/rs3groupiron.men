-- AlterTable
ALTER TABLE "players" ADD COLUMN     "deletion_requested_at" TIMESTAMP(3),
ADD COLUMN     "delete_after" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "players_delete_after_idx" ON "players"("delete_after");
