# Culling: Pick/Reject Flags and Compare View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every user flag photos as Pick or Reject (private per user), filter timelines and search by flag, and compare 2-6 similar photos side by side with synced zoom to choose the best shots.

**Architecture:** `asset_user_state` gets a nullable `flag` column handled exactly like `colorLabel` (table-only for everyone, viewer-aware reads, state-only writes for anyone with `AssetRead`, shared links see nothing). The web adds a `flags` quick filter, a thumbnail badge, bulk actions and `K`/`R`/`U` shortcuts, then a full-screen `CompareView` overlay driven by a `CompareManager` (no new route, no server changes in phase B).

**Tech Stack:** NestJS, Kysely/Postgres, `@immich/sql-tools`, zod DTOs, vitest (unit + medium with testcontainers), SvelteKit 5 (runes), `@zoom-image/core`, supertest e2e.

Spec: `docs/superpowers/specs/2026-10-25-culling-flags-and-compare-design.md`. Builds on the per-user state work already on `main` (`asset_user_state`, `colorLabel`, quick filters). Every flag change below deliberately mirrors the existing `colorLabel` change; when in doubt, `git grep -n colorLabel` in the same file shows the pattern to follow.

## Global Constraints

- Phase A is server + web; Phase B is web only. No changes to sync streams, `sync.repository.ts`, sync DTOs or mobile (the mobile OpenAPI client is not regenerated).
- Flag values: `pick`, `reject`, or `null`. Mutually exclusive (setting one replaces the other), at most one per asset per user. Stored only in `asset_user_state.flag`, for owners and non-owners alike (no mirror on `asset`).
- Anyone with `Permission.AssetRead` may set `flag` (it is a state field, like `isFavorite`/`rating`/`colorLabel`). Any other field still requires ownership. Shared-link auth is rejected for state fields and never sees per-user state (null flag; filter `none` matches everything, any value matches nothing).
- A row in `asset_user_state` exists only while it holds at least one of favorite, rating, color label, flag; clearing the last one deletes the row.
- Owner-path early return: a state-only request whose only fields are `colorLabel`/`flag` touches no asset row, no exif, emits no event (same as color today).
- Timeline bucket filter `flags`: comma-separated, any-of, values `pick`, `reject`, `none` (`none` = no flag). Response gets a per-asset `flag` array. Combined with the other filters by AND.
- Search `flags`: same semantics, in the flat DTO and in the structured branch shape; flat-only field (mutually exclusive with the structured filter, add to `FLAT_ONLY_FIELDS`).
- Shortcuts: `K` pick (toggle), `R` reject (toggle), `U` clear flag. Do NOT use `P` or `X` (plain `x` selects a focused thumbnail, plain `p` is Tag people). `C` opens compare. Existing `0`-`5` rating and `6`-`9` color keys stay.
- Compare: 2 to 6 assets; one overlay (no route); preview image first, original on zoom (at most 3 originals loading at once, focused first); reject behavior setting `compareRejectBehavior: 'remove' | 'dim'`, default `'remove'`, browser-local `persisted` store.
- Generated files to regenerate in Phase A: `server/src/queries/asset.repository.sql`, `open-api/immich-openapi-specs.json`, `packages/sdk/src/fetch-client.ts`.
- All commands run from the repo root unless noted. Server unit: `cd server && pnpm vitest --config test/vitest.config.mjs run <file>`. Medium (needs Docker): `cd server && pnpm vitest --config test/vitest.config.medium.mjs run <file> --hookTimeout 120000 --testTimeout 60000`. Web: `cd web && pnpm test run <file>`, `pnpm check:svelte`, `pnpm check:typescript`, `pnpm lint`, `pnpm format`.
- Regenerate OpenAPI: `cd server && pnpm build && node ./dist/bin/sync-open-api.js`, then from root `npx oazapfts --optimistic --argumentStyle=object --useEnumType --allSchemas open-api/immich-openapi-specs.json packages/sdk/src/fetch-client.ts`, then `pnpm --filter @immich/sdk build`. Regenerate SQL snapshot: `cd server && pnpm sync:sql`.
- Known environment-only failures that are NOT regressions: 3 server unit specs using `mkdtempDisposable`, about 30 medium specs, 20 web `thumbnail-util` date tests. IDE squiggles about jest-dom matchers are false positives; `pnpm check:typescript` is the truth.
- Never `git add` anything under `.superpowers/` (git-excluded scratch).

## File Structure

| File | Responsibility |
| --- | --- |
| `server/src/enum.ts` | `AssetFlag` enum + `AssetFlagSchema` |
| `server/src/schema/tables/asset-user-state.table.ts` | `flag` column + CHECK |
| `server/src/schema/migrations/1793000000002-AddAssetUserStateFlag.ts` (new) + `ORDER` | Migration |
| `server/src/repositories/asset.repository.ts` | `UserState`/`UserStateChange` + `flag`, `setUserState` delete rule, bucket `flag` column/array |
| `server/src/utils/database.ts` | `flagFor`, `flagsPredicate`, `viewerFlag`, `viewerFlagsPredicate`, `applyStateFilters`, search builders |
| `server/src/services/asset.service.ts` | `flag` in the state-only write path |
| `server/src/dtos/{asset,asset-response,time-bucket,search}.dto.ts` | Update DTO, response, bucket query/response, search |
| `web/src/lib/utils/flag.ts` (new) | Flag constants, shortcuts, `nextFlag` toggle |
| `web/src/lib/managers/timeline-filter-manager.svelte.ts` | `flags` filter |
| `web/src/lib/components/timeline/TimelineFilterBar.svelte` | Flag chip group |
| `web/src/lib/components/assets/thumbnail/Thumbnail.svelte` | Pick badge, reject dim + X |
| `web/src/lib/components/timeline/actions/SetFlagAction.svelte` (new) | Bulk flag action |
| `web/src/lib/components/shared-components/search-bar/SearchFlagsSection.svelte` (new) | Search flag section |
| `web/src/lib/managers/compare-manager.svelte.ts` (new) | Compare state, layout, focus, zoom sync, original cap |
| `web/src/lib/components/compare/CompareSlot.svelte`, `CompareView.svelte` (new) | Compare UI |
| `web/src/lib/components/timeline/actions/CompareAction.svelte` (new) | Entry action + `C` |
| `web/src/lib/stores/preferences.store.ts` | `compareRejectBehavior` |
| `e2e/src/specs/server/api/user-asset-state.e2e-spec.ts` | Extend with flag |

