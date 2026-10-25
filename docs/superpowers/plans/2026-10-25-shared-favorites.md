# Shared-Asset Favorites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any user who can read an asset (shared-album member, viewer included, or partner) favorite it, with the favorite stored per user and visible in the timeline, Favorites page, search and asset viewer.

**Architecture:** A new `asset_favorite(userId, assetId)` table holds favorites on assets the user does not own. `asset.isFavorite` stays the source of truth for the owner's own assets. The write path in `AssetService` splits a favorite-only update by ownership. The read path uses one shared Kysely predicate, `isFavoriteFor(userId)` = `(owner = user AND asset.isFavorite) OR EXISTS asset_favorite row`, in timeline, search, statistics and asset response mapping. Sync streams and mobile keep reading the raw column and are not touched.

**Tech Stack:** NestJS, Kysely/Postgres, `@immich/sql-tools` schema decorators, vitest (unit + medium with testcontainers), SvelteKit 5 web, Playwright-free e2e via supertest.

## Global Constraints

- Server + web only. No changes to `server/src/repositories/sync.repository.ts`, sync DTOs, or mobile.
- Favorites on non-owned photos are **per user**, never a shared flag on the asset row.
- Anyone with `Permission.AssetRead` on the asset may favorite it (owner, shared-album member incl. viewers, partner). No new access logic.
- `asset.isFavorite` column is kept as-is. No data migration, no column removal.
- A favorite-only update to a non-owned asset must NOT write the asset row, emit `AssetUpdate`, or bump `updatedAt`.
- Any DTO field other than `isFavorite` still requires ownership (`Permission.AssetUpdate`).
- Shared-link auth (`auth.sharedLink`) must never create favorites.
- Generated query snapshots in `server/src/queries/*.sql` must be regenerated.
- Run this plan after `2026-10-25-album-search-filter.md` if both are executed, since both touch `server/src/services/search.service.ts` (changes are in different statements, so conflicts are trivial).
- All commands run from the repo root unless noted. Server unit tests: `cd server && pnpm test -- <path>`. Medium tests need Docker: `cd server && pnpm test:medium -- <path>`.

## File Structure

| File | Responsibility |
| --- | --- |
| `server/src/schema/tables/asset-favorite.table.ts` (new) | Table definition |
| `server/src/schema/migrations/1793000000000-AddAssetFavoriteTable.ts` (new) | Hand-written migration |
| `server/src/schema/index.ts` | Register table + `DB` entry |
| `server/src/repositories/asset.repository.ts` | `getFavoriteIds`, `addFavorites`, `removeFavorites`; timeline + statistics use `isFavoriteFor` |
| `server/test/repositories/asset.repository.mock.ts` | Mock the 3 new methods |
| `server/src/utils/database.ts` | `isFavoriteFor`, `isSharedWith`, `isSharedFavoriteFor`; legacy + V3 search use them |
| `server/src/utils/asset.util.ts` | `getViewerFavoriteIds` helper |
| `server/src/dtos/asset-response.dto.ts` | `AssetMapOptions.favoriteIds` and `mapAsset` |
| `server/src/services/asset.service.ts` | Write path split + `get` passes `favoriteIds` |
| `server/src/services/search.service.ts` | `mapResponse` and list mappers pass `favoriteIds` |
| `web/src/lib/services/asset.service.ts` | Viewer heart gated on login, not ownership |
| `web/src/lib/components/timeline/actions/FavoriteAction.svelte` | Bulk action over all selected assets |
| 5 web route pages | Show `FavoriteAction` regardless of ownership |
| `e2e/src/specs/server/api/shared-favorite.e2e-spec.ts` (new) | End-to-end |

Deviations from the spec (decided during planning):
- Map markers (`map.repository.ts`) are NOT changed; the map keeps showing raw column state. Lowest priority and out of scope.
- V3 `filter.isFavorite` uses viewer-aware semantics but the search *universe* is unchanged (own + partners, or album-confined). Non-owned favorites in shared albums show up in V3 search only when the query is album-confined. The legacy flat `isFavorite` search (what the web UI uses) does include them.
- No OpenAPI/SDK regeneration is needed: no DTO or route shape changes.
- Album view (`GET /albums/:id` embedded assets), memories and shared-link payloads still report `isFavorite: false` for non-owned assets. Web reads the timeline and the asset viewer (`GET /assets/:id`), both of which are covered.

---

### Task 1: `asset_favorite` table, migration, repository methods

**Files:**
- Create: `server/src/schema/tables/asset-favorite.table.ts`
- Create: `server/src/schema/migrations/1793000000000-AddAssetFavoriteTable.ts`
- Modify: `server/src/schema/index.ts` (import near line 45, `tables` array near line 118, `DB` interface near line 234)
- Modify: `server/src/repositories/asset.repository.ts` (add methods after `getStatistics`)
- Modify: `server/test/repositories/asset.repository.mock.ts`
- Test: `server/test/medium/specs/repositories/asset.repository.spec.ts`

**Interfaces:**
- Produces on `AssetRepository`:
  - `getFavoriteIds(userId: string, assetIds: string[]): Promise<Set<string>>`
  - `addFavorites(userId: string, assetIds: string[]): Promise<void>` (idempotent)
  - `removeFavorites(userId: string, assetIds: string[]): Promise<void>`
- Produces DB table `asset_favorite` with `DB['asset_favorite']`.

- [ ] **Step 1: Write the failing medium test**

Open `server/test/medium/specs/repositories/asset.repository.spec.ts`, look at how the file creates the repository (`setup()` returning `{ ctx, sut }`). Add this `describe` inside the top-level describe, using that same `setup()`:

```ts
  describe('favorites', () => {
    it('should add, read and remove favorites per user', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: owner.id });

      await sut.addFavorites(viewer.id, [asset.id]);
      await sut.addFavorites(viewer.id, [asset.id]); // idempotent

      await expect(sut.getFavoriteIds(viewer.id, [asset.id])).resolves.toEqual(new Set([asset.id]));
      await expect(sut.getFavoriteIds(other.id, [asset.id])).resolves.toEqual(new Set());
      await expect(sut.getFavoriteIds(viewer.id, [])).resolves.toEqual(new Set());

      await sut.removeFavorites(viewer.id, [asset.id]);
      await expect(sut.getFavoriteIds(viewer.id, [asset.id])).resolves.toEqual(new Set());
    });
  });
```

