-- Finalizes Member.playerId as a required relation, now that every creation
-- path (addGroupMember, the dev/demo seed, and the Phase 1+2 backfill) sets
-- it. Validated against a copy of production data before being applied here
-- (SELECT count(*) FROM members WHERE player_id IS NULL must be 0 first).

ALTER TABLE "members" ALTER COLUMN "player_id" SET NOT NULL;

-- SET NULL is invalid against a NOT NULL column (Postgres would only surface
-- that as a runtime error the next time a Player was deleted), so the FK
-- action must change alongside the column. RESTRICT, not CASCADE: a Player
-- must have its Members explicitly cleared first (see
-- PlayerDeletionService.deleteMyData), so deleting one can never silently
-- wipe out group memberships as a side effect.
ALTER TABLE "members" DROP CONSTRAINT "members_player_id_fkey";
ALTER TABLE "members" ADD CONSTRAINT "members_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
