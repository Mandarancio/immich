# Per-User Rating, Color Labels and Quick Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every user keep a private rating and color label per asset (including assets they do not own), and quickly filter every timeline view and search by favorite, rating and color.

**Architecture:** `asset_favorite` is renamed to `asset_user_state` and gains `isFavorite`, `rating`, `colorLabel`, `updatedAt`. `asset.isFavorite` and `asset_exif.rating` stay authoritative for owned assets (sync, Android, XMP keep working). Non-owners store favorite and rating in the table; color is table-only for everybody. Read paths use viewer-aware Kysely helpers (`isFavoriteFor`, `ratingFor`, `colorLabelFor`). The existing update endpoints accept state-only requests from anyone with `AssetRead`. The web gets a shared timeline filter bar, an editable rating, a color picker, thumbnail badges, bulk actions and shortcuts.

**Tech Stack:** NestJS, Kysely/Postgres, `@immich/sql-tools`, zod DTOs, vitest (unit, medium with testcontainers), SvelteKit 5 (runes), supertest e2e.

Spec: `docs/superpowers/specs/2026-10-25-per-user-rating-color-filters-design.md`. Builds on the `asset_favorite` work already on this branch.

## Global Constraints

- Server + web only. No changes to `server/src/repositories/sync.repository.ts`, sync DTOs or mobile (the mobile OpenAPI client is not regenerated).
- Ratings and color labels are private to each user.
- Owned assets: `asset_exif.rating` is authoritative for rating; the table's `rating` is never written or read for owned assets. Non-owned assets: table `rating` (1-5), `null` falls back to the exif rating.
- Color labels: `red`, `yellow`, `green`, `blue`, `purple`, at most one per asset per user; stored only in the table, for owners and non-owners.
- Anyone with `Permission.AssetRead` may set state fields (`isFavorite`, `rating`, `colorLabel`). Any other field still requires ownership. No new access logic.
- Shared-link auth must be rejected for state fields and never sees per-user state (null color, exif rating only).
- A row in `asset_user_state` exists only while it holds at least one of favorite, rating, color; clearing the last one deletes the row.
- Non-owner writes and color-only writes touch no asset row, no `updatedAt` on the asset and emit no event.
- Non-owner `rating: -1` (reject) is rejected with a 400. `rating: 0` stays invalid; `null` clears.
- `ratings.enabled` preference gates only web UI; the server does not check it.
- Timeline bucket filters: `rating` (minimum), `unrated` (boolean), `colorLabels` (any-of, with a `none` value). `rating` and `unrated` together are OR'd; `unrated` means effective rating is null; `rating >= n` excludes -1.
- Keyboard shortcuts: `0`-`5` set rating (`0` clears), `6` red, `7` yellow, `8` green, `9` blue (toggle); purple has no shortcut; `F` keeps favoriting.
- Generated files to regenerate: `server/src/queries/asset.repository.sql`, `open-api/immich-openapi-specs.json`, `packages/sdk/src/fetch-client.ts`.
- All commands run from the repo root unless noted. Server unit: `cd server && pnpm vitest --config test/vitest.config.mjs run <file>`. Medium (needs Docker): `cd server && pnpm vitest --config test/vitest.config.medium.mjs run <file> --hookTimeout 120000 --testTimeout 60000`. Web: `cd web && pnpm test run <file>`. Known environment-only failures: 3 server unit specs (`mkdtempDisposable` on Node 22), ~30 medium specs (core plugin wasm, exiftool), web date tests under en-GB locale.
- Regenerate OpenAPI: `cd server && pnpm build && node ./dist/bin/sync-open-api.js`, then from root `npx oazapfts --optimistic --argumentStyle=object --useEnumType --allSchemas open-api/immich-openapi-specs.json packages/sdk/src/fetch-client.ts`, then `pnpm --filter @immich/sdk build`. Regenerate SQL: `cd server && pnpm migrations:run` (DB_URL pointing at a dev database) then `node ./dist/bin/sync-sql.js`.

## File Structure

| File | Responsibility |
| --- | --- |
| `server/src/schema/tables/asset-user-state.table.ts` (rename of `asset-favorite.table.ts`) | Table definition |
| `server/src/schema/migrations/1793000000001-AddAssetUserState.ts` (new) + `ORDER` | Rename and extend table |
| `server/src/enum.ts` | `AssetColorLabel` enum + `AssetColorLabelSchema` |
| `server/src/repositories/asset.repository.ts` | `getUserStates`, `setUserState`, timeline/stat queries |
| `server/src/utils/database.ts` | `isFavoriteFor`, `ratingFor`, `colorLabelFor`, `colorLabelsPredicate`, search builders |
| `server/src/services/asset.service.ts` | State-aware write path |
| `server/src/dtos/*.ts` | Update DTOs, response DTOs, time-bucket DTOs, search DTOs |
| `server/src/utils/asset.util.ts` | `getViewerStates` |
| `web/src/lib/managers/timeline-filter-manager.svelte.ts` (new) | Quick filter state |
| `web/src/lib/components/timeline/TimelineFilterBar.svelte` (new) | Filter bar UI |
| `web/src/lib/utils/color-label.ts` (new) | Color constants, class names |
| `web/src/lib/components/asset-viewer/ColorLabelPicker.svelte` (new) | Color picker |
| `web/src/lib/components/timeline/actions/SetRatingAction.svelte`, `SetColorLabelAction.svelte` (new) | Bulk actions |
| `web/src/lib/components/shared-components/search-bar/SearchColorLabelsSection.svelte` (new) | Search filter |
| `e2e/src/specs/server/api/user-asset-state.e2e-spec.ts` (new) | E2E |