If the file's `setup()` helper returns something different, adapt only the destructuring; keep the assertions.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && pnpm test:medium -- test/medium/specs/repositories/asset.repository.spec.ts -t favorites`
Expected: FAIL (`sut.addFavorites is not a function`, TypeScript error on missing table is also acceptable).

- [ ] **Step 3: Create the table definition**

`server/src/schema/tables/asset-favorite.table.ts`:

```ts
import { CreateDateColumn, ForeignKeyColumn, type Generated, Table, Timestamp } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

// favorites a user set on assets they do not own; owned assets keep using asset.isFavorite
@Table('asset_favorite')
export class AssetFavoriteTable {
  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: false })
  userId!: string;

  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: true })
  assetId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
```

- [ ] **Step 4: Register in `server/src/schema/index.ts`**

Add the import after the `AssetFaceTable` import (line ~45):
```ts
import { AssetFavoriteTable } from 'src/schema/tables/asset-favorite.table.js';
```
Add `AssetFavoriteTable,` to the `tables` array right after `AssetFaceAuditTable,` (line ~119). Add to the `DB` interface right after `asset_face_audit: AssetFaceAuditTable;`:
```ts
  asset_favorite: AssetFavoriteTable;
```

- [ ] **Step 5: Write the migration**

`server/src/schema/migrations/1793000000000-AddAssetFavoriteTable.ts` (timestamp must sort after `1792517020180`; if `pnpm migrations:verify-order` complains, run `pnpm migrations:sync-order`):

```ts
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
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_favorite";`.execute(db);
}
```

- [ ] **Step 6: Check schema/migration drift (only if a dev Postgres is available)**

Run: `cd server && pnpm migrations:run && pnpm migrations:generate`
Expected: `migrations:generate` reports no schema changes. If it generates a diff, copy its SQL names/options into the hand-written migration (and adjust the table decorator, e.g. the `index` flags) so they match, then delete the generated file. Skip this step when no database is reachable; the medium test in Step 8 still runs the migration.

- [ ] **Step 7: Add the repository methods**

In `server/src/repositories/asset.repository.ts` add directly after the `getStatistics` method:

```ts
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @ChunkedArray({ paramIndex: 1 })
  async getFavoriteIds(userId: string, assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }

    const rows = await this.db
      .selectFrom('asset_favorite')
      .select('assetId')
      .where('userId', '=', userId)
      .where('assetId', '=', anyUuid(assetIds))
      .execute();
    return new Set(rows.map(({ assetId }) => assetId));
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @Chunked({ paramIndex: 1, chunkSize: 4000 })
  async addFavorites(userId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .insertInto('asset_favorite')
      .values(assetIds.map((assetId) => ({ userId, assetId })))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @Chunked({ paramIndex: 1 })
  async removeFavorites(userId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .deleteFrom('asset_favorite')
      .where('userId', '=', userId)
      .where('assetId', '=', anyUuid(assetIds))
      .execute();
  }
```

`Chunked` and `ChunkedArray` are already imported at the top of the file (`import { Chunked, ChunkedArray, DummyValue, GenerateSql } from 'src/decorators.js'`). `Chunked` without `mergeFn` is used elsewhere for void returns; check one existing use (`grep -n "@Chunked(" server/src/repositories/asset.repository.ts`) and mirror its options if the signature differs.

- [ ] **Step 8: Update the repository mock**

In `server/test/repositories/asset.repository.mock.ts` add inside the returned object, next to `getStatistics: vitest.fn(),`:

```ts
    getFavoriteIds: vitest.fn().mockResolvedValue(new Set()),
    addFavorites: vitest.fn(),
    removeFavorites: vitest.fn(),
```

- [ ] **Step 9: Run test + typecheck**

Run: `cd server && pnpm test:medium -- test/medium/specs/repositories/asset.repository.spec.ts -t favorites && pnpm check`
Expected: PASS, no type errors.

- [ ] **Step 10: Commit**

```bash
git add server/src/schema server/src/repositories/asset.repository.ts server/test/repositories/asset.repository.mock.ts server/test/medium/specs/repositories/asset.repository.spec.ts
git commit -m "feat(server): add asset_favorite table for per-user favorites on shared assets"
```

---

### Task 2: Write path in `AssetService`

**Files:**
- Modify: `server/src/services/asset.service.ts` (`update` at line ~86, `updateAll` at line ~125)
- Test: `server/src/services/asset.service.spec.ts` (inside `describe('update'` ~173 and `describe('updateAll'` ~381)
- Test: `server/test/medium/specs/services/asset.service.spec.ts`

**Interfaces:**
- Consumes: `AssetRepository.addFavorites/removeFavorites` (Task 1), `BaseService.checkAccess/requireAccess`.
- Produces: `AssetService.update` / `updateAll` accept favorite-only DTOs for non-owned readable assets.

- [ ] **Step 1: Write failing unit tests for `update`**

In `server/src/services/asset.service.spec.ts`, inside `describe('update'`, after the `'should update the asset'` test add:

```ts
    it('should favorite a shared-album asset the user does not own', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.update(authStub.admin, asset.id, { isFavorite: true });

      expect(mocks.asset.addFavorites).toHaveBeenCalledWith(authStub.admin.user.id, [asset.id]);
      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
    });

    it('should favorite a partner asset the user does not own', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.update(authStub.admin, asset.id, { isFavorite: true });

      expect(mocks.asset.addFavorites).toHaveBeenCalledWith(authStub.admin.user.id, [asset.id]);
    });

    it('should unfavorite a non-owned asset', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.update(authStub.admin, asset.id, { isFavorite: false });

      expect(mocks.asset.removeFavorites).toHaveBeenCalledWith(authStub.admin.user.id, [asset.id]);
    });

    it('should reject favoriting an asset the user cannot read', async () => {
      await expect(sut.update(authStub.admin, 'asset-1', { isFavorite: true })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.asset.addFavorites).not.toHaveBeenCalled();
    });

    it('should not let a non-owner update other fields together with isFavorite', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([asset.id]));

      await expect(
        sut.update(authStub.admin, asset.id, { isFavorite: true, description: 'nope' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.asset.addFavorites).not.toHaveBeenCalled();
    });

    it('should not create a favorite for shared link auth', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([asset.id]));
      const auth = { ...authStub.admin, sharedLink: { id: 'link' } } as typeof authStub.admin;

      await expect(sut.update(auth, asset.id, { isFavorite: true })).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.asset.addFavorites).not.toHaveBeenCalled();
    });
