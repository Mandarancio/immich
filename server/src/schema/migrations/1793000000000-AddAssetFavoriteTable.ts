import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_favorite" (
  "userId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_favorite_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_favorite_pkey" PRIMARY KEY ("userId", "assetId")
);`.execute(db);
  await sql`CREATE INDEX "asset_favorite_assetId_idx" ON "asset_favorite" ("assetId");`.execute(db);
  // import the legacy favorites (including archived and trashed assets) as owner rows; the asset column stays
  // authoritative for owned assets, these rows only mirror it
  await sql`INSERT INTO "asset_favorite" ("userId", "assetId")
SELECT "ownerId", "id" FROM "asset" WHERE "isFavorite" = true
ON CONFLICT DO NOTHING;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_favorite";`.execute(db);
}