---

### Task 1: Schema rename, migration and repository state methods

**Files:**
- Rename: `server/src/schema/tables/asset-favorite.table.ts` -> `asset-user-state.table.ts`
- Create: `server/src/schema/migrations/1793000000001-AddAssetUserState.ts`; append `1793000000001-AddAssetUserState` to `server/src/schema/migrations/ORDER`
- Modify: `server/src/schema/index.ts` (import ~46, registry ~121, DB map ~238: `asset_favorite: AssetFavoriteTable` -> `asset_user_state: AssetUserStateTable`)
- Modify: `server/src/enum.ts` (add enum)
- Modify: `server/src/repositories/asset.repository.ts` (~744-786), `server/test/repositories/asset.repository.mock.ts` (lines 31-33)
- Modify (rename only): every `asset_favorite` reference in `server/src/utils/database.ts` (`isFavoriteFor`, `isSharedFavoriteFor`), `asset.repository.ts` and tests, adding `WHERE isFavorite = true` to each lookup
- Test: `server/test/medium/specs/repositories/asset.repository.spec.ts` (migration test uses `up`/`down` of the old migration: keep it, add a new one for the new migration)

**Interfaces:**
- Produces (enum): `export enum AssetColorLabel { Red='red', Yellow='yellow', Green='green', Blue='blue', Purple='purple' }`, `AssetColorLabelSchema = z.enum(AssetColorLabel).describe('Asset color label').meta({ id: 'AssetColorLabel' })` (copy the `AssetVisibility` pattern at `enum.ts` ~1225-1239).
- Produces (repository):
  ```ts
  export type UserState = { isFavorite: boolean; rating: number | null; colorLabel: AssetColorLabel | null };
  getUserStates(userId: string, assetIds: string[]): Promise<Map<string, UserState>>; // @ChunkedMap-style: merge chunk maps
  setUserState(userId: string, assetIds: string[], change: { isFavorite?: boolean; rating?: number | null; colorLabel?: AssetColorLabel | null }): Promise<void>;
  ```
  The old `getFavoriteIds`, `addFavorites`, `removeFavorites` are removed; callers are migrated in Tasks 2-3 (keep temporary thin wrappers inside this task so the tree compiles: not needed if all callers are updated in this task; update `asset.service.ts` mirror calls to `setUserState(auth.user.id, ids, { isFavorite })` and `getViewerFavoriteIds` to read `getUserStates` filtered by `isFavorite`, keeping behavior identical).

- [ ] **Step 1: Table definition.** `git mv` the table file, then:

```ts
import { Check, CreateDateColumn, Column, ForeignKeyColumn, type Generated, Table, Timestamp, UpdateDateColumn } from '@immich/sql-tools';
import { AssetColorLabel } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

// per-user asset state. Favorite and rating are the source of truth only for assets the user does not own
// (asset.isFavorite and asset_exif.rating stay authoritative for owned assets); owner rows exist for the favorite
// mirror and for the color label, which has no legacy column.
@Check({ name: 'asset_user_state_rating_chk', expression: `"rating" BETWEEN 1 AND 5` })
@Check({ name: 'asset_user_state_colorLabel_chk', expression: `"colorLabel" IN ('red','yellow','green','blue','purple')` })
@Table('asset_user_state')
export class AssetUserStateTable {
  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: false })
  userId!: string;

  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: true })
  assetId!: string;

  @Column({ type: 'boolean', default: false })
  isFavorite!: Generated<boolean>;

  @Column({ type: 'smallint', nullable: true })
  rating!: number | null;

  @Column({ type: 'text', nullable: true })
  colorLabel!: AssetColorLabel | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
```
Check that `@Check` can be stacked and that `Column`/`UpdateDateColumn` import names match other table files (e.g. `activity.table.ts`); adapt the imports if the stacked `@Check` form is not accepted (use one `@Check` per table file pattern in `activity.table.ts`).

- [ ] **Step 2: Migration.**

```ts
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
```
Run the repo's schema drift check afterwards (`cd server && pnpm migrations:run` against a scratch DB, then the sql-tools schema diff used by `server/test/medium` schema spec or `pnpm migrations:generate` dry run); the generated schema must show no diff. Fix index/constraint names in the table decorators if a diff appears.

- [ ] **Step 3: Failing medium test** (append to `server/test/medium/specs/repositories/asset.repository.spec.ts`): using the existing migration-test pattern (find the test that imports `up`/`down` from `AddAssetFavoriteTable` and copy its harness): create the old shape by running `down` of the new migration, insert a favorite row, run `up`, assert `isFavorite = true`, `rating IS NULL`, `colorLabel IS NULL`, and that `down`/`up` round-trips. Add repository tests:

```ts
it('setUserState upserts only the provided fields and deletes empty rows', async () => {
  const { sut, ctx } = setup(); // reuse the file's helper
  const { user } = await ctx.newUser();
  const { user: owner } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: owner.id });
  await sut.setUserState(user.id, [asset.id], { rating: 4 });
  await sut.setUserState(user.id, [asset.id], { colorLabel: AssetColorLabel.Red });
  expect((await sut.getUserStates(user.id, [asset.id])).get(asset.id)).toEqual({ isFavorite: false, rating: 4, colorLabel: 'red' });
  await sut.setUserState(user.id, [asset.id], { rating: null, colorLabel: null });
  expect((await sut.getUserStates(user.id, [asset.id])).size).toBe(0);
});
```
Run: expect FAIL (methods missing).