---

# Phase A: flag

### Task 1: Enum, schema, migration, repository state methods

**Files:**
- Modify: `server/src/enum.ts` (after `AssetColorLabelSchema`, ~line 1252)
- Modify: `server/src/schema/tables/asset-user-state.table.ts`
- Create: `server/src/schema/migrations/1793000000002-AddAssetUserStateFlag.ts`; append `1793000000002-AddAssetUserStateFlag` to `server/src/schema/migrations/ORDER`
- Modify: `server/src/repositories/asset.repository.ts` (types ~69-70, `getUserStates` ~753, `setUserState` ~771)
- Test: `server/test/medium/specs/repositories/asset.repository.spec.ts` (existing `setUserState` tests live here; copy their setup)

**Interfaces:**
- Produces: `AssetFlag` enum (`Pick = 'pick'`, `Reject = 'reject'`), `AssetFlagSchema` (zod, `.meta({ id: 'AssetFlag' })`); `UserState.flag: AssetFlag | null`; `UserStateChange.flag?: AssetFlag | null`; `AssetRepository.setUserState` accepts and clears `flag`.

- [ ] **Step 1: Failing medium tests** in `asset.repository.spec.ts`: (a) `setUserState(user.id, [asset.id], { flag: AssetFlag.Pick })` then `getUserStates` returns `flag: 'pick'`; (b) setting `{ flag: AssetFlag.Reject }` afterwards overwrites; (c) `{ flag: null }` when it is the only state deletes the row (`getUserStates` map has no entry); (d) a row holding `isFavorite: true` plus a flag keeps the row when the flag is cleared; (e) the DB rejects an invalid value (raw insert with `flag = 'maybe'` throws a check violation). Run the medium command on this file: expect FAIL (column missing).

- [ ] **Step 2: Enum**

```ts
export enum AssetFlag {
  Pick = 'pick',
  Reject = 'reject',
}

export const AssetFlagSchema = z.enum(AssetFlag).describe('Asset pick/reject flag').meta({ id: 'AssetFlag' });
```

- [ ] **Step 3: Table** (mirror `colorLabel` in `asset-user-state.table.ts`): add a `@Check({ name: 'asset_user_state_flag_chk', expression: \`"flag" IN ('pick','reject')\` })` next to the colorLabel check, import `AssetFlag`, and

```ts
  @Column({ type: 'text', nullable: true })
  flag!: AssetFlag | null;
```

- [ ] **Step 4: Migration** `1793000000002-AddAssetUserStateFlag.ts`:

```ts
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
```

- [ ] **Step 5: Repository.** `UserState` gets `flag: AssetFlag | null`; `UserStateChange` gets `flag?: AssetFlag | null`; `getUserStates` selects `'flag'` too; `@GenerateSql` params of `setUserState` get `flag: AssetFlag.Pick`; in `setUserState`'s cleanup add `.where('flag', 'is', null)` and update the comment to "favorite, rating, color or flag".
- [ ] **Step 6:** run the medium file again (expect the new tests PASS; the pre-existing ones still pass), then `cd server && pnpm check`. If the repo has a migration/schema drift medium spec (`git grep -l "schema" server/test/medium/specs | head`), run it.
- [ ] **Step 7: Commit** `feat(server): add pick/reject flag to asset_user_state`.

---

### Task 2: DTOs and write path

**Files:**
- Modify: `server/src/dtos/asset.dto.ts` (add next to `colorLabel`, line ~32; `AssetBulkUpdate` extends the same base)
- Modify: `server/src/dtos/asset-response.dto.ts` (field next to `colorLabel` ~99; `mapAsset` ~238)
- Modify: `server/src/services/asset.service.ts` (`STATE_KEYS` line 58; `update` ~99-105; `updateAll` ~150-172; `applyUserState` ~688)
- Test: `server/src/services/asset.service.spec.ts`, `server/src/dtos/asset-response.dto.spec.ts`

**Interfaces:**
- Consumes: `AssetFlagSchema`, `UserStateChange.flag` (Task 1).
- Produces: `PUT /assets/:id` and `PUT /assets` accept `flag: 'pick' | 'reject' | null`; `AssetResponseDto.flag?: AssetFlag | null` (viewer-aware).

Changes (implement exactly):

```ts
// asset.dto.ts, inside the shared update base schema
flag: AssetFlagSchema.nullish().describe('Pick/reject flag (null clears)'),

// asset-response.dto.ts, response schema
flag: AssetFlagSchema.nullable()
  .optional()
  .describe("The viewer's own pick/reject flag")
  .meta(new HistoryBuilder().added('v3.3.0').getExtensions()),
// mapAsset
flag: state?.flag ?? null,

// asset.service.ts
const STATE_KEYS = ['isFavorite', 'rating', 'colorLabel', 'flag'];
```

In `update()`: destructure `flag` alongside `colorLabel` from `dto`; the non-state-only branch becomes

```ts
const ownState = omitBy({ colorLabel, flag }, isUndefined);
if (Object.keys(ownState).length > 0) {
  await this.assetRepository.setUserState(auth.user.id, ids, ownState);
}
```

and the rest-destructure strips both (`colorLabel: _colorLabel, flag: _flag`). The state-only early return (`isFavorite === undefined && rating === undefined`) is unchanged: a color/flag-only request returns after `applyUserState`. Do the same in `updateAll()`. In `applyUserState`, the owned-ids block writes both fields:

```ts
const ownState = omitBy({ colorLabel: dto.colorLabel, flag: dto.flag }, isUndefined);
if (ownedIds.length > 0 && Object.keys(ownState).length > 0) {
  await this.assetRepository.setUserState(auth.user.id, ownedIds, ownState);
}
```

Update the `isStateOnly` comment to mention flag. `UserStateChange` is already the param type, so `others` writes pick up `flag` through `pick(dto, STATE_KEYS)`.

