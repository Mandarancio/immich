# Culling: Pick/Reject flags and compare view

Date: 2026-10-25
Scope: Phase A server + web (flag), Phase B web only (compare view). Mobile and sync streams are out of scope.

Builds on the per-user state work (`2026-10-25-per-user-rating-color-filters-design.md`). `asset_user_state` gets a per-user Pick/Reject flag, and a new full-screen compare view lets the user judge several similar shots side by side. This is the first of several culling sub-projects (see Later).

## Decisions

- Pick and Reject are **per-user** and mutually exclusive: setting one replaces the other, `null` clears.
- Reject is a **flag only**: rejected photos stay in the timeline (dimmed, with an X badge) and are filterable. There is no dedicated "review and trash rejected" step; the user filters to Rejected, selects all and uses the normal trash flow.
- The flag is table-only for everyone, owners included (no legacy field), like `colorLabel`.
- Compare is a **full-screen overlay** (no route), opened from a timeline/album/search selection of 2 to 6 photos.
- Inside compare, `R` rejects the focused photo and by default **removes it from the view** (remaining photos re-tile larger). A local setting switches this to "keep dimmed" (focus moves to the next non-rejected photo).
- Compare loads the preview first and the original on zoom.
- No new server preference: the reject-behavior setting is a browser-local persisted store (`preferences.store.ts`), like `alwaysLoadOriginalFile`.

## Phase A: flag

### Data model

New migration `AddAssetUserStateFlag` (next free timestamp after `1793000000001-AddAssetUserState`, registered in the migration `ORDER`): `ALTER TABLE asset_user_state ADD COLUMN "flag" text` with `CHECK ("flag" IN ('pick','reject'))`, nullable, no backfill. `down` drops the column.

Row lifecycle: a row is deleted when favorite is false, rating is null, colorLabel is null **and flag is null** (extend the existing `setUserState` rule and its tests).

New enum `AssetFlag { Pick = 'pick', Reject = 'reject' }` in `server/src/enum.ts`.

### Write path

- `UpdateAssetDto` and `AssetBulkUpdateDto` accept `flag: AssetFlag | null` (`null` clears).
- The existing state-only detection (`isStateOnly`) includes `flag`; state-only requests need only `Permission.AssetRead`, other fields stay owner-only. Shared links are rejected for `flag` (same as color/rating).
- Sending `flag` replaces any previous flag. Clearing the last state field deletes the row.

### Read path