- [ ] **Step 4: Repository.** Replace the three favorite methods with:

```ts
@GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
async getUserStates(userId: string, assetIds: string[]): Promise<Map<string, UserState>> {
  const result = new Map<string, UserState>();
  for (const chunk of chunks(assetIds, 4000)) { // use the repo's existing chunk helper if there is one
    const rows = await this.db
      .selectFrom('asset_user_state')
      .select(['assetId', 'isFavorite', 'rating', 'colorLabel'])
      .where('userId', '=', userId)
      .where('assetId', '=', anyUuid(chunk))
      .execute();
    for (const { assetId, ...state } of rows) result.set(assetId, state);
  }
  return result;
}

@GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], { isFavorite: true, rating: 3, colorLabel: AssetColorLabel.Red }] })
@Chunked({ paramIndex: 1, chunkSize: 4000 })
async setUserState(userId: string, assetIds: string[], change: UserStateChange): Promise<void> {
  if (assetIds.length === 0) return;
  const values = omitBy(change, isUndefined) as UserStateChange;
  if (Object.keys(values).length === 0) return;
  await this.db
    .insertInto('asset_user_state')
    .values(assetIds.map((assetId) => ({ userId, assetId, ...values })))
    .onConflict((oc) => oc.columns(['userId', 'assetId']).doUpdateSet({ ...values, updatedAt: sql`now()` }))
    .execute();
  await this.db
    .deleteFrom('asset_user_state')
    .where('userId', '=', userId)
    .where('assetId', '=', anyUuid(assetIds))
    .where('isFavorite', '=', false)
    .where('rating', 'is', null)
    .where('colorLabel', 'is', null)
    .execute();
}
```
Note: for upsert insert paths, an absent `isFavorite` defaults to false, absent rating/color to null: correct. Wrap both statements in `this.db.transaction()` if the repo does so elsewhere.

- [ ] **Step 5: Rename all references.** In `database.ts` change `asset_favorite` -> `asset_user_state` and add `.where('asset_user_state.isFavorite', '=', true)` to the lookups in `isFavoriteFor` and `isSharedFavoriteFor`. Update `asset.service.ts` (`mirrorOwnedFavorites` -> `setUserState(auth.user.id, ids, { isFavorite })`; `applySharedFavorites` likewise) and `asset.util.ts` (`getViewerFavoriteIds` builds a set from `getUserStates` entries with `isFavorite`). Update `asset.repository.mock.ts` (replace the three mocks with `getUserStates: vitest.fn().mockResolvedValue(new Map())`, `setUserState: vitest.fn()`), and every spec referencing the old methods (see grep list in Global notes: `asset.service.spec.ts`, `search.service.spec.ts`, medium `asset/timeline/search.service.spec.ts`, `asset.repository.spec.ts`). Tests that inserted `asset_favorite` rows now insert into `asset_user_state` with `isFavorite: true`.

- [ ] **Step 6: Verify.** `cd server && pnpm check && pnpm lint`; unit: `asset.service.spec.ts`, `search.service.spec.ts`; medium: `asset.repository.spec.ts`, `timeline.service.spec.ts`, `asset.service.spec.ts`, `search.service.spec.ts`. All previously passing tests must pass.

- [ ] **Step 7: Commit.** `git add -A server && git commit -m "feat(server): extend asset_favorite into asset_user_state"`

---

### Task 2: DTOs and write path

**Files:**
- Modify: `server/src/dtos/asset.dto.ts` (add `colorLabel: AssetColorLabelSchema.nullish().describe('Color label (null clears)')` to `UpdateAssetBaseSchema`; `AssetBulkUpdateBaseSchema` extends it)
- Modify: `server/src/services/asset.service.ts` (`update` ~88, `updateAll` ~138, helpers ~646-675)
- Test: `server/src/services/asset.service.spec.ts`

**Interfaces:**
- Consumes: `assetRepository.setUserState`, `getUserStates` (Task 1).
- Produces: service private helpers `isStateOnly(auth, dto)`, `applyUserState(auth, ids, dto): Promise<string[]>` (returns owned ids that still need the owner path).

Semantics (implement exactly):

```ts
const STATE_KEYS = ['isFavorite', 'rating', 'colorLabel'];

// state-only: no shared link, at least one state field defined, all other fields undefined (ids ignored)
private isStateOnly(auth: AuthDto, dto: object): boolean {
  if (auth.sharedLink) return false;
  const entries = Object.entries(dto).filter(([key, value]) => key !== 'ids' && value !== undefined);
  return entries.length > 0 && entries.every(([key]) => STATE_KEYS.includes(key));
}
```
Shared-link auth carrying state fields: throw `BadRequestException`/`ForbiddenException` (use what `requireAccess` throws for shared links today, i.e. the update falls through to `requireAccess(AssetUpdate)`, which rejects shared links for a non-owner). Keep that fall-through: do not add a new error type; add a unit test that a shared-link request with `colorLabel` fails.