- [ ] **Step 1: Failing unit tests** in `asset.service.spec.ts` (copy the mock setup of the existing `colorLabel` tests there): non-owner (album) `update(id, { flag: 'pick' })` -> `setUserState(user, [id], { flag: 'pick' })`, no `assetRepository.update`/`updateExif`, no event; non-owner `{ flag: null }`; mixed `{ isFavorite: true, rating: 2, colorLabel: 'blue', flag: 'reject' }` is one `setUserState` call with all four; owner `{ flag: 'reject' }` -> `setUserState(user, [id], { flag: 'reject' })` and neither `assetRepository.update` nor `updateAllExif`; owner `{ description: 'x', flag: 'pick' }` -> normal update plus `setUserState`; shared link `{ flag: 'pick' }` -> rejected; no read access -> `BadRequestException`, no `setUserState`; bulk `updateAll` mixed owned/non-owned with `{ flag: 'pick' }` writes `setUserState` for both id sets and no exif/asset update. In `asset-response.dto.spec.ts`: `mapAsset` with `viewerState` carrying `flag: 'pick'` returns `flag: 'pick'`; without viewer state returns `flag: null`. Run both files: expect FAIL.
- [ ] **Step 2: Implement** as above. Re-run: all pass. Run the whole `asset.service.spec.ts` to catch regressions.
- [ ] **Step 3:** `cd server && pnpm check && pnpm lint`. Commit `feat(server): flag write path and response field`.

---

### Task 3: Read helpers and timeline buckets

**Files:**
- Modify: `server/src/utils/database.ts` (new helpers after `colorLabelsPredicate` ~371; `StateFilters`; `applyStateFilters`)
- Modify: `server/src/repositories/asset.repository.ts` (`AssetBuilderOptions` ~97, `getTimeBucket` cte ~906 and agg ~1032)
- Modify: `server/src/dtos/time-bucket.dto.ts` (query ~24, response ~105)
- Test: `server/src/dtos/time-bucket.dto.spec.ts`, `server/test/medium/specs/services/timeline.service.spec.ts`, `server/test/medium/specs/repositories/asset.repository.spec.ts`

**Interfaces:**
- Produces: `flagFor(userId)`, `flagsPredicate(userId, flags)`, `viewerFlag(viewer)`, `viewerFlagsPredicate(viewer, flags)`; `StateFilters.flags`; `AssetBuilderOptions.flags?: Array<AssetFlag | 'none'>`; time bucket response `flag: Array<AssetFlag | null>`.

Helpers (add next to the color ones, same structure):

```ts
export function flagFor(userId: string) {
  return sql<AssetFlag | null>`(${userStateOf(userId).select('asset_user_state.flag')})`;
}

export function flagsPredicate(userId: string, flags: Array<AssetFlag | 'none'>): Expression<SqlBool> {
  const eb = expressionBuilder<DB, 'asset'>();
  const values = flags.filter((flag): flag is AssetFlag => flag !== 'none');
  const conditions: Expression<SqlBool>[] = [];
  if (flags.includes('none')) {
    conditions.push(eb(flagFor(userId), 'is', null));
  }
  if (values.length > 0) {
    conditions.push(eb(flagFor(userId), '=', sql<AssetFlag>`any(${`{${values}}`}::text[])`));
  }
  return eb.or(conditions);
}

export function viewerFlag({ userId, sharedLink }: StateViewer) {
  return sharedLink ? sql<AssetFlag | null>`null::text` : flagFor(userId);
}

export function viewerFlagsPredicate(viewer: StateViewer, flags: Array<AssetFlag | 'none'>) {
  if (viewer.sharedLink) {
    // no flag is ever visible to a shared link, so 'none' matches every asset and any flag matches nothing
    return sql<SqlBool>`${sql.lit(flags.includes('none'))}`;
  }
  return flagsPredicate(viewer.userId, flags);
}
```

`StateFilters` gets `flags?: Array<AssetFlag | 'none'>`; `applyStateFilters` destructures `flags` and appends `if (flags && flags.length > 0) conditions.push(viewerFlagsPredicate(viewer, flags));`. In `getTimeBucket`: `viewerFlag(stateViewer(auth)).as('flag')` in the cte select and `eb.fn.coalesce(eb.fn('array_agg', ['flag']), sql.lit('{}')).as('flag')` in `agg`. Both `applyStateFilters(qb, stateViewer(auth), options)` calls already forward `options`, so `AssetBuilderOptions.flags` is all `getTimeBuckets`/`getTimeBucket` need.

DTO (mirror `colorLabels` exactly):

```ts
flags: z
  .preprocess(
    (val) => (typeof val === 'string' ? val.split(',') : val),
    z.array(z.union([AssetFlagSchema, z.literal('none')])),
  )
  .optional()
  .describe('Only include assets with one of these flags (comma-separated); "none" matches unflagged assets'),
// response
flag: z.array(AssetFlagSchema.nullable()).describe('Array of viewer pick/reject flags (null when unflagged)'),
```

- [ ] **Step 1: Failing tests.** `time-bucket.dto.spec.ts`: `flags=pick,none` parses to `['pick','none']`; `flags=maybe` fails; omitted stays undefined. Medium `timeline.service.spec.ts` (copy the color-label cases there): user A flags own asset `pick` and a shared-album asset `reject`; `getTimeBucket` returns `flag` array values for A, `null` for B; `flags: ['pick']` returns only picked; `['none']` only unflagged; `['pick','reject']` both; combined with `colorLabels` is an AND; a partner/album viewer sees only their own flags; shared-link auth gets all `null` and `flags: ['pick']` returns nothing while `['none']` returns everything. Medium `asset.repository.spec.ts`: `getTimeBuckets` counts honor `flags`. Run: FAIL.
- [ ] **Step 2: Implement** helpers, repository, DTO. Re-run: pass.
- [ ] **Step 3:** `cd server && pnpm check && pnpm lint`. Commit `feat(server): flag filter and per-asset flag in timeline buckets`.

---

### Task 4: Search filters, generated artifacts, e2e