```

- [ ] **Step 2: Write failing unit tests for `updateAll`**

Inside `describe('updateAll'`:

```ts
    it('should favorite non-owned assets and update owned ones normally', async () => {
      const auth = AuthFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['owned']));
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set(['shared']));

      await sut.updateAll(auth, { ids: ['owned', 'shared'], isFavorite: true });

      expect(mocks.asset.addFavorites).toHaveBeenCalledWith(auth.user.id, ['shared']);
      expect(mocks.asset.updateAll).toHaveBeenCalledWith(['owned'], { isFavorite: true });
    });

    it('should only write shared favorites when every id is non-owned', async () => {
      const auth = AuthFactory.create();
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set(['shared']));

      await sut.updateAll(auth, { ids: ['shared'], isFavorite: false });

      expect(mocks.asset.removeFavorites).toHaveBeenCalledWith(auth.user.id, ['shared']);
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
    });

    it('should reject when some ids are neither owned nor readable', async () => {
      const auth = AuthFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['owned']));

      await expect(sut.updateAll(auth, { ids: ['owned', 'unknown'], isFavorite: true })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('should require ownership when other fields are present', async () => {
      const auth = AuthFactory.create();
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set(['shared']));

      await expect(
        sut.updateAll(auth, { ids: ['shared'], isFavorite: true, visibility: AssetVisibility.Archive }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.asset.addFavorites).not.toHaveBeenCalled();
    });
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd server && pnpm test -- src/services/asset.service.spec.ts -t "update"`
Expected: the new tests FAIL.

- [ ] **Step 4: Implement the split**

In `server/src/services/asset.service.ts`, add two private helpers at the end of the class (before the final `}`; find the last method and put them after it):

```ts
  // a favorite-only update is allowed on any asset the user can read; non-owned ones go to asset_favorite
  private isFavoriteOnly(auth: AuthDto, dto: Record<string, unknown>, isFavorite?: boolean) {
    if (auth.sharedLink || isFavorite === undefined) {
      return false;
    }
    return Object.entries(dto).every(([key, value]) => key === 'ids' || key === 'isFavorite' || value === undefined);
  }

  // writes shared favorites for the non-owned ids and returns the owned ids
  private async applySharedFavorites(auth: AuthDto, ids: string[], isFavorite: boolean): Promise<string[]> {
    const owned = await this.checkAccess({ auth, permission: Permission.AssetUpdate, ids });
    const others = ids.filter((id) => !owned.has(id));
    if (others.length === 0) {
      return ids;
    }

    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: others });
    await (isFavorite
      ? this.assetRepository.addFavorites(auth.user.id, others)
      : this.assetRepository.removeFavorites(auth.user.id, others));

    return ids.filter((id) => owned.has(id));
  }
```

In `update`, replace the first line (`await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [id] });`) with:

```ts
    if (this.isFavoriteOnly(auth, dto, dto.isFavorite)) {
      const ownedIds = await this.applySharedFavorites(auth, [id], dto.isFavorite!);
      if (ownedIds.length === 0) {
        return this.get(auth, id) as Promise<AssetResponseDto>;
      }
    }

    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [id] });
```

In `updateAll`, change the destructuring so `ids` is derived. Replace

```ts
    const {
      ids,
      isFavorite,
```
with
```ts
    const {
      ids: requestedIds,
      isFavorite,
```
and replace the line `await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids });` with:

```ts
    let ids = requestedIds;
    if (this.isFavoriteOnly(auth, dto, isFavorite)) {
      ids = await this.applySharedFavorites(auth, requestedIds, isFavorite!);
      if (ids.length === 0) {
        return;
      }
    }

    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids });
```

Note: for a favorite-only update where every id is owned, `applySharedFavorites` returns all ids unchanged and the existing path runs exactly as before.

- [ ] **Step 5: Run unit tests**

Run: `cd server && pnpm test -- src/services/asset.service.spec.ts`
Expected: all PASS (including pre-existing ones).

- [ ] **Step 6: Write the medium test against a real DB**

In `server/test/medium/specs/services/asset.service.spec.ts` add a `describe('updateAll favorites'` block after the `get` describe:

```ts
  describe('shared favorites', () => {
    it('should let an album member favorite a photo they do not own without touching the asset', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: member } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: owner.id });
      const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });

      await sut.updateAll(factory.auth({ user: member }), { ids: [asset.id], isFavorite: true });

      await expect(ctx.get(AssetRepository).getFavoriteIds(member.id, [asset.id])).resolves.toEqual(
        new Set([asset.id]),
      );
      const row = await ctx.database
        .selectFrom('asset')
        .select(['isFavorite', 'updatedAt'])
        .where('id', '=', asset.id)
        .executeTakeFirstOrThrow();
      expect(row.isFavorite).toBe(false);
      expect(row.updatedAt).toEqual(asset.updatedAt);
    });

    it('should reject favoriting a photo the user cannot read', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: owner.id });

      await expect(
        sut.updateAll(factory.auth({ user: stranger }), { ids: [asset.id], isFavorite: true }),
      ).rejects.toThrow('Not found or no asset.read access');
    });
  });
