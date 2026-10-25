import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_favorite" RENAME TO "asset_user_state";`.execute(db);
  await sql`ALTER TABLE "asset_user_state" RENAME CONSTRAINT "asset_favorite_userId_fkey" TO "asset_user_state_userId_fkey";`.execute(db);
  await sql`ALTER TABLE "asset_user_state" RENAME CONSTRAINT "asset_favorite_assetId_fkey" TO "asset_user_state_assetId_fkey";`.execute(db);
  await sql`ALTER TABLE "asset_user_state" RENAME CONSTRAINT "asset_favorite_pkey" TO "asset_user_state_pkey";`.execute(db);
  await sql`ALTER INDEX "asset_favorite_assetId_idx" RENAME TO "asset_user_state_assetId_idx";`.execute(db);
  await sql`ALTER TABLE "asset_user_state"
  ADD COLUMN "isFavorite" boolean NOT NULL DEFAULT false,
  ADD COLUMN "rating" smallint,
  ADD COLUMN "colorLabel" text,
  ADD COLUMN "updatedAt" timestamp with time zone NOT NULL DEFAULT now();`.execute(db);
  // every pre-existing row was a favorite
  await sql`UPDATE "asset_user_state" SET "isFavorite" = true;`.execute(db);
  await sql`ALTER TABLE "asset_user_state" ADD CONSTRAINT "asset_user_state_rating_chk" CHECK ("rating" BETWEEN 1 AND 5);`.execute(db);
  await sql`ALTER TABLE "asset_user_state" ADD CONSTRAINT "asset_user_state_colorLabel_chk" CHECK ("colorLabel" IN ('red','yellow','green','blue','purple'));`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // rows that only hold a rating or color are not favorites; drop them before reverting
  await sql`DELETE FROM "asset_user_state" WHERE "isFavorite" = false;`.execute(db);
  await sql`ALTER TABLE "asset_user_state" DROP CONSTRAINT "asset_user_state_colorLabel_chk";`.execute(db);
  await sql`ALTER TABLE "asset_user_state" DROP CONSTRAINT "asset_user_state_rating_chk";`.execute(db);
  await sql`ALTER TABLE "asset_user_state" DROP COLUMN "updatedAt", DROP COLUMN "colorLabel", DROP COLUMN "rating", DROP COLUMN "isFavorite";`.execute(db);
  await sql`ALTER INDEX "asset_user_state_assetId_idx" RENAME TO "asset_favorite_assetId_idx";`.execute(db);
  await sql`ALTER TABLE "asset_user_state" RENAME CONSTRAINT "asset_user_state_pkey" TO "asset_favorite_pkey";`.execute(db);
  await sql`ALTER TABLE "asset_user_state" RENAME CONSTRAINT "asset_user_state_assetId_fkey" TO "asset_favorite_assetId_fkey";`.execute(db);
  await sql`ALTER TABLE "asset_user_state" RENAME CONSTRAINT "asset_user_state_userId_fkey" TO "asset_favorite_userId_fkey";`.execute(db);
  await sql`ALTER TABLE "asset_user_state" RENAME TO "asset_favorite";`.execute(db);
}
