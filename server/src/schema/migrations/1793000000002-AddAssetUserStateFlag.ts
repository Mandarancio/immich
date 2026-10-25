import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_user_state" ADD COLUMN "flag" text;`.execute(db);
  await sql`ALTER TABLE "asset_user_state" ADD CONSTRAINT "asset_user_state_flag_chk" CHECK ("flag" IN ('pick','reject'));`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_user_state" DROP CONSTRAINT "asset_user_state_flag_chk";`.execute(db);
  await sql`ALTER TABLE "asset_user_state" DROP COLUMN "flag";`.execute(db);
  // rows that only carried a flag are now empty
  await sql`DELETE FROM "asset_user_state" WHERE "isFavorite" = false AND "rating" IS NULL AND "colorLabel" IS NULL;`.execute(db);
}