```

Add `import { AlbumUserRole } from 'src/enum.js';` merged into the existing `src/enum.js` import at the top (`AssetFileType, AssetMetadataKey, ...`).

- [ ] **Step 7: Run medium test**

Run: `cd server && pnpm test:medium -- test/medium/specs/services/asset.service.spec.ts -t "shared favorites"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/asset.service.ts server/src/services/asset.service.spec.ts server/test/medium/specs/services/asset.service.spec.ts
git commit -m "feat(server): allow favoriting readable assets the user does not own"
```

---

### Task 3: Read path — SQL helpers, timeline, asset response

**Files:**
- Modify: `server/src/utils/database.ts` (add helpers next to `inSharedAlbum`, line ~291)
- Modify: `server/src/repositories/asset.repository.ts` (`getTimeBuckets` ~752, `getTimeBucket` ~815)
- Modify: `server/src/dtos/asset-response.dto.ts` (`AssetMapOptions` ~159, `mapAsset` ~226)
- Modify: `server/src/utils/asset.util.ts` (add helper)
- Modify: `server/src/services/asset.service.ts` (`get`)
- Test: `server/test/medium/specs/services/timeline.service.spec.ts`
- Test: `server/src/services/asset.service.spec.ts`

**Interfaces:**
- Produces in `database.ts`:
  - `isFavoriteFor(userId: string): Expression<SqlBool>` over table `asset`
  - `isSharedWith(userId: string): Expression<SqlBool>` (shared album or partner)
  - `isSharedFavoriteFor(userId: string): Expression<SqlBool>` (favorite row AND still shared with user)
- Produces `AssetMapOptions.favoriteIds?: ReadonlySet<string>`.
- Produces in `asset.util.ts`: `getViewerFavoriteIds(repository: Pick<AssetRepository, 'getFavoriteIds'>, auth: AuthDto, assets: { id: string; ownerId: string }[]): Promise<ReadonlySet<string>>`.

- [ ] **Step 1: Write failing medium tests for the timeline**

In `server/test/medium/specs/services/timeline.service.spec.ts`, inside `describe('getTimeBuckets'` (or a new sibling describe at the bottom of the top-level describe), add. Add `import { AlbumUserRole } from 'src/enum.js';` to the enum import and make sure `AssetRepository` is imported (it already is).

```ts
  describe('shared favorites', () => {
    const setupSharedAlbum = async (ctx: ReturnType<typeof setup>['ctx']) => {
      const { user: owner } = await ctx.newUser();
      const { user: member } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: owner.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });
      return { owner, member, asset, album };
    };

    it('should list a favorited shared-album asset on the favorites timeline of the favoriting user only', async () => {
      const { sut, ctx } = setup();
      const { owner, member, asset } = await setupSharedAlbum(ctx);
      await ctx.get(AssetRepository).addFavorites(member.id, [asset.id]);

      await expect(sut.getTimeBuckets(factory.auth({ user: member }), { isFavorite: true })).resolves.toHaveLength(1);
      await expect(sut.getTimeBuckets(factory.auth({ user: owner }), { isFavorite: true })).resolves.toHaveLength(0);
    });

    it('should flag the asset as favorite inside an album bucket for the favoriting user only', async () => {
      const { sut, ctx } = setup();
      const { owner, member, asset, album } = await setupSharedAlbum(ctx);
      await ctx.get(AssetRepository).addFavorites(member.id, [asset.id]);
      const bucket = (await sut.getTimeBuckets(factory.auth({ user: member }), { albumId: album.id }))[0].timeBucket;

      const read = async (user: typeof member) =>
        JSON.parse(await sut.getTimeBucket(factory.auth({ user }), { albumId: album.id, timeBucket: bucket }));

      expect((await read(member)).isFavorite).toEqual([true]);
      expect((await read(owner)).isFavorite).toEqual([false]);
    });

    it('should list a favorited partner asset on the favorites timeline', async () => {
      const { sut, ctx } = setup();
      const { user: sharer } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      await ctx.newPartner({ sharedById: sharer.id, sharedWithId: viewer.id });
      const { asset } = await ctx.newAsset({ ownerId: sharer.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      await ctx.get(AssetRepository).addFavorites(viewer.id, [asset.id]);

      await expect(sut.getTimeBuckets(factory.auth({ user: viewer }), { isFavorite: true })).resolves.toHaveLength(1);
    });

    it('should hide a stale favorite after access was lost', async () => {
      const { sut, ctx } = setup();
      const { member, asset, album } = await setupSharedAlbum(ctx);
      await ctx.get(AssetRepository).addFavorites(member.id, [asset.id]);
      await ctx.database.deleteFrom('album_user').where('albumId', '=', album.id).where('userId', '=', member.id).execute();

      await expect(sut.getTimeBuckets(factory.auth({ user: member }), { isFavorite: true })).resolves.toHaveLength(0);
    });

    it('should keep the owner favorite behaviour unchanged', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      await expect(sut.getTimeBuckets(factory.auth({ user }), { isFavorite: true })).resolves.toHaveLength(1);
      await expect(sut.getTimeBuckets(factory.auth({ user }), { isFavorite: false })).resolves.toHaveLength(0);
    });
  });
```

If `ctx.newPartner` creates the partner with `inTimeline` default and the check requires something else, adjust only the arguments. `getTimeBucket` requires the timeBucket string in `YYYY-MM-DD` form as returned by `getTimeBuckets`.

- [ ] **Step 2: Run to verify failure**

Run: `cd server && pnpm test:medium -- test/medium/specs/services/timeline.service.spec.ts -t "shared favorites"`
Expected: FAIL (first, second, third tests; stale and owner tests may pass already).

- [ ] **Step 3: Add the SQL helpers**

In `server/src/utils/database.ts`, directly after `inSharedAlbum` (line ~305) add:

```ts
// the viewer's favorite state: the owner's own flag, or a per-user row for assets shared with them
export function isFavoriteFor(userId: string) {
  const eb = expressionBuilder<DB, 'asset'>();
  return eb.or([
    eb.and([eb('asset.ownerId', '=', userId), eb('asset.isFavorite', '=', true)]),
    eb.exists(
      eb
        .selectFrom('asset_favorite')
        .select(sql.lit(1).as('exists'))
        .whereRef('asset_favorite.assetId', '=', 'asset.id')
        .where('asset_favorite.userId', '=', userId),
    ),
  ]);
}

// readable through another user: a shared album the user is a member of, or a partner share
export function isSharedWith(userId: string) {
  const eb = expressionBuilder<DB, 'asset'>();
  return eb.or([
    inSharedAlbum(userId, 'asset.id'),
    eb.exists(
      eb
        .selectFrom('partner')
        .select(sql.lit(1).as('exists'))
        .whereRef('partner.sharedById', '=', 'asset.ownerId')
        .where('partner.sharedWithId', '=', userId),
    ),
  ]);
}

// a favorite row only counts while the user still has access, so stale rows stay hidden
export function isSharedFavoriteFor(userId: string) {
  const eb = expressionBuilder<DB, 'asset'>();
  return eb.and([
    eb.exists(
      eb
        .selectFrom('asset_favorite')
        .select(sql.lit(1).as('exists'))
        .whereRef('asset_favorite.assetId', '=', 'asset.id')
        .where('asset_favorite.userId', '=', userId),
    ),
    isSharedWith(userId),
  ]);
}
```

(`expressionBuilder`, `sql`, `DB` are already imported in this file because `inSharedAlbum` uses them.)

- [ ] **Step 4: Use them in `getTimeBuckets` and `getTimeBucket`**

In `server/src/repositories/asset.repository.ts`, update the import from `src/utils/database.js` to include `isFavoriteFor` and `isSharedFavoriteFor`.

In **both** `getTimeBuckets` and `getTimeBucket`, replace the `userIds` block

```ts
          .$if(!!options.userIds, (qb) =>
            qb.where((eb) => {
              ...
              return options.personId ? eb.or([isOwner, inSharedAlbum(auth.user.id, 'asset.id')]) : isOwner;
            }),
          )