`applyUserState(auth, ids, dto)`:
1. `owned = await this.checkAccess({ auth, permission: Permission.AssetUpdate, ids })`; `others = ids.filter(id => !owned.has(id))`.
2. If `others.length`: `await this.requireAccess({ auth, permission: Permission.AssetRead, ids: others })`; if `dto.rating === -1` throw `BadRequestException('Only the owner can reject an asset')`; `await this.assetRepository.setUserState(auth.user.id, others, pick(dto, STATE_KEYS))`.
3. Owned ids: the owner path writes `isFavorite` (column) and `rating` (exif) as today; mirror `isFavorite` to the table (existing behavior via `setUserState(..., { isFavorite })`); write `colorLabel` to the table: `if (dto.colorLabel !== undefined) await setUserState(auth.user.id, ownedIds, { colorLabel: dto.colorLabel })`.
4. Return the owned ids. In a state-only request where the owner path would only change color (no `isFavorite`, no `rating`), skip the owner path entirely (no asset update, no event): `update()`/`updateAll()` return after `applyUserState` when `ownedIds.length === 0` **or** the DTO has neither `isFavorite` nor `rating` among defined fields.

In `update()`/`updateAll()`: replace the `isFavoriteOnly` branches with `isStateOnly`; for non-state-only requests that contain `colorLabel` alongside other owner-only fields, after `requireAccess(AssetUpdate)` also call `setUserState(auth.user.id, ids, { colorLabel })`. Strip `colorLabel` from `rest` / `assetDto` so it never reaches `assetRepository.update`. `rating` for owned assets continues through `updateExif`/`updateAllExif` untouched. Remove `isFavoriteOnly`.

- [ ] **Step 1: Failing unit tests** in `asset.service.spec.ts` (follow the existing favorite tests there for mock setup; they use `mocks.access.asset.checkOwnerAccess` / `checkAlbumAccess` / `checkPartnerAccess`):
  - non-owner (album) `update(id, { rating: 4 })` calls `setUserState(user, [id], { rating: 4 })`, does not call `assetRepository.update`/`updateExif`, emits no event;
  - non-owner partner `{ colorLabel: 'red' }` and `{ rating: null }`, `{ isFavorite: true, rating: 2, colorLabel: 'blue' }` (one `setUserState` call with all three);
  - non-owner `{ rating: -1 }` -> `BadRequestException`;
  - owner `{ colorLabel: 'green' }` -> `setUserState(user, [id], { colorLabel: 'green' })`, no `assetRepository.update`, no `updateAllExif`;
  - owner `{ rating: 3 }` -> exif path (`updateExif`) and no `setUserState`;
  - owner `{ description: 'x', colorLabel: 'red' }` -> normal update and `setUserState` with the color;
  - no access (`requireAccess` rejects) -> `BadRequestException`, no `setUserState`;
  - shared link `{ colorLabel: 'red' }` -> rejected;
  - non-owner `{ description: 'x' }` -> rejected (existing behavior);
  - bulk `updateAll` with mixed owned/non-owned ids and `{ rating: 5 }`: non-owned -> `setUserState`, owned -> `updateAllExif` and sidecar job.
  Run `pnpm vitest --config test/vitest.config.mjs run src/services/asset.service.spec.ts`: expect the new ones FAIL.

- [ ] **Step 2: Implement** as described above. Run the spec again: all pass.
- [ ] **Step 3:** `cd server && pnpm check && pnpm lint`. Commit: `feat(server): per-user rating and color label write path`.

---

### Task 3: Read path (helpers, response mapping, asset get, search results)

**Files:**
- Modify: `server/src/utils/database.ts` (helpers), `server/src/utils/asset.util.ts` (`getViewerFavoriteIds` -> `getViewerStates`), `server/src/dtos/asset-response.dto.ts` (`AssetMapOptions.favoriteIds` ~163, `mapAsset` ~226), `server/src/dtos/exif.dto.ts`, `server/src/services/asset.service.ts` (`get`), `server/src/services/search.service.ts` (`mapAssets` ~380), any other `mapAsset(..., { favoriteIds })` caller (grep `favoriteIds`)
- Test: `server/src/dtos/asset-response.dto.spec.ts` (create if missing), `server/src/services/asset.service.spec.ts`, `search.service.spec.ts`, medium `asset.service.spec.ts`

**Interfaces:**
- Produces (database.ts):
  ```ts
  // effective rating: exif rating for owned assets; the user's own rating falling back to exif for non-owned
  export function ratingFor(userId: string): RawBuilder<number | null>  // sql<number|null> expression usable in select/where
  export function colorLabelFor(userId: string): ExpressionWrapper<DB,'asset',AssetColorLabel|null> // scalar subselect on asset_user_state
  export function colorLabelsPredicate(userId: string, labels: Array<AssetColorLabel | 'none'>): Expression<SqlBool>
  ```
  `ratingFor`: `CASE WHEN asset."ownerId" = $u THEN asset_exif.rating ELSE COALESCE((SELECT rating FROM asset_user_state WHERE userId=$u AND assetId=asset.id), asset_exif.rating) END`, where the exif rating comes from a scalar subselect `(select rating from asset_exif where asset_exif."assetId" = asset.id)` so it needs no join. `colorLabelsPredicate`: `none` -> `colorLabelFor(u) IS NULL`; others -> `colorLabelFor(u) = ANY(labels)`; combined with OR.