**Files:**
- Modify: `server/src/dtos/search.dto.ts` (`ColorLabelsFilterSchema` ~27; flat field ~77; branch field ~280; `FLAT_ONLY_FIELDS` ~337)
- Modify: `server/src/repositories/search.repository.ts` (~93 options)
- Modify: `server/src/utils/database.ts` (`searchAssetBuilder` ~675, `branchPredicates` ~993)
- Modify: `server/src/services/search.service.ts` only if `colorLabels` needs explicit forwarding (it currently flows through the spread; verify with `git grep -n colorLabels server/src/services/search.service.ts server/src/dtos/search.dto.ts`)
- Regenerate: `server/src/queries/*.sql`, `open-api/immich-openapi-specs.json`, `packages/sdk/src/fetch-client.ts`
- Test: `server/src/dtos/search.dto.spec.ts`, `server/src/controllers/search.controller.spec.ts`, `server/test/medium/specs/services/search.service.spec.ts`, `e2e/src/specs/server/api/user-asset-state.e2e-spec.ts`

Steps:

```ts
// search.dto.ts
const FlagsFilterSchema = z
  .array(z.union([AssetFlagSchema, z.literal('none')]))
  .describe('Only include assets with one of these flags, from the viewer perspective; "none" matches unflagged assets');
// flat: flags: FlagsFilterSchema.optional()  -- append whatever .meta(...) the flat colorLabels field uses, if any
// branch: flags: FlagsFilterSchema,
const FLAT_ONLY_FIELDS = new Set(['colorLabels', 'flags']);
```

```ts
// searchAssetBuilder (next to the colorLabels $if)
.$if(!!options.flags && options.flags.length > 0 && !!options.viewingUserId, (qb) =>
  qb.where(
    viewerFlagsPredicate({ userId: options.viewingUserId!, sharedLink: options.sharedLink }, options.flags!),
  ),
)
// branchPredicates (next to colorLabels)
...(branch.flags && branch.flags.length > 0 && viewer ? [viewerFlagsPredicate(viewer, branch.flags)] : []),
```

and `flags?: Array<AssetFlag | 'none'>` in the search repository options.

- [ ] **Step 1: Failing tests.** `search.dto.spec.ts` (copy the colorLabels cases): flat `flags` valid/invalid; `flags` together with a structured field (`and`/`or`/`albumIds`...) fails with the exclusivity error; branch `flags` valid inside the structured shape. Controller spec: `POST /search/metadata` accepts `flags`. Medium `search.service.spec.ts` (copy the color cases incl. the shared-link leak case): flat `flags: ['pick']`, `['none']`, branch `flags` inside `or`; another user's flag never matches; shared-link search with `flags: ['pick']` returns nothing (creator's flag must not leak) and `['none']` returns the assets. Run: FAIL.
- [ ] **Step 2: Implement.** Re-run: pass; run the whole search dto/controller specs.
- [ ] **Step 3: Regenerate** OpenAPI, SDK, SQL (commands in Global Constraints). Confirm `git diff --stat` only shows flag-related additions (`AssetFlag` enum, `flag` fields, `flags` params). `cd server && pnpm check && pnpm lint`.
- [ ] **Step 4: e2e.** Extend `user-asset-state.e2e-spec.ts` (copy a color-label case): set `flag` pick/reject/null via `PUT /assets/:id` and `PUT /assets`; overwrite; non-owner album member can flag a shared asset and the owner's view is unaffected; timeline `flags=pick` filter; `GET /assets/:id` returns the viewer's flag; shared link rejects `flag`. The docker stack may not fit locally: run against a local server as in the previous plan if needed (note it in the report), CI is the first real-stack run.
- [ ] **Step 5: Commit** `feat(server): flag search filter, generated api`.

---

### Task 5: Web data layer

**Files:**
- Create: `web/src/lib/utils/flag.ts`
- Modify: `web/src/lib/managers/timeline-manager/types.ts` (`TimelineAsset.flag: AssetFlag | null`), `timeline-manager/timeline-month.svelte.ts` (~194), `lib/utils/timeline-util.ts` (~161), `timeline-manager/internal/utils.svelte.ts` (`withoutUserState`, `normalizeFilter`, `matchesFilter`, `toBucketRequestParams`), `timeline-manager/timeline-manager.svelte.ts` (doc comments ~444/452 only; `withoutUserState` carries the behavior)
- Modify: `web/src/lib/managers/timeline-filter-manager.svelte.ts`, `web/src/lib/types.ts` (`SearchFilter.flags`), `web/src/lib/managers/search-manager.svelte.ts` (~99, ~140)
- Modify: `web/src/test-data/factories/asset-factory.ts` (lines ~45, ~68, ~90: add `flag: null`, `flag: []`, `bucketAssets.flag.push(asset.flag)`)
- Test: `timeline-filter-manager.spec.ts`, `timeline-manager/timeline-manager.svelte.spec.ts`, `lib/utils/timeline-util.spec.ts`, `search-manager.svelte.spec.ts`

**Interfaces:**
- Consumes: SDK `AssetFlag`, bucket `flag` array, `flags` query (Task 4).
- Produces: `flags` (`web/src/lib/utils/flag.ts`):

```ts
import { AssetFlag } from '@immich/sdk';

export const flagValues = [AssetFlag.Pick, AssetFlag.Reject] as const;

export const flagShortcut = { [AssetFlag.Pick]: 'k', [AssetFlag.Reject]: 'r' } as const;
export const clearFlagShortcut = 'u';

/** Toggle semantics: if every target already has the flag it is cleared, otherwise it is set. */
export const nextFlag = (assets: Array<{ flag?: AssetFlag | null }>, flag: AssetFlag) =>
  assets.length > 0 && assets.every((asset) => asset.flag === flag) ? null : flag;
```