```
with (keep the existing `const isOwner = ...` line and the `TODO` comment in `getTimeBuckets` if you like):

```ts
          .$if(!!options.userIds, (qb) =>
            qb.where((eb) => {
              const isOwner = eb('asset.ownerId', '=', anyUuid(options.userIds!));
              const alternatives = [];
              if (options.personId) {
                alternatives.push(inSharedAlbum(auth.user.id, 'asset.id'));
              }
              if (options.isFavorite === true) {
                // the favorites view also lists assets other users shared with the viewer
                alternatives.push(isSharedFavoriteFor(auth.user.id));
              }
              return alternatives.length > 0 ? eb.or([isOwner, ...alternatives]) : isOwner;
            }),
          )
```

and replace

```ts
          .$if(options.isFavorite !== undefined, (qb) => qb.where('asset.isFavorite', '=', options.isFavorite!))
```
with (both methods)
```ts
          .$if(options.isFavorite !== undefined, (qb) =>
            qb.where((eb) => (options.isFavorite ? isFavoriteFor(auth.user.id) : eb.not(isFavoriteFor(auth.user.id)))),
          )
```

In `getTimeBucket` replace the select line

```ts
            sql`asset."isFavorite" and asset."ownerId" = ${auth.user.id}`.as('isFavorite'),
```
with
```ts
            isFavoriteFor(auth.user.id).as('isFavorite'),
```

`TimelineService.timeBucketChecks` already rejects `isFavorite` combined with other users, so the extra OR branch is only reachable for the viewer's own timeline.

- [ ] **Step 5: Run the timeline medium tests**

Run: `cd server && pnpm test:medium -- test/medium/specs/services/timeline.service.spec.ts`
Expected: all PASS.

- [ ] **Step 6: Failing unit test for the asset response**

In `server/src/services/asset.service.spec.ts`, inside `describe('get'` (it contains a test around line 86 using `sut.get(authStub.admin, asset.id)`), add:

```ts
    it('should report viewer favorite state for an asset the user does not own', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.asset.getFavoriteIds.mockResolvedValue(new Set([asset.id]));

      const result = await sut.get(authStub.admin, asset.id);

      expect(mocks.asset.getFavoriteIds).toHaveBeenCalledWith(authStub.admin.user.id, [asset.id]);
      expect(result).toMatchObject({ id: asset.id, isFavorite: true });
    });

    it('should not look up shared favorites for owned assets', async () => {
      const asset = AssetFactory.from().owner(authStub.admin.user).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.get(authStub.admin, asset.id);

      expect(mocks.asset.getFavoriteIds).not.toHaveBeenCalled();
    });
```

Run: `cd server && pnpm test -- src/services/asset.service.spec.ts -t "favorite state|shared favorites for owned"`
Expected: FAIL.

- [ ] **Step 7: Implement `favoriteIds` in `mapAsset`**

In `server/src/dtos/asset-response.dto.ts`:

```ts
export type AssetMapOptions = {
  withStack?: boolean;
  auth?: AuthDto;
  // favorites the viewer set on assets they do not own
  favoriteIds?: ReadonlySet<string>;
};
```
and replace
```ts
    isFavorite: options.auth?.user.id === entity.ownerId && entity.isFavorite,
```
with
```ts
    isFavorite:
      options.auth?.user.id === entity.ownerId ? entity.isFavorite : (options.favoriteIds?.has(entity.id) ?? false),
```

- [ ] **Step 8: Add the helper in `asset.util.ts`**

Append to `server/src/utils/asset.util.ts` (`AuthDto` and `AssetRepository` are already imported there):

```ts
// favorites the viewer set on assets they do not own; owned assets use the asset row itself
export const getViewerFavoriteIds = async (
  repository: Pick<AssetRepository, 'getFavoriteIds'>,
  auth: AuthDto,
  assets: Array<{ id: string; ownerId: string }>,
): Promise<ReadonlySet<string>> => {
  if (auth.sharedLink) {
    return new Set();
  }

  const ids = assets.filter(({ ownerId }) => ownerId !== auth.user.id).map(({ id }) => id);
  return ids.length > 0 ? repository.getFavoriteIds(auth.user.id, ids) : new Set();
};
```

- [ ] **Step 9: Use it in `AssetService.get`**

In `server/src/services/asset.service.ts` add `getViewerFavoriteIds` to the existing `src/utils/asset.util.js` import, and change the end of `get`:

```ts
    const favoriteIds = await getViewerFavoriteIds(this.assetRepository, auth, [asset]);
    return mapAsset(asset, { withStack: true, auth, favoriteIds });
```

- [ ] **Step 10: Run unit tests + typecheck**

Run: `cd server && pnpm test -- src/services/asset.service.spec.ts && pnpm check`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add server/src
git add server/test/medium/specs/services/timeline.service.spec.ts
git commit -m "feat(server): report per-user favorite state for shared assets in timeline and asset info"
```

---

### Task 4: Search results, search filters and statistics

**Files:**
- Modify: `server/src/services/search.service.ts` (`mapResponse` ~369, list mappers at ~150, ~165, ~278)
- Modify: `server/src/utils/database.ts` (legacy builder `userIds` ~496 and `isFavorite` ~528; V3 `branchPredicates` ~743 and `searchAssetBuilder` ~829-836)
- Modify: `server/src/repositories/asset.repository.ts` (`getStatistics` ~710)
- Test: `server/src/services/search.service.spec.ts`
- Test: `server/test/medium/specs/services/asset.service.spec.ts` (statistics) and a search medium spec (see Step 1)

**Interfaces:**
- Consumes: `isFavoriteFor`, `isSharedFavoriteFor`, `getViewerFavoriteIds` (Task 3).
- Produces: search responses carry viewer favorite state; `isFavorite` filter and statistics are viewer-aware.

- [ ] **Step 1: Failing medium test for the legacy search filter and statistics**

Add to `server/test/medium/specs/services/asset.service.spec.ts` inside `describe('shared favorites'` (from Task 2), reusing its imports:

```ts
    it('should count shared favorites in statistics for the favoriting user', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: member } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: owner.id });
      const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });
      await ctx.get(AssetRepository).addFavorites(member.id, [asset.id]);

      const memberStats = await sut.getStatistics(factory.auth({ user: member }), { isFavorite: true });
      const ownerStats = await sut.getStatistics(factory.auth({ user: owner }), { isFavorite: true });

      expect(memberStats.images).toBe(1);
      expect(ownerStats.images).toBe(0);
    });
```