- Produces (asset.util.ts): `getViewerStates(repository: Pick<AssetRepository,'getUserStates'>, auth, assets: {id, ownerId}[]): Promise<ReadonlyMap<string, UserState>>`. Returns an empty map for shared links. Includes **owned** assets' rows (color) and non-owned rows (favorite, rating, color).
- Produces (response): `AssetMapOptions.viewerState?: ReadonlyMap<string, UserState>` replaces `favoriteIds`. `mapAsset`: `isFavorite = ownerId === auth.user.id ? entity.isFavorite : state?.isFavorite ?? false` (shared links: `entity.isFavorite`'s existing behavior); `colorLabel = state?.colorLabel ?? null`; `exifInfo.rating` (and the top-level rating if present in `AssetResponseDto`) = for non-owners `state?.rating ?? exif.rating`. Add `colorLabel: AssetColorLabelSchema.nullable().optional()` to `AssetResponseSchema` (version/history annotation like neighbours).

- [ ] **Step 1: Failing tests.** Unit (`mapAsset`): non-owner with state `{ isFavorite: true, rating: 4, colorLabel: 'red' }` and exif rating 2 -> `isFavorite true`, `exifInfo.rating 4`, `colorLabel 'red'`; non-owner with `rating: null` -> exif rating 2; owner with state color only -> `isFavorite` from column, rating from exif, color from state; no auth state -> `colorLabel null`. Service unit: `get()` calls `getUserStates` and passes the map (mock returns a Map). Medium (`asset.service.spec.ts`): real DB, album member sets rating via `sut.update`, then `sut.get` shows it; owner's `get` shows exif rating unchanged. Run: FAIL.
- [ ] **Step 2: Implement** helpers, `getViewerStates`, mapping; update `AssetService.get`, `SearchService.mapAssets` and every `favoriteIds` caller to build `viewerState` with `getViewerStates`. In `exifInfo` mapping keep a single place (`mapExif` receives an optional `ratingOverride`).
- [ ] **Step 3:** run unit + medium specs touched; `pnpm check && pnpm lint`. Commit: `feat(server): viewer-aware rating and color label in asset responses`.

---

### Task 4: Timeline buckets (filters and per-asset arrays)

**Files:**
- Modify: `server/src/dtos/time-bucket.dto.ts` (query schema, `TimeBucketAssetResponseSchema`), `server/src/repositories/asset.repository.ts` (`TimeBucketOptions`, `getTimeBuckets` ~815, `getTimeBucket` ~890, `getStatistics` ~722), `server/src/services/timeline.service.ts` (`timeBucketChecks`, `buildTimeBucketOptions`), `server/src/utils/database.ts` (`searchAssetBuilderLegacy` favorite use if shared)
- Test: `server/test/medium/specs/services/timeline.service.spec.ts`, `server/src/services/timeline.service.spec.ts`

**Interfaces:**
- Consumes: `ratingFor`, `colorLabelFor`, `colorLabelsPredicate` (Task 3).
- Produces (query DTO): `rating?: number` (1-5, minimum), `unrated?: boolean`, `colorLabels?: Array<AssetColorLabel | 'none'>`. Use the comma-split preprocess pattern from `download.dto.ts:33` for `colorLabels`; `unrated` uses `stringToBool`. Response arrays: `rating: (number | null)[]`, `colorLabel: (AssetColorLabel | null)[]` aligned with the existing per-asset arrays.

Filter semantics in a shared function `applyStateFilters(qb, userId, { isFavorite, rating, unrated, colorLabels })` (put in `database.ts` and use in both `getTimeBuckets` and `getTimeBucket`):
- `rating` and/or `unrated`: `eb.or([rating !== undefined && ratingFor(u) >= rating, unrated && ratingFor(u) is null])` (only include defined branches; `>= n` with n in 1..5 excludes -1 automatically).
- `colorLabels`: `colorLabelsPredicate(u, labels)`.
- `isFavorite` keeps using `isFavoriteFor`.
Shared-link auth: ignore `rating`-related viewer logic — use `asset_exif.rating` directly and a null color (build the same expressions with `userId = NULL`-equivalent: skip table lookup when `auth.sharedLink`).

Relax the 400 for `isFavorite` on other users' timelines in `timeline.service.ts timeBucketChecks` (keep the other checks). Update the existing unit test that expected the 400.

- [ ] **Step 1: Failing medium tests** (real DB): owner, album member and partner each: `getTimeBucket` with `rating: 3` returns assets whose effective rating >= 3, per-asset `rating` array shows the effective value; `unrated: true`; `rating: 4, unrated: true` is OR; `colorLabels: ['red']`, `['none']`, `['red','none']`; filters reflect each viewer's own state (two users, different colors on the same asset); stale owner mirror row ignored for favorites; `getTimeBuckets` counts honor the filters; `isFavorite: true` on a partner timeline no longer throws.
- [ ] **Step 2: Implement.** In `getTimeBucket`, add `ratingFor(userId).as('rating')` and `colorLabelFor(userId).as('colorLabel')` to the cte columns and `array_agg` entries next to `isFavorite`. Do not add an `asset_exif` join when it is not already there (use the scalar subselects).
- [ ] **Step 3:** run unit + medium timeline specs, `pnpm check && pnpm lint`. Commit: `feat(server): rating and color label filters in timeline buckets`.

---

### Task 5: Search filters

**Files:**
- Modify: `server/src/dtos/search.dto.ts` (flat `colorLabels` ~ near rating ~51, `searchFilterBranchShape` rating ~269 plus `colorLabels`), `server/src/utils/database.ts` (`searchAssetBuilderLegacy` rating ~549, `comparisonPredicates` ~725, `branchPredicates` rating ~860), `server/src/services/search.service.ts` (pass userId), `server/src/repositories/search.repository.ts` (option types)
- Test: `server/test/medium/specs/services/search.service.spec.ts`, `server/src/services/search.service.spec.ts`

**Interfaces:**
- Consumes: `ratingFor`, `colorLabelsPredicate`, `colorLabelFor`.
- Produces: search request field `colorLabels?: Array<AssetColorLabel | 'none'>` (flat DTO for the legacy path; any-of; inside V3 `filter` branch shape add `colorLabels` with the same schema). Options gain `viewerId` used by the builders (the viewer is `userIds[0]` of the owner today; pass `auth.user.id` explicitly as `options.viewerId`).

Details: legacy `options.rating` currently compares `asset_exif.rating` -> compare `ratingFor(viewerId)` instead (equality semantics preserved: legacy rating is exact match; `-1` allowed only matches owners' reject). V3 `comparisonPredicates` is column-based; generalize it to accept an expression (`ref` argument of type `Expression<...>`) so `filter.rating` passes `ratingFor(viewerId)` while other columns pass their column refs. Search universe is unchanged.

- [ ] **Step 1: Failing tests** (medium, real DB): album-confined search by a member with `rating: 4` matches an asset only they rated 4 (exif rating 1); owner exif rating still filters for owner; `colorLabels: ['red']` / `['none']` for both legacy and V3 `filter`; another user's color does not match. Unit: DTO accepts `colorLabels`, rejects an unknown color.
- [ ] **Step 2: Implement**, run specs, `pnpm check && pnpm lint`. Commit: `feat(server): color label and viewer-aware rating in search`.

---

### Task 6: Generated artifacts and e2e

**Files:**
- Regenerate: `server/src/queries/asset.repository.sql`, `open-api/immich-openapi-specs.json`, `packages/sdk/src/fetch-client.ts`
- Create: `e2e/src/specs/server/api/user-asset-state.e2e-spec.ts` (model on `shared-favorite.e2e-spec.ts` in the same folder: same setup of owner, album member, partner)

- [ ] **Step 1:** Regenerate SQL and OpenAPI/SDK with the commands in Global Constraints. Skip the dart client. `git diff --stat` must show only expected files; the OpenAPI diff must contain `colorLabel`, `AssetColorLabel`, `colorLabels`, `unrated`, `rating` query params and bucket `rating`/`colorLabel` arrays.
- [ ] **Step 2: Write e2e** with these cases: (a) album member (editor and viewer) PUTs `{ rating: 4, colorLabel: 'red' }` on the owner's shared photo -> 200, GET `/assets/:id` as the member shows rating 4 and `red`, GET as the owner shows exif rating unchanged and `colorLabel null`; (b) member filters `/timeline/bucket?...&colorLabels=red` and `&rating=4` and sees the asset, owner with the same params does not; (c) member sends `{ rating: -1 }` -> 400; (d) member sends `{ description: 'x' }` -> 400/403; (e) user without access -> 400; (f) owner `PUT` `{ colorLabel: 'blue' }` and bulk `PUT /assets` `{ ids, rating: 2 }` -> owner's exif rating 2, member's effective rating unchanged if they set their own; (g) clearing `{ rating: null, colorLabel: null }` as member falls back to exif rating.
- [ ] **Step 3:** Run e2e as in previous plans (`cd e2e && pnpm test -- src/specs/server/api/user-asset-state.e2e-spec.ts`, see `shared-favorite.e2e-spec.ts` header and the previous task-6 report for the docker compose setup). If the stack cannot start, report exactly what was attempted.
- [ ] **Step 4:** Full server verification: `pnpm check:code`, `pnpm test`, medium with the long timeouts. Commit: `feat(server): regenerate artifacts, add per-user state e2e`.

---

### Task 7: Web data layer (types, filter manager, bucket queries)

**Files:**
- Create: `web/src/lib/managers/timeline-filter-manager.svelte.ts`, `web/src/lib/utils/color-label.ts`
- Modify: `web/src/lib/managers/timeline-manager/types.ts` (`TimelineAsset` gains `rating: number | null`, `colorLabel: AssetColorLabel | null`; `TimelineManagerOptions` gains `filter?: TimelineFilter`), `timeline-month.svelte.ts` (~192, bucket fetch), `timeline-manager.svelte.ts` (`isExcluded` ~655, option handling), `web/src/lib/utils/timeline-util.ts` (~159, map bucket arrays to `TimelineAsset`), `web/src/test-data/factories/asset-factory.ts`
- Test: `web/src/lib/managers/timeline-filter-manager.spec.ts` (new), the existing timeline-manager specs

**Interfaces:**
- Produces:
  ```ts
  // color-label.ts
  export const colorLabels = [AssetColorLabel.Red, AssetColorLabel.Yellow, AssetColorLabel.Green, AssetColorLabel.Blue, AssetColorLabel.Purple] as const;
  export const colorLabelClass: Record<AssetColorLabel, string>; // tailwind bg classes: bg-red-500 etc.
  export const colorLabelShortcut: Partial<Record<AssetColorLabel, string>>; // red '6', yellow '7', green '8', blue '9'
  // timeline-filter-manager.svelte.ts
  export type TimelineFilter = { isFavorite?: boolean; rating?: number; unrated?: boolean; colorLabels?: Array<AssetColorLabel | 'none'> };
  export class TimelineFilterManager {
    isFavorite = $state(false); rating = $state<number | undefined>(); unrated = $state(false); colorLabels = $state<Array<AssetColorLabel | 'none'>>([]);
    get active(): boolean; get query(): TimelineFilter;   // query omits unset values; isFavorite only when true
    toggleColor(label: AssetColorLabel | 'none'): void; setRating(n?: number): void; clear(): void;
  }
  ```
- Bucket requests (`getTimeBucket`/`getTimeBuckets` SDK calls) merge `filter.query` with the page options (`isFavorite` from the page option wins over the filter toggle). `TimelineManager.updateOptions` (or equivalent) must reload when the filter changes: expose `setFilter(filter: TimelineFilter)` that stores it and triggers the same re-init path used when options change. The client-side `isExcluded` check (used after local edits) must also account for the filter: an asset updated locally that no longer matches (e.g. unfavorited with the heart filter on, rating changed below the minimum) is removed.

- [ ] **Step 1: Failing tests:** `TimelineFilterManager` (`query` omits defaults; `toggleColor` adds/removes; `clear` resets; `active`); timeline-manager spec: assets from bucket arrays include `rating`/`colorLabel`; `isExcluded` with filter `{ rating: 3 }` for an asset with rating 2.
- [ ] **Step 2: Implement.** In `timeline-util.ts` map `bucketAssets.rating[i]` and `colorLabel[i]`. Update factories (`rating: null, colorLabel: null` defaults).
- [ ] **Step 3:** `cd web && pnpm test run src/lib/managers && pnpm check:typescript && pnpm lint`. Commit: `feat(web): timeline filter state and per-asset rating and color data`.

---

### Task 8: Web filter bar on timeline views

**Files:**
- Create: `web/src/lib/components/timeline/TimelineFilterBar.svelte`
- Modify: `web/src/lib/components/timeline/Timeline.svelte` (new prop `showFilterBar?: boolean` default false; render the bar above the scroll area; own a `TimelineFilterManager`, call `timelineManager.setFilter(filter.query)` in an `$effect`), the page files that render a timeline: `photos`, `albums/[albumId]`, `favorites`, `archive`, `people/[personId]`, `places`, `tags`, `folders`, `recently-added` (grep `<Timeline` under `web/src/routes/(user)`) pass `showFilterBar`; `i18n/en.json` (new keys: `filter_favorites`, `filter_rating_min`, `filter_unrated`, `filter_no_color`, `filter_clear_all`, `color_label_red`...`color_label_purple`, `quick_filters`)
- Test: `web/src/lib/components/timeline/TimelineFilterBar.spec.ts`

**Interfaces:**
- Consumes: `TimelineFilterManager`, `colorLabels`, `colorLabelClass`, `preferences.ratings.enabled`.
- Produces: `TimelineFilterBar` props `{ filter: TimelineFilterManager; hideFavorite?: boolean }`. Behavior: heart toggle (hidden when `hideFavorite`); five star buttons selecting the minimum (click the active one to clear) plus an "unrated" toggle (stars and unrated hidden when `ratings.enabled` is false); five color chips plus a "no color" chip, multi-select; a clear-all button visible only when `filter.active`. `Timeline.svelte` passes `hideFavorite` when its `options.isFavorite` is set (Favorites page). Filter state resets when the timeline component is destroyed/recreated on navigation (it lives inside `Timeline`, so a route change recreates it; verify for album/people routes that switch ids without remounting and reset in an `$effect` keyed on the options object).

- [ ] **Step 1: Failing component tests** (testing-library, mirroring an existing component spec in `web/src/lib/components`): clicking the third star sets `rating = 3`; clicking it again clears; red chip toggles `colorLabels` containing `red`; clear-all appears only when active and resets; favorite toggle absent with `hideFavorite`; star controls absent when ratings disabled.
- [ ] **Step 2: Implement** the component with the existing `IconButton`/icon conventions used in `Timeline` headers; chips use `colorLabelClass`. All strings via `$t`.
- [ ] **Step 3:** Run `pnpm test run src/lib/components/timeline`, `pnpm check:svelte`, `check:typescript`, `lint`. Commit: `feat(web): quick filter bar on timeline views`.

---

### Task 9: Web per-asset UI (viewer, thumbnail, service gating)

**Files:**
- Create: `web/src/lib/components/asset-viewer/ColorLabelPicker.svelte`
- Modify: `web/src/lib/components/asset-viewer/DetailPanelStarRating.svelte` (editable for any non-shared-link user; keep `ratings.enabled` gate), `web/src/lib/services/asset.service.ts` (`canFavorite`-style gating ~153; add `handleSetColorLabel(asset, label | null)`; `handleRate` ~470 must send the update and, for a non-owner, update local state from the response), `web/src/lib/components/assets/thumbnail/Thumbnail.svelte` (~321/336: color dot bottom-left, star badge when `rating > 0 && ratings.enabled`), `web/src/lib/components/asset-viewer/DetailPanel.svelte` (render picker under the rating), `i18n/en.json`
- Test: `ColorLabelPicker.spec.ts`, `DetailPanelStarRating` spec if present, `asset.service` spec for gating

**Interfaces:**
- Produces: `ColorLabelPicker` props `{ value: AssetColorLabel | null; onChange: (label: AssetColorLabel | null) => void; readOnly?: boolean }`; clicking the active color calls `onChange(null)`. `TimelineAsset` rating/colorLabel (Task 7) drive the thumbnail; the viewer's `AssetResponseDto.colorLabel` and `exifInfo.rating` drive the panel.

- [ ] **Step 1: Failing tests:** picker emits the color / null on re-click; read-only disables buttons; rating component editable for a non-owner (previously owner-only assertion changes); thumbnail shows a dot with the color class and hides the star badge when ratings are disabled.
- [ ] **Step 2: Implement**, using `updateAsset`/`updateAssets` from the SDK; after a successful update patch the timeline asset (`timelineManager.upsertAssets`/the existing favorite update path used by `handleFavorite`) so the thumbnail and the active filter refresh.
- [ ] **Step 3:** run the relevant specs, `check:svelte`, `check:typescript`, `lint`. Commit: `feat(web): editable rating, color label picker and thumbnail badges`.

---

### Task 10: Web bulk actions and shortcuts

**Files:**
- Create: `web/src/lib/components/timeline/actions/SetRatingAction.svelte`, `SetColorLabelAction.svelte`
- Modify: every selection bar that renders `<FavoriteAction` and shows no ownership-only restriction on favorites (`photos`, `albums/[albumId]`, `tags`, `people`, `folders`, `archive`, `recently-added`, `search`, `map` panel; leave `favorites` and `memories` as they are) to add the two actions after it; `web/src/lib/components/timeline/TimelineKeyboardActions.svelte` (shortcuts); the asset viewer keyboard handler (grep where the `F` favorite shortcut is registered in `asset-viewer.svelte`/`asset-viewer-actions`); `web/src/lib/managers/asset-multi-select-manager.svelte.ts` (no new members expected; reuse `assets`)
- Test: `SetRatingAction.spec.ts`, `SetColorLabelAction.spec.ts`, keyboard handler spec

**Interfaces:**
- Consumes: `updateAssets({ assetBulkUpdateDto: { ids, rating | colorLabel } })` from the SDK; `FavoriteAction.svelte` as the structural model (props: `onFavorite` callback style; copy its `assetMultiSelectManager.clear()` / `timelineManager.update` handling).
- Produces: `SetRatingAction` props `{ onRated?: (ids: string[], rating: number | null) => void }` rendering a small star menu (0 = clear); `SetColorLabelAction` props `{ onLabeled?: (ids: string[], label: AssetColorLabel | null) => void }`. Both are hidden when `ratings.enabled` is false (rating only) or any selected asset is a shared-link asset; they are enabled when every selected asset is readable (always true in these views).
- Shortcuts: in viewer and selection context, keys `0`-`5` -> rate (`0` -> `rating: null`); `6`/`7`/`8`/`9` -> toggle red/yellow/green/blue (if every target asset already has that color, clear it). Rating shortcuts are ignored when `ratings.enabled` is false. Shortcuts ignore events with modifiers and focused inputs (follow the existing `shortcuts` action usage).

- [ ] **Step 1: Failing tests** for the two actions (render with a selection of two assets, click a star / color, assert `updateAssets` called with the ids and the field) and for the shortcut handler (pressing `3` calls rate with 3; `0` with null; `6` toggles red).
- [ ] **Step 2: Implement** and wire into each page.
- [ ] **Step 3:** `pnpm test run`, `check:svelte`, `check:typescript`, `lint` in `web`. Commit: `feat(web): bulk rating and color actions with keyboard shortcuts`.

---

### Task 11: Search page color section

**Files:**
- Create: `web/src/lib/components/shared-components/search-bar/SearchColorLabelsSection.svelte`
- Modify: `SearchFilters.svelte`, `web/src/lib/types.ts` (`SearchFilter` gains `colorLabels: Array<AssetColorLabel | 'none'>`), `web/src/lib/managers/search-manager.svelte.ts` and the query-param serialization used by the search route (grep `rating` there), `i18n/en.json`
- Test: `SearchColorLabelsSection.spec.ts`, existing search-bar specs

**Interfaces:**
- Produces: `SearchColorLabelsSection` props `{ selected: Array<AssetColorLabel | 'none'> }` with `$bindable`, five chips plus "no color", modelled on `SearchPeopleSection` / `SearchRatingsSection` (read both before writing). Selection is sent as `colorLabels` in the search request (any-of), persisted in the URL params like the other sections, and reset by the filter reset.

- [ ] **Step 1: Failing tests:** chip toggles update the bound array; the search query built from a filter with `colorLabels: ['red']` includes `colorLabels`; empty selection omits it.
- [ ] **Step 2: Implement**; run web checks as in Task 10. Commit: `feat(web): color label filter in search`.

---

## Self-Review Notes

- Spec coverage: data model (T1), write path (T2), read path and response (T3), timeline filters and arrays (T4), search (T5), generated files and e2e (T6), web filter bar (T7-T8), per-asset UI (T9), bulk and shortcuts (T10), search section (T11), tests are distributed per task. Mobile/sync untouched.
- Deviations from the first-approved spec text (documented in the spec): no owner rating mirror; non-owner `-1` rejected; favorite/rating/color filters allowed on other-user timelines; `rating` + `unrated` are OR'd.
- Open verification points for implementers: stacked `@Check` decorators (T1), schema drift check, whether `Timeline` remounts on id changes (T8).