- `AssetResponseDto.flag` is viewer-aware (the viewer's own row only), via the existing `getViewerStates` / `viewerState` path used by `mapAsset`.
- New Kysely helpers next to `colorLabelsPredicate` in `server/src/utils/database.ts`: `flagFor` and `flagsPredicate(flags)` (`none` = no row or null flag), plus viewer variants that return a constant for shared links (the same `StateViewer` abstraction as color labels). Shared-link search never evaluates the creator's private flag.
- Timeline buckets (`getTimeBuckets` / `getTimeBucket`): new query param `flags` (comma-separated, values `pick`, `reject`, `none`, validated like `colorLabels`); the bucket response gets a per-asset `flag` array. Filters combine with AND with the existing rating/color/favorite filters.
- Search: `flags` in the flat DTO and in the V3 branch shape, same semantics.
- Regenerate OpenAPI spec, SDK (`packages/sdk/src/fetch-client.ts`) and `asset.repository.sql`.

### Web

- `TimelineFilterManager` gets `flags` (same shape and URL/state handling as `colorLabels`); the filter bar gets a Flag chip group: Picked / Rejected / Unflagged.
- Thumbnails: a pick badge; rejected photos are dimmed with an X badge. Place the badge in the existing bottom-left overlay stack without colliding with the favorite/rating/color/archive indicators.
- `K` picks (keep), `R` rejects, `U` clears for the selection (or hovered/viewed asset), in timelines, the asset viewer and the compare view. Pressing `K` on an already picked photo (or `R` on a rejected one) toggles it off. Lightroom's `P`/`X` are NOT used: plain `x` already selects a focused thumbnail and plain `p` is Tag people in the viewer. `k`, `r`, `u` and `c` have no plain-key binding on timeline, viewer or search pages (`r` is only used on admin library pages; shift-`c`/shift-`u` and ctrl-`k` exist elsewhere). `ShortcutsModal` lists the new keys (and the missing `6`-`9` color keys).
- Bulk actions `SetFlagAction` in the timeline selection bar via the shared `bulkUpdateUserState` helper; `handleSetFlag` in `asset.service.ts`.
- Search page: a flag section (like `SearchColorLabelsSection`) bound to `searchManager.filter.flags`, included in the "filters active" check and in the chips with i18n labels.
- The `liveAssetPayloads` / `keepUserState` logic that stops websocket payloads from clobbering per-user state must also preserve `flag`.

## Phase B: compare view (web only)

### Entry

When 2 to 6 assets are selected, a "Compare" bulk action appears, with shortcut `C`. If more than 6 are selected, the action is disabled with a hint. Opening it shows `CompareView.svelte` as a full-screen overlay above the page. The page underneath keeps its scroll position, selection and filters.

### State: `CompareManager` (`web/src/lib/managers/compare-manager.svelte.ts`)

Holds the asset list, the focused id, the removed set, the shared zoom/pan state, and exposes `open(assets)`, `close()`, `focusNext/Prev()`, `removeFocused()`, `applyFlag(flag)`, `rate(n)`, `toggleColor(label)`. Mutations reuse `bulkUpdateUserState` and the rate/color helpers from `asset.service.ts`, so the timeline behind updates through the existing path. A failed write shows a toast and reverts the slot.

### Layout

CSS grid with automatic tiling by visible count: 1 full, 2 side by side, 3 in a row, 4 as 2x2, 5-6 as 3x2. Removing a photo re-tiles the rest. Zero visible photos closes the view.

### Slots (`CompareSlot.svelte`)

- Preview image first; when the shared zoom is above 1 the slot loads the original (focused slot first, others in the background; at most 3 concurrent original loads). A RAW without a web-viewable original stays on the preview with a "preview only" hint.
- Header: rating, color, flag. Footer: aperture, shutter, ISO, focal length, capture time.
- The focused slot is outlined.

### Synced zoom and pan

One shared `ZoomImageWheelState`; each slot has its own `@zoom-image/core` instance. A slot's zoom/pan change updates the shared state; the shared state is applied to the other slots via `setState`. `Z` toggles fit and 100%. Relative position is kept, so pan is approximate when aspect ratios differ.

### Keys

| key | action |
|---|---|
| arrows | move focus |
| `K` / `R` / `U` | pick / reject / clear flag on the focused photo (`R` also removes it in "remove" mode) |
| `0`-`5` | rating |
| `6`-`9` | toggle red/yellow/green/blue |
| `Backspace` | remove from the view without flagging |
| `Z` | fit / 100% |
| `Esc` | exit |

When exactly one photo remains, a banner shows "1 left, K to pick, Esc to finish".

### Setting

`compareRejectBehavior: 'remove' | 'dim'` (default `'remove'`) as a `persisted` store in `web/src/lib/stores/preferences.store.ts`, with a control in user settings next to the other viewer preferences, and i18n strings.

## Testing

- Server: DTO validation/coercion for `flag`/`flags`; service specs (state-only path, shared-link rejection, row deleted when the last field clears, overwrite); medium specs for timeline and search `flags` filters, viewer-aware reads and no leak through shared-link search; extend `e2e/src/specs/server/api/user-asset-state.e2e-spec.ts` (set, overwrite, clear, filter); migration up/down; regenerated OpenAPI/SDK/SQL snapshots.
- Web: `TimelineFilterManager` and `search-manager` specs for `flags`; specs for the filter chips, thumbnail badge, `SetFlagAction`, search flag section; `CompareManager` unit tests (layout for 1-6, focus movement, remove vs dim, one-left banner, shared zoom propagation, failed-write revert, 6-photo cap, original-load concurrency cap); `CompareView` keyboard spec; setting persistence.
- Manual (not coverable by jsdom): synced zoom feel, original loading on zoom, layout on a real screen, thumbnail overlay stacking.

## Risks

- Synced pan across different aspect ratios is approximate.
- Up to 6 originals at once is heavy; the concurrent-load cap and focused-first ordering mitigate this.
- Shortcut conflicts (`K`/`R`/`U`/`C`) must be re-verified per page at implementation time.

## Out of scope / later

- **C. Group view:** auto-group similar shots (capture-time proximity plus CLIP similarity), collapsed in the timeline, "keep best" actions.
- **D. Culling session:** full-screen fast flow with filmstrip and auto-advance.
- **E. Assistive signals:** sharpness/blur score, face and eyes-open detection.
- Lightroom-style Select/Candidate tournament mode, dedicated "review rejected and trash" step, mobile and sync support for flags.