Then create `server/test/medium/specs/services/search.service.spec.ts` only if it does not exist (`ls server/test/medium/specs/services | grep search`; it does not at planning time). Model it on `timeline.service.spec.ts`'s `setup()` with `real: [SearchRepository, AccessRepository, PartnerRepository, AssetRepository]` and `mock: [LoggingRepository]`. If `SearchRepository` cannot be constructed that way, put this test in `server/test/medium/specs/repositories/asset.repository.spec.ts` style by calling `SearchRepository.searchMetadata` directly instead. Test body:

```ts
describe(SearchService.name, () => {
  it('should find a favorited shared-album asset with the legacy isFavorite filter', async () => {
    const { sut, ctx } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: member } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    await ctx.newExif({ assetId: asset.id, make: 'Canon' });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
    await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });
    await ctx.get(AssetRepository).addFavorites(member.id, [asset.id]);

    const asMember = await sut.searchMetadata(factory.auth({ user: member }), { isFavorite: true });
    expect(asMember.assets.items.map(({ id }) => id)).toEqual([asset.id]);
    expect(asMember.assets.items[0].isFavorite).toBe(true);

    const asOwner = await sut.searchMetadata(factory.auth({ user: owner }), { isFavorite: true });
    expect(asOwner.assets.items).toHaveLength(0);

    const unfavorited = await sut.searchMetadata(factory.auth({ user: member }), { isFavorite: false });
    expect(unfavorited.assets.items).toHaveLength(0);
  });
});
```

Run: `cd server && pnpm test:medium -- test/medium/specs/services -t "shared favorites|legacy isFavorite"`
Expected: FAIL.

- [ ] **Step 2: Statistics**

In `AssetRepository.getStatistics` (server/src/repositories/asset.repository.ts) replace

```ts
      .where('ownerId', '=', asUuid(ownerId))
```
with
```ts
      .where((eb) => {
        const owned = eb('asset.ownerId', '=', asUuid(ownerId));
        // the favorites count also covers assets other users shared with this user
        return isFavorite === true ? eb.or([owned, isSharedFavoriteFor(ownerId)]) : owned;
      })
```
and replace
```ts
      .$if(isFavorite !== undefined, (qb) => qb.where('isFavorite', '=', isFavorite!))
```
with
```ts
      .$if(isFavorite !== undefined, (qb) =>
        qb.where((eb) => (isFavorite ? isFavoriteFor(ownerId) : eb.not(isFavoriteFor(ownerId)))),
      )
```
(`ownerId` here is the viewing user id; `AssetService.getStatistics` passes `auth.user.id`.)

- [ ] **Step 3: Legacy search builder**

In `server/src/utils/database.ts`, in the legacy builder (the function containing `options.encodedVideoPath`), replace

```ts
    .$if(!!options.userIds, (qb) => qb.where('asset.ownerId', '=', anyUuid(options.userIds!)))
```
with
```ts
    .$if(!!options.userIds, (qb) =>
      qb.where((eb) => {
        const isOwner = eb('asset.ownerId', '=', anyUuid(options.userIds!));
        // favorites search also covers assets other users shared with the viewer
        return options.isFavorite === true && options.viewingUserId
          ? eb.or([isOwner, isSharedFavoriteFor(options.viewingUserId)])
          : isOwner;
      }),
    )
```
and replace
```ts
    .$if(options.isFavorite !== undefined, (qb) => qb.where('asset.isFavorite', '=', options.isFavorite!))
```
with
```ts
    .$if(options.isFavorite !== undefined, (qb) =>
      options.viewingUserId
        ? qb.where((eb) =>
            options.isFavorite ? isFavoriteFor(options.viewingUserId!) : eb.not(isFavoriteFor(options.viewingUserId!)),
          )
        : qb.where('asset.isFavorite', '=', options.isFavorite!),
    )
```

- [ ] **Step 4: V3 predicates**

Change `branchPredicates` to take the viewer id:

```ts
function branchPredicates(eb: AssetExpressionBuilder, branch: SearchFilterBranch, viewerId?: string) {
```
and replace the line `...(branch.isFavorite ? [eb('asset.isFavorite', '=', branch.isFavorite.eq)] : []),` with

```ts
    ...(branch.isFavorite
      ? [
          viewerId
            ? branch.isFavorite.eq
              ? isFavoriteFor(viewerId)
              : eb.not(isFavoriteFor(viewerId))
            : eb('asset.isFavorite', '=', branch.isFavorite.eq),
        ]
      : []),
```
In `searchAssetBuilder` update both calls: `branchPredicates(eb, filter, scope.viewingUserId)` and `branchPredicates(eb, branch, scope.viewingUserId)`. If lint rejects the nested ternary (`unicorn/no-nested-ternary`), extract a small local function `favoritePredicate(eb, eq, viewerId)` above `branchPredicates`.

- [ ] **Step 5: Search result mapping**

In `server/src/services/search.service.ts` add `getViewerFavoriteIds` to imports from `src/utils/asset.util.js` (add the import line if the file has none from that module).

Replace `mapResponse` with an async version and add a list mapper:

```ts
  private async mapAssets(auth: AuthDto, assets: MapAsset[], options: AssetMapOptions = {}): Promise<AssetResponseDto[]> {
    const favoriteIds = await getViewerFavoriteIds(this.assetRepository, auth, assets);
    return assets.map((asset) => mapAsset(asset, { ...options, auth, favoriteIds }));
  }

  private async mapResponse(
    auth: AuthDto,
    assets: MapAsset[],
    options: AssetMapOptions,
    page: { nextPage?: string | null; nextCursor?: string | null } = {},
  ): Promise<SearchResponseDto> {
    return {
      albums: { total: 0, count: 0, items: [], facets: [] },
      assets: {
        total: assets.length,
        count: assets.length,
        items: await this.mapAssets(auth, assets, options),
        facets: [],
        nextPage: page.nextPage ?? null,
        nextCursor: page.nextCursor ?? null,
      },
    };
  }
```

Update every caller: `this.mapResponse(items, { auth }, ...)` becomes `this.mapResponse(auth, items, { auth }, ...)` (callers at roughly lines 113, 197, 258, 299), and the two list mappers `return items.map((item) => mapAsset(item, { auth }));` in `searchRandom`, `searchLargeAssets` and `searchRandomV3` become `return this.mapAssets(auth, items);`. Leave `searchPlaces`, `getAssetsByCity`, explore data as they are. Make sure each enclosing method is `async` or already returns a Promise (`return this.mapResponse(...)` from a Promise-returning method is fine).

- [ ] **Step 6: Unit test for search mapping**

