# Shared-asset favorites and album filter in search

Date: 2026-10-25
Scope: server + web. Mobile is explicitly out of scope (follow-up).

Two independent features, specified together but implementable and shippable separately.

## Feature 1: Favorite photos you don't own

### Problem

`asset.isFavorite` is a single boolean on the asset row, and `PUT /assets` requires owner access (`Permission.AssetUpdate` -> `checkOwnerAccess`, `server/src/utils/access.ts`). Users who can see a photo through a shared album or a partner share cannot favorite it. The asset response also hardcodes `isFavorite` to `false` for non-owners (`server/src/dtos/asset-response.dto.ts`).

### Decisions

- Favorites for non-owned photos are **per user** (not a shared flag on the asset).
- Anyone with `Permission.AssetRead` on the asset may favorite it: owner, shared-album member (viewers included), or partner. No new access logic.
- The `asset.isFavorite` column stays the source of truth for a user's own photos, so the Android app, sync streams and every code path that writes the column directly (upload, sidecar/metadata import, copy, old clients) keep working. No column removal.
- `asset_favorite` also mirrors the owner's favorites: the migration backfills one row `(ownerId, id)` for every asset with `isFavorite = true`, and `PUT /assets` keeps the mirror in sync afterwards. The mirror is never read for owned assets, because the column can change behind it.
- Mobile/sync streams keep reading the raw column. Mobile shows non-owned favorites as unfavorited until a follow-up.

### Data model

New table `asset_favorite`:

| column    | type        | notes                                  |
| --------- | ----------- | -------------------------------------- |
| userId    | uuid        | FK user, ON DELETE CASCADE, PK part 1  |
| assetId   | uuid        | FK asset, ON DELETE CASCADE, PK part 2 |
| createdAt | timestamptz | default now()                          |

Index on `assetId`. Rows come in two kinds:

- **Non-owned assets** (`asset.ownerId <> userId`): the source of truth for that user's favorite.
- **Owned assets** (`asset.ownerId = userId`): a mirror of `asset.isFavorite`. It is backfilled by the migration (`INSERT ... SELECT "ownerId", "id" FROM asset WHERE "isFavorite" = true ON CONFLICT DO NOTHING`, including archived and trashed assets; `down` just drops the table) and kept in sync by `PUT /assets/:id` and `PUT /assets`. Other writers of the column do not touch it, so an owner row can be missing or stale; reads must ignore it.

### Write path

`PUT /assets/:id` and bulk `PUT /assets` (`server/src/services/asset.service.ts`):

- If the DTO contains only `isFavorite`, split ids by ownership:
  - owned ids -> existing update path (column, events, `updatedAt`), then the owner row is mirrored (insert on favorite, delete on unfavorite);
  - non-owned ids with `AssetRead` -> insert/delete rows in `asset_favorite`. No asset row change, no `AssetUpdate` event, no `updatedAt` bump (keeps sync untouched).
- Any other field in the DTO still requires ownership. When such an owner-only request also carries `isFavorite`, the owner row is mirrored the same way.
- Requests that do not carry `isFavorite` never touch `asset_favorite`.
- Ids that are neither owned nor readable fail with the usual access error.

### Read path

A shared Kysely helper `isFavoriteFor(eb, userId)`:

```
(asset.ownerId = :viewer AND asset.isFavorite)
OR (asset.ownerId <> :viewer AND EXISTS (SELECT 1 FROM asset_favorite WHERE userId = :viewer AND assetId = asset.id))
```

For owned assets only the column counts, so a stale or missing owner row can neither make an asset appear favorited when the column is false nor hide one the column marks as favorite. `isSharedFavoriteFor` (the extra "also list favorites shared with me" branch of the favorites timeline, search and statistics) likewise requires `asset.ownerId <> :viewer`; non-owned behavior, including hiding stale rows once access is lost, is unchanged. `getViewerFavoriteIds` only looks up non-owned ids, and shared links read the column only.

Replaces raw `asset.isFavorite` reads in:

- asset response mapping (viewer state comes from the query, not inferred from `ownerId`);
- timeline buckets: `isFavorite` filter and per-asset `isFavorite` array (`asset.repository.ts`);
- search: legacy `options.isFavorite` filter and `filter.isFavorite` predicate (`server/src/utils/database.ts`);
- asset statistics (favorites count);
- map markers: unchanged (decided during planning).

Not changed: `sync.repository.ts` and sync DTOs.

If album/partner access is lost, rows remain but existing access checks hide the asset; regaining access restores the favorite.

Generated query snapshots (`server/src/queries/*.sql`) must be regenerated.

### Web

- Heart toggle (asset viewer) and bulk favorite action (timeline selection bar) are gated on read access, not ownership.
- No OpenAPI/SDK regeneration needed (DTOs unchanged).
- Album-view, memory and shared-link payloads still report `isFavorite: false` for non-owned assets.

### Tests

- Server unit (`asset.service.spec.ts`): owner favorite; non-owner via album; non-owner via partner; no access rejected; non-owner cannot update other fields.
- Medium (real DB): favorite filter and timeline bucket flag for owner, album member, partner; owner favoriting through `PUT /assets` sets the column and the mirror row; a stale owner row is ignored by timeline and statistics; the migration backfill (including trashed and archived favorites) and its `down`/`up` round trip.
- E2E (`e2e/src/api/specs/asset.e2e-spec.ts`): album member favorites a shared photo and sees it under Favorites; owner's own state is unchanged.
- Web unit: toggle visibility.

## Feature 2: Album filter in search

### Current state

The server already supports album filtering: `albumIds` in the search DTO, `inAlbums` (asset must be in all selected albums) and the `filter.albumIds` any/all predicates in `server/src/utils/database.ts`. The web search panel has no album section.

### Design

- Add `SearchAlbumsSection.svelte` to `web/src/lib/components/shared-components/search-bar/`, wired into `SearchFilters.svelte`, modelled on `SearchTagsSection` / `SearchPeopleSection`. Multi-select of albums the user owns or has shared access to.
- Send selection as `albumIds` in the search request (all-of semantics, matching people/tags).
- Persist in search query state and URL params like the other sections.
- No server changes expected. During planning, verify that album-confined search returns photos the user does not own when filtering by a shared album (see the album-confined comment near `database.ts:806`).
- Mobile out of scope.

### Planning findings

- Album-confined smart search does not work today for non-owned photos: `searchSmart` needs an `AlbumRead` access check on `albumIds` and must not force `userIds` to the viewer. A small server fix is part of the album-filter plan.
- V3 `filter.isFavorite` is viewer-aware, but the search universe is unchanged: non-owned favorites appear in V3 search only when album-confined.

## Out of scope

Mobile UI and sync changes for either feature; dropping `asset.isFavorite`; any-of album semantics.
