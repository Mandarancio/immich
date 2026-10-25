# Per-user rating, color labels and quick filters

Date: 2026-10-25
Scope: server + web. Mobile and sync are explicitly out of scope (follow-up).

Builds on the shared-favorites work (`2026-10-25-shared-favorites-and-album-search-design.md`). The `asset_favorite` table becomes a general per-user asset state table that also holds a personal rating and a color label.

## Decisions

- Ratings and color labels are **private to each user**, like favorites. No sharing of labels across users.
- Rating storage follows the favorites model:
  - For **owned** assets `asset_exif.rating` stays authoritative (XMP sidecar, Android app, sync streams and the existing search filter keep working). The per-user table mirrors it and is never read for owned assets.
  - For **non-owned** assets (shared-album members including viewers, partners) the rating lives in the per-user table. "Inherit from exif" means a non-owner sees the exif rating until they set their own, and clearing theirs falls back to the exif rating.
- Color labels have no legacy field, so they live only in the per-user table, for owners and non-owners alike.
- Color set: `red`, `yellow`, `green`, `blue`, `purple` (Lightroom/darktable), at most one label per asset per user.
- Anyone with `Permission.AssetRead` on the asset may set state fields. No new access logic.
- Write API: extend the existing update endpoints (no new endpoint).
- Quick filters are a shared bar on every timeline view.
- Mobile and sync streams keep reading `asset.isFavorite` and `asset_exif.rating`. Mobile shows no color labels and no non-owner ratings until a follow-up.

## Data model

New migration `AddAssetUserState` (the existing `AddAssetFavoriteTable` migration is left untouched). It renames `asset_favorite` to `asset_user_state` (including PK, FK and the `assetId` index names) and adds:

| column     | type        | notes                                                             |
| ---------- | ----------- | ----------------------------------------------------------------- |
| isFavorite | boolean     | NOT NULL, default false; existing rows are set to `true`          |
| rating     | smallint    | nullable, CHECK 1-5; null = no personal rating, fall back to exif |
| colorLabel | text        | nullable, CHECK in (`red`,`yellow`,`green`,`blue`,`purple`)       |
| updatedAt  | timestamptz | default now()                                                     |

Existing columns: `userId` (PK, FK user, cascade), `assetId` (PK, FK asset, cascade, indexed), `createdAt`.

- `colorLabel` is a text column with a CHECK constraint (easier to extend than a Postgres enum), exposed as an `AssetColorLabel` enum in the DTOs.
- A row exists only while it holds at least one of favorite, rating or color. Clearing the last one deletes the row.
- Owner rows: the migration also backfills `rating` from `asset_exif.rating` for owned assets that already have a row. The mirror is never read for owned assets.
- `down` reverses the rename and drops the new columns.
- Code rename: `asset-favorite.table.ts` becomes `asset-user-state.table.ts`; `getFavoriteIds` / `addFavorites` / `removeFavorites` become state-aware, and every favorites query gains `WHERE isFavorite`.
- `sync.repository.ts` and sync DTOs are not changed.

## Write path

`PUT /assets/:id` and bulk `PUT /assets` (`server/src/services/asset.service.ts`).

DTOs: add `colorLabel?: AssetColorLabel | null` to both update DTOs. `rating` keeps its type; `null` clears it; 0 stays invalid. The state fields are `isFavorite`, `rating` and `colorLabel`.

Rule:

- A request containing only state fields is allowed for any user with `AssetRead`. Ids are split by ownership, as favorites are today.
- A request containing any other field still requires ownership.
- Ids that are neither owned nor readable fail with the usual access error.
- Shared-link auth is rejected for state fields. Shared links never create or see per-user state.

Per id, per field:

| field      | owner                                                                                      | non-owner                                                   |
| ---------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| isFavorite | column update and events, then mirrored to the table (as today)                            | table `isFavorite`                                          |
| rating     | `asset_exif.rating` update with XMP sidecar write and events (as today), then mirrored     | table `rating`; `null` clears it so the exif rating returns |
| colorLabel | table only                                                                                 | table only                                                  |