In `server/src/services/search.service.spec.ts` add (reuse the existing metadata-search test setup in that file — look for the first `searchMetadata` test and copy its arrange section; the lines below show the new assertions):

```ts
  it('should report viewer favorites for non-owned search results', async () => {
    const auth = AuthFactory.create();
    const asset = AssetFactory.create(); // owned by someone else
    mocks.search.searchMetadata.mockResolvedValue({ hasNextPage: false, items: [getForAsset(asset)] });
    mocks.asset.getFavoriteIds.mockResolvedValue(new Set([asset.id]));

    const result = await sut.searchMetadata(auth, {});

    expect(mocks.asset.getFavoriteIds).toHaveBeenCalledWith(auth.user.id, [asset.id]);
    expect(result.assets.items[0].isFavorite).toBe(true);
  });
```
Add missing imports (`AssetFactory` from `test/factories/asset.factory.js`, `getForAsset` from `test/mappers.js`) if absent. `getUserIdsToSearch` needs `mocks.partner.getAll` (already set in `beforeEach`).

- [ ] **Step 7: Run everything touched**

Run:
```
cd server && pnpm test -- src/services/search.service.spec.ts src/services/asset.service.spec.ts
cd server && pnpm test:medium -- test/medium/specs/services
cd server && pnpm check && pnpm lint
```
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src server/test
git commit -m "feat(server): make favorite search filter, statistics and results viewer-aware"
```

---

### Task 5: Web — show favorite actions for non-owned assets

**Files:**
- Modify: `web/src/lib/services/asset.service.ts` (`Favorite` ~207, `Unfavorite` ~215)
- Modify: `web/src/lib/components/timeline/actions/FavoriteAction.svelte` (line 29)
- Modify: 5 pages, moving `<FavoriteAction>` out of the `isAllUserOwned` guard:
  - `web/src/routes/(user)/photos/[[assetId=id]]/+page.svelte` (~125)
  - `web/src/routes/(user)/recently-added/[[photos=photos]]/[[assetId=id]]/+page.svelte` (~109)
  - `web/src/routes/(user)/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]/+page.svelte` (~398)
  - `web/src/routes/(user)/map/[[photos=photos]]/[[assetId=id]]/MapTimelinePanel.svelte` (~128)
  - `web/src/routes/(user)/search/[[photos=photos]]/[[assetId=id]]/+page.svelte` (~360)
- Test: `web/src/lib/services/asset.service.spec.ts`

**Interfaces:**
- Consumes: server accepting favorite-only updates for readable non-owned assets (Task 2).

- [ ] **Step 1: Failing web unit tests**

In `web/src/lib/services/asset.service.spec.ts`, inside `describe('getAssetActions'` after the first test add:

```ts
    it('should offer favorite to a logged-in user who does not own the asset', () => {
      const user = userAdminFactory.build({ id: 'viewer' });
      const asset = assetFactory.build({ ownerId: 'someone-else', isFavorite: false });
      authManager.setUser(user);
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.Favorite.$if?.()).toStrictEqual(true);
      expect(assetActions.Unfavorite.$if?.()).toStrictEqual(false);
    });

    it('should offer unfavorite for a favorited asset the user does not own', () => {
      const user = userAdminFactory.build({ id: 'viewer' });
      const asset = assetFactory.build({ ownerId: 'someone-else', isFavorite: true });
      authManager.setUser(user);
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.Favorite.$if?.()).toStrictEqual(false);
      expect(assetActions.Unfavorite.$if?.()).toStrictEqual(true);
    });

    it('should not offer favorite on a shared link for a non-owner', () => {
      const user = userAdminFactory.build({ id: 'viewer' });
      const asset = assetFactory.build({ ownerId: 'someone-else', isFavorite: false });
      authManager.setUser(user);
      setSharedLink(sharedLinkFactory.build());
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.Favorite.$if?.()).toStrictEqual(false);
    });
```

Run: `cd web && pnpm test -- src/lib/services/asset.service.spec.ts`
Expected: the first two FAIL (the third may already pass). If a previous test left a shared link set, call `setSharedLink(undefined as never)` hmm — instead check how the existing spec resets it (`grep -n "setSharedLink" web/src/lib/services/asset.service.spec.ts`) and mirror that cleanup in `beforeEach` so the first two tests are not affected.

- [ ] **Step 2: Change the viewer actions**

In `web/src/lib/services/asset.service.ts` replace

```ts
    $if: () => isOwner && !asset.isFavorite,
```
with
```ts
    $if: () => canFavorite && !asset.isFavorite,
```
and
```ts
    $if: () => isOwner && asset.isFavorite,
```
with
```ts
    $if: () => canFavorite && asset.isFavorite,
```
and define right after the `isOwner` constant (line ~151):

```ts
  // any logged-in user who can see the asset may favorite it; shared link guests may not
  const canFavorite = !!authUser && (isOwner || !sharedLink);
```

- [ ] **Step 3: Bulk action over every selected asset**

In `FavoriteAction.svelte` replace

```ts
      const assets = assetMultiSelectManager.ownedAssets.filter((asset) => asset.isFavorite !== isFavorite);
```
with
```ts
      const assets = assetMultiSelectManager.assets.filter((asset) => asset.isFavorite !== isFavorite);