`TimelineFilterManager`: `flags = $state<Array<AssetFlag | 'none'>>([])`; `active` includes `this.flags.length > 0`; `query` adds `query.flags = [...this.flags]` when non-empty; `toggleFlag(flag)` (same as `toggleColor`); `clear()` resets it; `TimelineFilter` type gets `flags?`. `normalizeFilter` copies non-empty `flags`; `matchesFilter` adds `&& (!filter.flags || filter.flags.length === 0 || filter.flags.includes(asset.flag ?? 'none'))` (combine with the color check as an AND, keep the existing return structure readable); `toBucketRequestParams` adds `flags: filter?.flags`; `withoutUserState` omits `['rating', 'colorLabel', 'flag']` (update its doc comment); timeline-month and timeline-util map `flag: bucketAssets.flag[i] ?? null` / `assetResponse.flag ?? null`. Search: `SearchFilter.flags: Array<AssetFlag | 'none'>`; `#fromQuery` copies `flags: [...(searchQuery.flags ?? [])]`; `#toQuery` sends `flags: this.filter.flags.length > 0 ? [...this.filter.flags] : undefined`.

- [ ] **Step 1: Failing tests** (copy the colorLabels cases in each spec): filter manager (`toggleFlag` add/remove, `query` omits empty, `active`, `clear`); `flag.spec.ts` for `nextFlag` (all same -> null, mixed -> flag, empty -> flag); timeline manager (a bucket response with `flag` array maps to assets; `flags` filter evicts a non-matching asset on `update`, keeps a matching one; a live websocket payload without viewer state does not reset an existing asset's `flag`: mirror the existing rating/colorLabel clobber test); `timeline-util` mapping; `search-manager` (round trip from query, reset, request omits empty `flags`). Run: FAIL.
- [ ] **Step 2: Implement.** Re-run: pass. Then `cd web && pnpm check:typescript && pnpm lint && pnpm format`.
- [ ] **Step 3: Commit** `feat(web): flag state in timeline and search data layer`.

---

### Task 6: Web flag UI (filter bar, thumbnail, search section)

**Files:**
- Modify: `web/src/lib/components/timeline/TimelineFilterBar.svelte`
- Modify: `web/src/lib/components/assets/thumbnail/Thumbnail.svelte` (overlay slots near lines 92-102 and 354-370)
- Create: `web/src/lib/components/shared-components/search-bar/SearchFlagsSection.svelte`; modify `SearchFilters.svelte` (bind `searchManager.filter.flags`, add to the "filters active" check, next to the colors section) and the search route `+page.svelte` (chips: label `flag`, value names, `removeFilter`)
- Modify: `i18n/en.json` (new keys, kept alphabetical): `flag` "Flag", `flag_picked` "Picked", `flag_rejected` "Rejected", `filter_unflagged` "Unflagged", `clear_flag` "Clear flag", `set_flag` "Set pick/reject flag", `set_flag_description` "Use K to pick, R to reject and U to clear the flag", `flag_updated_count` "Flag updated for {count, plural, one {# asset} other {# assets}}"
- Test: `TimelineFilterBar.spec.ts`, `thumbnail/__test__/Thumbnail.spec.ts`, new `SearchFlagsSection.spec.ts`

Details:
- Filter bar: after the color group add a `role="group"` with `aria-label={$t('flag')}` containing three toggle buttons using the existing `buttonClass`/`activeClass`/`idleClass`: `data-testid="filter-flag-pick"` ($t `flag_picked`, `filter.toggleFlag('pick')`), `filter-flag-reject` (`flag_rejected`), `filter-flag-none` (`filter_unflagged`, `toggleFlag('none')`), each with `aria-pressed`. Hidden when `!authManager.authenticated`.
- Thumbnail: `showFlag = $derived(!authManager.isSharedLink && !!asset.flag)`. Pick: a small badge (`mdiFlag` white on a green circle) in the bottom-left stack; Reject: `mdiClose` badge on a red circle in the same stack. Add it to the existing `bottomSlots` allocation (currently 3 slots: archive, color, rating) as a 4th entry `'bottom-26'` (confirm that Tailwind class exists in the project, otherwise use `bottom-[6.5rem]`). Rejected thumbnails get `opacity-40` on the image container (not on the overlay badges) and stay clickable. Both badges have `aria-label` (`flag_picked` / `flag_rejected`).
- Search section: copy `SearchColorLabelsSection.svelte` with `selected: Array<AssetFlag | 'none'>`, a heading `$t('flag')`, `SearchButton`s for pick/reject and `filter_unflagged` for `none`, `aria-pressed`.
- [ ] **Step 1: Failing tests:** filter bar renders three flag buttons, clicking toggles `filter.flags` and `aria-pressed`, and "clear all" resets; thumbnail renders the pick badge, the reject badge with dimmed image, nothing for `flag: null`, nothing in a shared-link context, and does not move the existing archive/color/rating badges; search section toggles via `aria-pressed` (copy the color section spec). Run: FAIL.
- [ ] **Step 2: Implement.** Re-run: pass. `pnpm check:svelte && pnpm check:typescript && pnpm lint && pnpm format` in `web`.
- [ ] **Step 3: Commit** `feat(web): flag filter chips, thumbnail badge and search section`.

---

### Task 7: Web flag actions and shortcuts

**Files:**
- Modify: `web/src/lib/services/asset.service.ts` (`UserStateUpdate` ~535, `bulkUpdateUserState` messages, new `handleSetFlag`, `handleBulkSetFlag`, `SetFlag` ActionItem near `SetColorLabel` ~240, actions list ~393, `getBulkUserStateShortcuts` ~620-665)
- Create: `web/src/lib/components/timeline/actions/SetFlagAction.svelte`
- Modify: `web/src/lib/components/timeline/actions/TimelineKeyboardActions.svelte` (~140: pass `onFlagged`)
- Modify every page that renders `SetColorLabelAction` (`git grep -l SetColorLabelAction web/src/routes`: photos, albums, archive, folders, people, recently-added, search, tags, map `MapTimelinePanel.svelte`) to render `SetFlagAction` right after it with `onFlagged={(ids, flag) => timelineManager.update(ids, (asset) => (asset.flag = flag))}` (use the same update call the sibling uses)
- Modify: `web/src/lib/modals/ShortcutsModal.svelte` (add three entries to the `actions` list following the existing entry shape: `{ title: $t('set_flag'), keys: ['K', 'R', 'U'] }`, `{ title: $t('compare_photos'), keys: ['C'] }`, and the missing `{ title: <the existing color label title key>, keys: ['6-9'] }`; reuse existing i18n keys, only `set_flag` and `compare_photos` are new)
- Test: `services/asset.service.spec.ts`, `services/asset.service.bulk.spec.ts`, new `SetFlagAction.spec.ts`, `TimelineKeyboardActions.spec.ts`

Implementation (mirror the color versions):

```ts
type UserStateUpdate = { rating: number | null } | { colorLabel: AssetColorLabel | null } | { flag: AssetFlag | null };
// messages.success: add 'flag_updated_count'

export const handleSetFlag = async (asset: AssetResponseDto, flag: AssetFlag | null) => {
  if (authManager.isSharedLink) {
    return;
  }
  const $t = await getFormatter();
  try {
    const response = await updateAsset({ id: asset.id, updateAssetDto: { flag } });
    eventManager.emit('AssetUpdate', response);
  } catch (error) {
    handleError(error, $t('errors.cant_apply_changes'));
  }
};

export const handleBulkSetFlag = async (
  assets: TimelineAsset[],
  flag: AssetFlag | null,
  onFlagged?: (ids: string[], flag: AssetFlag | null) => void,
) => {
  const updated = await bulkUpdateUserState(assets, { flag }, (asset) => (asset.flag = flag), {
    success: 'flag_updated_count',
    error: 'errors.cant_apply_changes',
  });
  if (!updated) {
    return;
  }
  const ids = assets.map(({ id }) => id);
  onFlagged?.(ids, flag);
  return ids;
};
```

`bulkUpdateUserState` must be exported (the compare manager uses it through the three `handleBulk*` wrappers; export only if a test needs it). Viewer `SetFlag` ActionItem: `$if: () => canRate` (same gate as color; flags are not gated by the ratings preference), `onAction` reads `event.key`: `k` -> `nextFlag([asset], AssetFlag.Pick)`, `r` -> `nextFlag([asset], AssetFlag.Reject)`, `u` -> `null`; `shortcuts: [{ key: 'k' }, { key: 'r' }, { key: 'u' }]`; register it next to `SetColorLabel`. Bulk shortcuts: `BulkUserStateShortcutOptions` gets `onFlagged?`, and `getBulkUserStateShortcuts` appends for `k`/`r` `handleBulkSetFlag(assets, nextFlag(assets, flag), onFlagged)` and for `u` `handleBulkSetFlag(assets, null, onFlagged)`, each calling `onDone` on success (not gated by `ratings.enabled`, same shared-link guard as the others). `SetFlagAction.svelte`: copy `SetColorLabelAction.svelte` but use a `ButtonContextMenu` (`icon={mdiFlagOutline}`, `title={$t('set_flag')}`) with three `MenuOption`s (pick `mdiFlag`, reject `mdiClose`, `clear_flag`) that call `handleBulkSetFlag(assetMultiSelectManager.assets, ...)`, clear the selection on success, hidden in shared-link mode.

- [ ] **Step 1: Failing tests:** `handleSetFlag` sends `{ flag }` and emits `AssetUpdate`, skips in shared-link mode, toasts on error; `handleBulkSetFlag` calls `updateAssets` with `{ ids, flag }`, applies to local assets only after success, calls `onFlagged` with ids, returns `undefined` on failure; `getBulkUserStateShortcuts` yields `k`/`r`/`u` handlers, toggles via `nextFlag`, none in shared-link mode; `SetFlagAction` renders the three options and calls the bulk helper; `TimelineKeyboardActions` fires `onFlagged` with a `timelineManager.update` (copy the color case). Run: FAIL.
- [ ] **Step 2: Implement** including page wiring and `ShortcutsModal`. Re-run: pass. `pnpm check:svelte && pnpm check:typescript && pnpm lint && pnpm format`; full web suite once (`pnpm test run`; only the 20 known date failures allowed).
- [ ] **Step 3: Commit** `feat(web): flag actions and K/R/U shortcuts`.

---

# Phase B: compare view

### Task 8: CompareManager and setting

**Files:**
- Create: `web/src/lib/managers/compare-manager.svelte.ts`, `web/src/lib/managers/compare-manager.svelte.spec.ts`
- Modify: `web/src/lib/stores/preferences.store.ts` (append next to `alwaysLoadOriginalFile`):

```ts
export type CompareRejectBehavior = 'remove' | 'dim';
export const compareRejectBehavior = persisted<CompareRejectBehavior>('compare-reject-behavior', 'remove', {});
```

- Modify: user settings UI. Find the viewer-preference toggles with `git grep -ln "alwaysLoadOriginalFile\|loopVideo" web/src/lib/components/user-settings-page` (open the matching settings component, e.g. the "image viewer"/"video" feature settings) and add a select bound to `$compareRejectBehavior` with options `remove` / `dim`; i18n keys `compare_reject_behavior` ("Rejected photos in compare"), `compare_reject_remove` ("Remove from the comparison"), `compare_reject_dim` ("Keep dimmed in the comparison"), `compare_reject_behavior_description`.

**Interfaces:**
- Consumes: `handleBulkSetFlag`, `handleBulkRate`, `handleBulkSetColorLabel`, `nextColorLabel`, `nextFlag` (Task 7), `compareRejectBehavior`.
- Produces: singleton `compareManager`:

```ts
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 6;
export const MAX_CONCURRENT_ORIGINALS = 3;

export type CompareUpdate = Partial<Pick<TimelineAsset, 'flag' | 'rating' | 'colorLabel'>>;

/** Grid for n visible photos: 1 full, 2 side by side, 3 in a row, 4 as 2x2, 5-6 as 3x2. */
export const compareGrid = (count: number): { columns: number; rows: number } => {
  if (count <= 1) return { columns: 1, rows: 1 };
  if (count === 2) return { columns: 2, rows: 1 };
  if (count === 3) return { columns: 3, rows: 1 };
  if (count === 4) return { columns: 2, rows: 2 };
  return { columns: 3, rows: 2 };
};

class CompareManager {
  isOpen = $state(false);
  assets = $state<TimelineAsset[]>([]);
  removedIds = $state<string[]>([]);
  focusedId = $state<string | undefined>();
  zoomState = $state<ZoomImageWheelState>(createDefaultZoomState());
  zoomSource = $state<string | undefined>();
  #onUpdated?: (ids: string[], update: CompareUpdate) => void;

  get visible(): TimelineAsset[];          // assets minus removedIds
  get grid(): { columns: number; rows: number };
  get focused(): TimelineAsset | undefined;
  get remaining(): number;                 // visible.length
  get originalIds(): string[];             // [] when zoom <= 1, else focused first then others, capped at MAX_CONCURRENT_ORIGINALS

  open(assets: TimelineAsset[], onUpdated?: (ids: string[], update: CompareUpdate) => void): boolean; // false if outside [COMPARE_MIN, COMPARE_MAX]
  close(): void;                           // resets everything, calls nothing on the timeline
  focusNext(): void; focusPrevious(): void; // wrap around visible; no-op when empty
  focus(id: string): void;
  remove(id?: string): void;               // defaults to focused; moves focus to the neighbour; closes when 0 visible
  reportZoom(sourceId: string, state: ZoomImageWheelState): void; // sets zoomState + zoomSource
  toggleActualSize(): void;                // zoom 1 <-> focused slot's natural zoom (setNaturalZoom), fallback 2
  setNaturalZoom(id: string, zoom: number): void;
  setFlag(flag: AssetFlag | null): Promise<void>;     // on the focused asset
  toggleFlag(flag: AssetFlag): Promise<void>;         // uses nextFlag([focused], flag)
  rate(rating: number | null): Promise<void>;
  toggleColor(label: AssetColorLabel): Promise<void>; // uses nextColorLabel
}
export const compareManager = new CompareManager();
```

Semantics (implement exactly): every mutation calls the matching `handleBulk*` with `[focused]`, passing a callback that forwards to `#onUpdated(ids, { flag })` etc. The bulk helper only applies the change after the server accepts it, so a failed write toasts and leaves the slot unchanged (this is the "revert"). After a successful `setFlag(AssetFlag.Reject)` (including via `toggleFlag`): if `$compareRejectBehavior === 'remove'` call `remove()` of that asset; if `'dim'` move focus to the next non-rejected visible asset (leave focus if none). `remove()` of the last visible asset closes the manager. `open` focuses the first asset and resets `zoomState`.

- [ ] **Step 1: Failing tests** in `compare-manager.svelte.spec.ts` (mock the three `handleBulk*` functions from `$lib/services/asset.service`): `compareGrid` for 1..6; `open` refuses 1 and 7 assets and accepts 2..6; focus wraps next/previous; `remove` re-tiles (grid of 5 -> 4 gives 2x2), moves focus, closes at 0; reject in `'remove'` mode removes and in `'dim'` mode keeps and moves focus to the next non-rejected; `setFlag` failure (mock resolves `undefined`) changes nothing and does not call `onUpdated`; success calls `onUpdated([id], { flag })`; `toggleFlag` clears when the focused asset already has the flag; `rate(0-style null)`; `toggleColor` toggles via `nextColorLabel`; `originalIds` is empty at zoom 1, focused first and capped at 3 above 1; `reportZoom` stores state and source; `toggleActualSize` alternates 1 and the natural zoom. Run `pnpm test run src/lib/managers/compare-manager.svelte.spec.ts`: FAIL.
- [ ] **Step 2: Implement.** Re-run: pass. `pnpm check:typescript && pnpm lint && pnpm format`.
- [ ] **Step 3: Commit** `feat(web): compare manager and reject-behavior setting`.

---

### Task 9: CompareSlot and CompareView

**Files:**
- Create: `web/src/lib/components/compare/CompareSlot.svelte`, `CompareView.svelte`, specs `CompareSlot.spec.ts`, `CompareView.spec.ts`
- Modify: `i18n/en.json`: `compare` "Compare", `compare_photos` "Compare photos", `compare_select_range` "Select 2 to 6 photos to compare", `compare_one_left` "1 left. Press K to pick it or Esc to finish.", `compare_preview_only` "Preview only", `compare_exit` "Exit comparison", `compare_actual_size` "Toggle 100% zoom"

**Interfaces:**
- Consumes: `compareManager` (Task 8), `getAssetMediaUrl` + `AssetMediaSize` (`$lib/utils`), `isWebCompatibleImage` (`$lib/utils/asset-utils`), `getAssetInfo` (`@immich/sdk`), `createZoomImageWheel` (`@zoom-image/core`), `createDefaultZoomState` (same import `asset-viewer-manager.svelte.ts` uses), `shortcuts` action, `Thumbnail`-style color/flag classes from `lib/utils/color-label.ts` and `flag.ts`.

`CompareSlot.svelte` (props: `asset: TimelineAsset`, `focused: boolean`):
- On mount load `getAssetInfo({ id: asset.id })` into `info` (for exif and `isWebCompatibleImage(info)`); show the preview `getAssetMediaUrl({ id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash })` immediately.
- Original: if `compareManager.originalIds.includes(asset.id)` and `info && isWebCompatibleImage(info)` swap `src` to `getAssetMediaUrl({ id, size: AssetMediaSize.Original, cacheKey: asset.thumbhash })` once it has loaded (preload with an `Image()` and swap on `onload`, so there is no blank frame). If the original is not web-compatible, show the `compare_preview_only` hint.
- Zoom: `createZoomImageWheel(container, { maxZoom: 10, initialState: compareManager.zoomState })`. `instance.subscribe(({ state }) => compareManager.reportZoom(asset.id, state))`; an `$effect` applies `compareManager.zoomState` with `instance.setState(...)` when `compareManager.zoomSource !== asset.id` and the numbers differ (compare `currentZoom`, `currentPositionX`, `currentPositionY` to avoid feedback loops). Report the natural zoom after the image loads: `compareManager.setNaturalZoom(asset.id, img.naturalWidth / img.clientWidth)`. Cleanup on destroy.
- Header: rating stars (`asset.rating`), color dot (`colorLabelClass`), flag badge; footer: `info.exifInfo` `fNumber`, `exposureTime`, `iso`, `focalLength`, plus capture time; the focused slot gets a visible outline (`outline-2 outline-primary`); a dimmed slot (flag `reject` in `'dim'` mode) gets `opacity-40`. Clicking the slot calls `compareManager.focus(asset.id)`.

`CompareView.svelte`: renders only when `compareManager.isOpen`; `fixed inset-0 z-[1100] bg-black` (above the timeline and viewer; verify the z-index scale used by `AssetViewer`), `grid` with `style:grid-template-columns="repeat({grid.columns}, 1fr)"` / rows, one `CompareSlot` per `compareManager.visible` asset keyed by id; a top bar with the title, remaining count and an exit button (`compare_exit`); a bottom hint bar with the keys; when `compareManager.remaining === 1` show the `compare_one_left` banner. Keyboard via the `shortcuts` action on `svelte:document`: `ArrowRight`/`ArrowLeft`/`ArrowDown`/`ArrowUp` -> `focusNext`/`focusPrevious`; `k` -> `toggleFlag(Pick)`; `r` -> `toggleFlag(Reject)`; `u` -> `setFlag(null)`; `0`-`5` -> `rate` (gated by `authManager.preferences.ratings.enabled`, `0` -> null); `6`-`9` -> `toggleColor` per `colorLabelShortcut`; `Backspace` -> `remove()`; `z` -> `toggleActualSize()`; `Escape` -> `close()`. Use `preventDefault: true` and stop propagation so timeline shortcuts underneath never fire; the view must also trap focus (`tabindex=-1` container focused on open) and restore the previously focused element on close. Lock body scroll while open.

- [ ] **Step 1: Failing tests.** `CompareSlot.spec.ts` (mock `createZoomImageWheel`, `getAssetInfo`): shows the preview URL first; swaps to the original only when `originalIds` includes the asset and the mime type is web compatible; shows "preview only" for a RAW; forwards zoom changes via `reportZoom`; applies a foreign `zoomState` via `setState` and ignores its own (no feedback loop); renders exposure info, flag and color. `CompareView.spec.ts`: renders nothing when closed; renders N slots for N visible assets with the right grid template for 2/4/6; `K`/`R`/`U`/`0`-`5`/`6`/`Backspace`/arrows/`Escape`/`Z` call the matching manager methods; the one-left banner appears at 1 remaining; unrelated keys such as `x` do not reach the document handlers beneath (assert `preventDefault` on handled keys). Run: FAIL.
- [ ] **Step 2: Implement.** Re-run: pass. `pnpm check:svelte && pnpm check:typescript && pnpm lint && pnpm format`.
- [ ] **Step 3: Commit** `feat(web): compare view overlay and slots`.

---

### Task 10: Compare entry action and wiring

**Files:**
- Create: `web/src/lib/components/timeline/actions/CompareAction.svelte`, `CompareAction.spec.ts`
- Modify: mount `<CompareView />` once, in the user layout `web/src/routes/(user)/+layout.svelte` (not per page)
- Modify: every page that renders `SetFlagAction` (same list as Task 7) to render `CompareAction` next to it with `onUpdated={(ids, update) => timelineManager.update(ids, (asset) => Object.assign(asset, update))}`
- Modify: `TimelineKeyboardActions.svelte`: add the `C` shortcut (selection of 2 to 6 -> open), only when `assetMultiSelectManager.selectionActive`, not in shared-link mode
- Modify: `ShortcutsModal.svelte` already lists `C` (Task 7)

`CompareAction.svelte` (model on `SetRatingAction.svelte`/`FavoriteAction.svelte` for the icon button): a `CircleIconButton`-style button `mdiCompare` titled `$t('compare_photos')`; enabled only when `COMPARE_MIN <= assetMultiSelectManager.assets.length <= COMPARE_MAX`, otherwise `disabled` with the title `compare_select_range`; click -> `compareManager.open(assetMultiSelectManager.assets, onUpdated)` and keep the selection (do not clear it). Hidden in shared-link mode.

- [ ] **Step 1: Failing tests:** `CompareAction` is disabled for 1 and 7 assets with the hint title, enabled for 2..6, click opens the manager with the selected assets and the callback, selection is untouched, hidden in shared-link mode; `TimelineKeyboardActions` `C` opens with 2..6 selected and does nothing otherwise; an `onUpdated` call patches the timeline asset (flag/rating/color) via `timelineManager.update` and a `flags` filter evicts a rejected asset from the timeline behind the overlay (use the timeline manager test helpers from the filter eviction spec). Run: FAIL.
- [ ] **Step 2: Implement.** Re-run: pass. Full web suite (`cd web && pnpm test run`; only the 20 known date failures allowed), `pnpm check:svelte && pnpm check:typescript && pnpm lint && pnpm format`.
- [ ] **Step 3: Commit** `feat(web): open the compare view from a selection`.

---

## Self-review notes

- Spec coverage: data model/migration/enum (T1); write path, shared-link rejection, row lifecycle (T1-T2); viewer-aware read, timeline `flags`/`flag` (T3); search flat + branch + shared-link no leak, generated files, e2e (T4); filter manager, search manager, websocket clobber (`withoutUserState`) (T5); filter chips, thumbnail badge/dim, search section/chips (T6); bulk action, viewer + bulk shortcuts `K/R/U`, shortcuts modal (T7); compare manager, setting, grid, focus, remove/dim, zoom sync state, original cap (T8); slot preview/original/RAW hint/exif footer, overlay keys, banner (T9); entry action, `C`, layout mount, timeline eviction (T10).
- Names used across tasks: `AssetFlag`, `flagValues`, `flagShortcut`, `clearFlagShortcut`, `nextFlag`, `handleSetFlag`, `handleBulkSetFlag`, `onFlagged`, `viewerFlag`, `viewerFlagsPredicate`, `compareManager`, `CompareUpdate`, `compareGrid`, `COMPARE_MIN/MAX`, `MAX_CONCURRENT_ORIGINALS`, `compareRejectBehavior`.
- Manual checks left to the user: filter bar flag group layout, thumbnail overlay stacking with four slots, synced zoom feel, original loading on zoom, compare layout on a real screen, e2e on the real docker stack.