- Table writes are one upsert per request touching only the fields present in the DTO; absent fields are left alone.
- After the upsert, rows with `isFavorite = false`, `rating IS NULL` and `colorLabel IS NULL` are deleted.
- Non-owner writes and color-only writes touch no asset row, no `updatedAt` and no event, so sync is unaffected.
- The `ratings.enabled` preference gates only the web UI; the server does not check it.

## Read path

Effective values for viewer V on asset A, as Kysely helpers next to `isFavoriteFor` in `server/src/utils/database.ts`:

- `isFavoriteFor(eb, V)`: unchanged, with `WHERE isFavorite` on the table lookup.
- `ratingFor(eb, V)`: `asset_exif.rating` for owned assets; `COALESCE(state.rating, asset_exif.rating)` for non-owned.
- `colorLabelFor(eb, V)`: V's table value for owned and non-owned assets; null without a row.

Shared-link auth gets a null color and the exif rating only.

Response DTOs:

- `AssetResponseDto` gains `colorLabel`.
- `exifInfo.rating` and any top-level rating carry the effective rating for the viewer. Owners see no difference.
- `mapAsset` receives per-viewer values from the query. A `viewerState` map keyed by asset id replaces `favoriteIds`, and `getViewerFavoriteIds` becomes `getViewerStates`.

Timeline buckets (`asset.repository.ts`, `time-bucket.dto.ts`):

- New filters: `rating` (minimum), `unrated` (boolean), `colorLabels` (any-of, with a `none` value).
- Per-asset arrays gain `rating` and `colorLabel`.

Search:

- Legacy search and V3 `filter.rating` use `ratingFor`.
- New `colorLabels` filter (any-of, plus `none`) in both.
- The search universe is unchanged: non-owned photos appear only when album-confined; the favorites view keeps its shared-favorite branch.

Statistics: unchanged apart from the favorites rename.

Generated files to regenerate: `server/src/queries/*.sql` snapshots, OpenAPI spec and TypeScript SDK. The mobile OpenAPI client is out of scope.

## Web

Shared quick-filter bar in the timeline header, on every timeline view (main timeline, albums, favorites, archive, people, places, tags):

- Favorites: heart toggle.
- Rating: minimum-star selector (1-5, click again to clear) plus an "unrated" toggle.
- Color: five color chips (multi-select, any-of) plus a "no color" chip.
- State lives in a `TimelineManager` filter and is passed to the bucket queries as `isFavorite`, `rating`, `unrated` and `colorLabels`. It resets when navigating to a different view.
- An active-filter indicator with a clear-all button shows when any control is on.

Per-asset UI:

- Asset viewer: `DetailPanelStarRating` is editable by any user with read access (no longer owner-only), still gated on `preferences.ratings.enabled` and hidden for shared links. A new `ColorLabelPicker` sits next to it (five colors plus clear).
- Timeline thumbnails: a color dot and a star badge, rendered from the per-asset bucket arrays. The star badge is hidden when `ratings.enabled` is off; the color dot shows whenever a color is set.
- Selection bar: bulk "set rating" and "set color" actions next to bulk favorite, enabled when every selected asset is readable.
- Keyboard shortcuts (viewer and selection): `0`-`5` set the rating (`0` clears), `6` red, `7` yellow, `8` green, `9` blue (toggle). Purple has no shortcut and is set through the picker. The existing `F` shortcut keeps favoriting.

Search page: `SearchRatingsSection` and the favorites toggle already exist. Add `SearchColorLabelsSection.svelte`, modelled on `SearchPeopleSection`.

## Tests

- Server unit (`asset.service.spec.ts`): non-owner rating and color via album and partner; color-only write; owner rating mirror; clearing the last state deletes the row; no access rejected; shared-link rejected; non-owner cannot update other fields.
- Medium (real DB): effective-rating and color filters for owner, album member and partner in timeline buckets and search; stale owner mirror ignored; the migration rename, `isFavorite` set on existing rows, rating backfill, and `down`/`up` round trip.
- E2E: an album member rates and labels a shared photo and filters by both; the owner's exif rating is unchanged.
- Web unit: filter bar, picker visibility and gating, shortcut handlers.

## Out of scope

Mobile UI and sync changes; dropping `asset.isFavorite` or `asset_exif.rating`; sharing labels across users; any-of album semantics; a rejected/flag state; multiple labels per photo.