```

- [ ] **Step 4: Move `FavoriteAction` out of the owner guard on 5 pages**

For each page, the action currently sits inside `{#if assetMultiSelectManager.isAllUserOwned} ... {/if}` together with owner-only items. Move only `FavoriteAction` above the guard; keep everything else inside.

`photos/+page.svelte` and `recently-added/+page.svelte` — change

```svelte
    {#if assetMultiSelectManager.isAllUserOwned}
      <FavoriteAction
        removeFavorite={assetMultiSelectManager.isAllFavorite}
        onFavorite={(ids, isFavorite) => timelineManager.update(ids, (asset) => (asset.isFavorite = isFavorite))}
      />

      <ButtonContextMenu ...
```
into

```svelte
    <FavoriteAction
      removeFavorite={assetMultiSelectManager.isAllFavorite}
      onFavorite={(ids, isFavorite) => timelineManager.update(ids, (asset) => (asset.isFavorite = isFavorite))}
    />

    {#if assetMultiSelectManager.isAllUserOwned}
      <ButtonContextMenu ...
```
(same edit in `MapTimelinePanel.svelte` with its indentation, and in the album page where the `FavoriteAction` is followed by `/>`-style `></FavoriteAction>` and then `ButtonContextMenu` — there, wrap only the existing `<FavoriteAction ...></FavoriteAction>` out of the `{#if}` and re-open the `{#if}` around the remaining `ChangeDate`/`ChangeDescription` items; in the album page the `{#if assetMultiSelectManager.isAllUserOwned}` at ~398 encloses only the FavoriteAction, so simply delete the `{#if}`/`{/if}` pair around it).

`search/+page.svelte` (~360): the `{#if assetMultiSelectManager.isAllUserOwned}` block starts with `FavoriteAction` whose `onFavorite` mutates `searchResultAssets`; move that `<FavoriteAction ... />` element (complete with its `onFavorite` body) before the `{#if}` and leave the remaining children inside.

After each edit read the surrounding 30 lines and confirm `{#if}`/`{/if}` pairs still balance.

- [ ] **Step 5: Run web checks**

Run:
```
cd web && pnpm test -- src/lib/services/asset.service.spec.ts
cd web && pnpm check && pnpm lint
```
Expected: PASS, no svelte-check errors.

- [ ] **Step 6: Commit**

```bash
git add web
git commit -m "feat(web): allow favoriting photos the user does not own"
```

---

### Task 6: E2E, query snapshots, final verification

**Files:**
- Create: `e2e/src/specs/server/api/shared-favorite.e2e-spec.ts`
- Modify: `server/src/queries/*.sql` (regenerated)

- [ ] **Step 1: Write the e2e spec**

`e2e/src/specs/server/api/shared-favorite.e2e-spec.ts`:

```ts
import { AlbumUserRole, LoginResponseDto } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

describe('shared favorites', () => {
  let owner: LoginResponseDto;
  let member: LoginResponseDto;
  let stranger: LoginResponseDto;
  let assetId: string;

  beforeAll(async () => {
    await utils.resetDatabase();
    const admin = await utils.adminSetup({ onboarding: false });
    [owner, member, stranger] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.create('fav-owner')),
      utils.userSetup(admin.accessToken, createUserDto.create('fav-member')),
      utils.userSetup(admin.accessToken, createUserDto.create('fav-stranger')),
    ]);

    const asset = await utils.createAsset(owner.accessToken);
    assetId = asset.id;
    await utils.createAlbum(owner.accessToken, {
      albumName: 'shared',
      assetIds: [assetId],
      albumUsers: [{ userId: member.userId, role: AlbumUserRole.Viewer }],
    });
  });

  it('should let an album viewer favorite a photo and see it as a favorite only for themselves', async () => {
    const { status, body } = await request(app)
      .put(`/assets/${assetId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ isFavorite: true });
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: assetId, isFavorite: true });

    const asMember = await utils.getAssetInfo(member.accessToken, assetId);
    const asOwner = await utils.getAssetInfo(owner.accessToken, assetId);
    expect(asMember.isFavorite).toBe(true);
    expect(asOwner.isFavorite).toBe(false);
  });

  it('should list the favorite on the favorites timeline and in statistics of the member only', async () => {
    const memberBuckets = await request(app)
      .get('/timeline/buckets')
      .query({ isFavorite: true })
      .set('Authorization', `Bearer ${member.accessToken}`);
    expect(memberBuckets.status).toBe(200);
    expect(memberBuckets.body).toHaveLength(1);

    const ownerBuckets = await request(app)
      .get('/timeline/buckets')
      .query({ isFavorite: true })
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(ownerBuckets.body).toHaveLength(0);

    const stats = await request(app)
      .get('/assets/statistics')
      .query({ isFavorite: true })
      .set('Authorization', `Bearer ${member.accessToken}`);
    expect(stats.body).toMatchObject({ images: 1 });
  });

  it('should find the favorite via search for the member', async () => {
    const { status, body } = await request(app)
      .post('/search/metadata')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ isFavorite: true });
    expect(status).toBe(200);
    expect(body.assets.items.map(({ id }: { id: string }) => id)).toEqual([assetId]);
  });

  it('should not let a non-owner change other fields', async () => {
    const { status } = await request(app)
      .put(`/assets/${assetId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ isFavorite: true, description: 'nope' });
    expect(status).toBe(400);
  });

  it('should reject a user without access', async () => {
    const { status } = await request(app)
      .put(`/assets/${assetId}`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .send({ isFavorite: true });
    expect(status).toBe(400);
  });

  it('should unfavorite', async () => {
    const { status, body } = await request(app)
      .put(`/assets/${assetId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ isFavorite: false });
    expect(status).toBe(200);
    expect(body).toMatchObject({ isFavorite: false });
  });
});
```

If `createAsset` yields assets without exif so the timeline is empty, mirror what `asset.e2e-spec.ts` does before reading timeline buckets (e.g. `await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction')` after creating the asset).

- [ ] **Step 2: Run the e2e spec (needs the e2e docker stack)**

Run: `cd e2e && pnpm test -- src/specs/server/api/shared-favorite.e2e-spec.ts`
Expected: PASS. If the stack cannot be started in the current environment, say so explicitly in the handoff instead of claiming it passed.

- [ ] **Step 3: Regenerate the SQL query snapshots**

Run: `cd server && pnpm build && mise run sql` (or `node ./dist/bin/sync-sql.js` with a Postgres reachable at `DB_URL`; see `server/mise.toml` task `sql`).
Expected: `git status` shows modified `server/src/queries/asset.repository.sql` (new `getFavoriteIds`, `addFavorites`, `removeFavorites`, changed `getTimeBuckets`/`getTimeBucket`/`getStatistics`) and possibly `search.repository.sql`. Review the diff for sanity: no unrelated churn.

- [ ] **Step 4: Full verification**

Run:
```
cd server && pnpm check:code && pnpm test
cd server && pnpm test:medium
cd web && pnpm check:all
```
Expected: all green. Fix anything that regressed before committing.

- [ ] **Step 5: Manual check in the web UI (dev stack running)**

1. User A owns a photo in an album shared with user B (viewer role). Log in as B.
2. Open the photo in the viewer: heart button visible; click it; toast "Added to favorites"; heart is filled.
3. Open Favorites as B: photo listed. Open Favorites as A: photo NOT listed; A's viewer shows it unfavorited.
4. As B select several photos from the album timeline (mixed with own photos) and bulk-favorite; Favorites count increments for all.
5. Remove B from the album: photo disappears from B's Favorites. Re-add B: photo is back as favorite.

- [ ] **Step 6: Commit**

```bash
git add e2e/src/specs/server/api/shared-favorite.e2e-spec.ts server/src/queries
git commit -m "test: e2e coverage for shared favorites and regenerate query snapshots"
```
