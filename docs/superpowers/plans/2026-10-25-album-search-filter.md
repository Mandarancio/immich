# Album Filter in Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users filter web search results by one or more albums (including albums shared with them), for both metadata and smart search.

**Architecture:** The server already supports `albumIds` on the legacy flat search DTOs. `searchMetadata` skips the ownership restriction when `albumIds` is given (after an `AlbumRead` access check), but `searchSmart` does not, so smart search + album filter silently drops photos the user does not own or get via a partner. Task 1 fixes that. Tasks 2-4 add the web UI: filter state, a `SearchAlbumsSection` modelled on `SearchTagsSection`, and a results chip.

**Tech Stack:** NestJS + Kysely + vitest (server); SvelteKit 5 (runes) + `@immich/sdk` + vitest + Testing Library (web).

## Global Constraints

- Server and web only; mobile is out of scope.
- Use the existing flat `albumIds` field on `MetadataSearchDto` / `SmartSearchDto` (all-of semantics, via `inAlbums` in `server/src/utils/database.ts`). Do not move the web to the new `filter` shape.
- Album access is enforced with `Permission.AlbumRead` (owner or shared-album member, viewers included).
- Follow existing patterns: `SearchTagsSection.svelte` for the section, `search-bar-utils.ts` for title helpers.
- i18n strings go in `i18n/en.json` only, keys kept in alphabetical order.
- Run all commands from the repo root unless stated.

---

### Task 1: Smart search honors `albumIds` for shared albums

**Files:**
- Modify: `server/src/services/search.service.ts:168-198` (`searchSmart`)
- Test: `server/src/services/search.service.spec.ts` (`describe('searchSmart')`, ends near line 378)

**Interfaces:**
- Consumes: `this.requireAccess({ auth, ids, permission: Permission.AlbumRead })` and `this.getUserIdsToSearch(auth, visibility)` (both already used in `searchMetadata`).
- Produces: `searchSmart` passes `userIds: undefined` to `searchRepository.searchSmart` when `dto.albumIds` is non-empty (after the access check), otherwise unchanged.

- [ ] **Step 1: Write the failing tests**

In `server/src/services/search.service.spec.ts`, add these two tests at the end of `describe('searchSmart', ...)`, after the `'should use language specified in request'` test:

```ts
    it('should search the album instead of the own and partner library when albumIds is set', async () => {
      const albumId = newUuid();
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([albumId]));

      await sut.searchSmart(authStub.user1, { size: 100, query: 'test', albumIds: [albumId] });

      expect(mocks.search.searchSmart).toHaveBeenCalledWith(
        { page: 1, size: 100 },
        expect.objectContaining({ albumIds: [albumId], userIds: undefined }),
      );
    });

    it('should reject albumIds the user cannot read', async () => {
      const albumId = newUuid();

      await expect(sut.searchSmart(authStub.user1, { size: 100, query: 'test', albumIds: [albumId] })).rejects.toThrow(
        BadRequestException,
      );
      expect(mocks.search.searchSmart).not.toHaveBeenCalled();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && pnpm test src/services/search.service.spec.ts -t "searchSmart"`
Expected: the first new test FAILS (`userIds` is `['<user id>']`, not `undefined`); the second FAILS (promise resolves instead of rejecting).

- [ ] **Step 3: Implement**

In `server/src/services/search.service.ts`, replace

```ts
    const userIds = this.getUserIdsToSearch(auth, dto.visibility);
    const embedding = await this.resolveEmbedding(auth, dto, machineLearning);
```

with

```ts
    let userIds: string[] | undefined;
    if (dto.albumIds && dto.albumIds.length > 0) {
      await this.requireAccess({ auth, ids: dto.albumIds, permission: Permission.AlbumRead });
    } else {
      userIds = await this.getUserIdsToSearch(auth, dto.visibility);
    }

    const embedding = await this.resolveEmbedding(auth, dto, machineLearning);
```

and in the `searchRepository.searchSmart` call replace `userIds: await userIds,` with `userIds,`.

`Permission` and `BadRequestException` are already imported in this file (`requireAccess` throws `BadRequestException` when the album is not readable).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && pnpm test src/services/search.service.spec.ts`
Expected: all tests in the file PASS (the existing `'should work'` still sees `userIds: [<id>]` because no `albumIds` is passed).

- [ ] **Step 5: Type check and commit**

Run: `cd server && pnpm check`
Expected: no errors.

```bash
git add server/src/services/search.service.ts server/src/services/search.service.spec.ts
git commit -m "fix(server): smart search honors albumIds for shared albums"
```

---

### Task 2: Web search filter state carries `albumIds`

**Files:**
- Modify: `web/src/lib/types.ts:64-77` (`SearchFilter`)
- Modify: `web/src/lib/managers/search-manager.svelte.ts` (`#fromQuery`, `#toQuery`)
- Test: `web/src/lib/managers/search-manager.svelte.spec.ts`

**Interfaces:**
- Consumes: `albumIds?: string[]` already present on `MetadataSearchDto` and `SmartSearchDto` in `@immich/sdk`.
- Produces: `SearchFilter.albumIds: SvelteSet<string>` (never null; empty set means no album filter). `searchManager.filter.albumIds` is read and mutated by Task 3. `submit()` sends `albumIds` only when non-empty.

- [ ] **Step 1: Write the failing tests**

In `web/src/lib/managers/search-manager.svelte.spec.ts`, replace the first line with:

```ts
import { goto } from '$app/navigation';
import { searchManager } from '$lib/managers/search-manager.svelte';
import { Route } from '$lib/route';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
```

and add inside `describe('SearchManager', ...)`, after the last `it`:

```ts
  it('restores album ids from a query', () => {
    searchManager.setQuery({ albumIds: ['album-1', 'album-2'] });
    expect([...searchManager.filter.albumIds]).toEqual(['album-1', 'album-2']);
  });

  it('starts with no album filter', () => {
    expect(searchManager.filter.albumIds.size).toBe(0);
  });

  it('submits album ids only when some are selected', async () => {
    await searchManager.submit();
    expect(goto).toHaveBeenLastCalledWith(Route.search({}));

    searchManager.filter.albumIds.add('album-1');
    await searchManager.submit();
    expect(goto).toHaveBeenLastCalledWith(Route.search({ albumIds: ['album-1'] }));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && pnpm test src/lib/managers/search-manager.svelte.spec.ts`
Expected: the three new tests FAIL (`albumIds` is undefined on the filter).

- [ ] **Step 3: Implement**

In `web/src/lib/types.ts`, add to `SearchFilter` after `tagIds`:

```ts
  albumIds: SvelteSet<string>;
```

In `web/src/lib/managers/search-manager.svelte.ts`, in `#fromQuery`'s returned object add after the `tagIds` entry:

```ts
      albumIds: new SvelteSet('albumIds' in searchQuery ? searchQuery.albumIds : []),
```

and in `#toQuery`'s returned object add after the `tagIds` line:

```ts
      albumIds: this.filter.albumIds.size > 0 ? [...this.filter.albumIds] : undefined,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm test src/lib/managers/search-manager.svelte.spec.ts`
Expected: all PASS.

- [ ] **Step 5: Type check and commit**

Run: `cd web && pnpm run check:typescript`
Expected: no errors. If any other file constructs a `SearchFilter` literal and now fails, add `albumIds: new SvelteSet()` there.

```bash
git add web/src/lib/types.ts web/src/lib/managers/search-manager.svelte.ts web/src/lib/managers/search-manager.svelte.spec.ts
git commit -m "feat(web): carry album ids in the search filter"
```

---

### Task 3: `SearchAlbumsSection` in the search filter panel

**Files:**
- Create: `web/src/lib/components/shared-components/search-bar/SearchAlbumsSection.svelte`
- Create: `web/src/lib/components/shared-components/search-bar/SearchAlbumsSection.spec.ts`
- Modify: `web/src/lib/components/shared-components/search-bar/search-bar-utils.ts` (add `getSearchAlbumsTitle`)
- Modify: `web/src/lib/components/shared-components/search-bar/SearchFilters.svelte`
- Modify: `i18n/en.json`

**Interfaces:**
- Consumes: `searchManager.filter.albumIds: SvelteSet<string>` (Task 2); `getAllAlbums` and `AlbumResponseDto` from `@immich/sdk` (`GET /albums` returns albums the user owns or is a member of).
- Produces: `SearchAlbumsSection` with props `{ title: string | undefined (bindable); parentPromise: Promise<AlbumResponseDto[]> | undefined }`; `getSearchAlbumsTitle(albums: AlbumResponseDto[], selected: SvelteSet<string>): string | undefined`.

- [ ] **Step 1: Add i18n strings**

In `i18n/en.json`, insert in alphabetical position:

```json
  "album_plus_more_albums": "{album} + {count, plural, one {# album} other {# albums}}",
```

(after `"album_options"`), and

```json
  "search_filter_albums_description": "Only show results from the selected albums, including albums shared with you.",
```

(just before `"search_filter_apply"`). `"search_albums"` ("Search albums") and `"albums"` already exist.

- [ ] **Step 2: Add the title helper**

In `web/src/lib/components/shared-components/search-bar/search-bar-utils.ts`, change the first import to also import `AlbumResponseDto`:

```ts
import { getAllPeople, type AlbumResponseDto, type PersonResponseDto, type TagResponseDto } from '@immich/sdk';
```

and add after `getSearchTagsTitle`:

```ts
export const getSearchAlbumsTitle = (albums: AlbumResponseDto[], selected: SvelteSet<string>) => {
  const $t = get(t);

  const id = selected.values().next().value;
  if (!id) {
    return undefined;
  }

  const album = albums.find((a) => a.id === id)?.albumName;
  if (!album) {
    return undefined;
  }

  return selected.size === 1 ? album : $t('album_plus_more_albums', { values: { album, count: selected.size - 1 } });
};
```

- [ ] **Step 3: Write the failing component test**

Create `web/src/lib/components/shared-components/search-bar/SearchAlbumsSection.spec.ts`:

```ts
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import SearchAlbumsSection from '$lib/components/shared-components/search-bar/SearchAlbumsSection.svelte';
import { searchManager } from '$lib/managers/search-manager.svelte';
import { albumFactory } from '@test-data/factories/album-factory';

describe('SearchAlbumsSection component', () => {
  const holiday = albumFactory.build({ id: 'album-1', albumName: 'Holiday' });
  const family = albumFactory.build({ id: 'album-2', albumName: 'Family' });

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    searchManager.setQuery({ albumIds: ['album-1', 'album-2'] });
  });

  afterEach(() => {
    searchManager.reset();
  });

  it('shows a chip for each selected album', async () => {
    render(SearchAlbumsSection, {
      props: { title: undefined, parentPromise: Promise.resolve([holiday, family]) },
    });

    expect(await screen.findByRole('button', { name: 'Holiday' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Family' })).toBeInTheDocument();
  });

  it('removes the album when its chip is clicked', async () => {
    const user = userEvent.setup();
    render(SearchAlbumsSection, {
      props: { title: undefined, parentPromise: Promise.resolve([holiday, family]) },
    });

    await user.click(await screen.findByRole('button', { name: 'Holiday' }));

    // @ts-expect-error pending a type fix: https://github.com/testing-library/jest-dom/pull/742/changes
    expect(screen.queryByRole('button', { name: 'Holiday' })).not.toBeInTheDocument();
    expect([...searchManager.filter.albumIds]).toEqual(['album-2']);
  });

  // removing the focused chip would otherwise drop focus to the body, which the
  // search bar treats as focus leaving the search panel
  it('keeps focus inside the section when a chip is removed', async () => {
    const user = userEvent.setup();
    const { container } = render(SearchAlbumsSection, {
      props: { title: undefined, parentPromise: Promise.resolve([holiday, family]) },
    });

    await user.click(await screen.findByRole('button', { name: 'Holiday' }));

    expect(document.activeElement).not.toBe(document.body);
    expect(container.contains(document.activeElement)).toBe(true);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd web && pnpm test src/lib/components/shared-components/search-bar/SearchAlbumsSection.spec.ts`
Expected: FAIL, cannot resolve `SearchAlbumsSection.svelte`.

- [ ] **Step 5: Create the component**

Create `web/src/lib/components/shared-components/search-bar/SearchAlbumsSection.svelte`:

```svelte
<script lang="ts">
  import Combobox, { type ComboBoxOption } from '$lib/components/shared-components/Combobox.svelte';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import { getAllAlbums, type AlbumResponseDto } from '@immich/sdk';
  import { Button, Text } from '@immich/ui';
  import { mdiClose } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { getSearchAlbumsTitle } from './search-bar-utils';

  interface Props {
    title: string | undefined;
    parentPromise: Promise<AlbumResponseDto[]> | undefined;
  }

  // eslint-disable-next-line no-useless-assignment
  let { title = $bindable(), parentPromise }: Props = $props();

  let container = $state<HTMLDivElement>();
  let selectedAlbums = $derived(searchManager.filter.albumIds);
  let allAlbums: AlbumResponseDto[] = $state([]);
  let albumMap = $derived(Object.fromEntries(allAlbums.map((album) => [album.id, album])));
  let selectedOption = $state(undefined);

  onMount(() => {
    if (parentPromise) {
      void parentPromise.then((res) => (allAlbums = res));
    } else {
      void getAllAlbums({}).then((res) => (allAlbums = res));
    }
  });

  const handleSelect = (option?: ComboBoxOption) => {
    if (!option || !option.id) {
      return;
    }

    selectedAlbums.add(option.value);
    selectedOption = undefined;
    title = getSearchAlbumsTitle(allAlbums, selectedAlbums);
  };

  const handleRemove = (albumId: string) => {
    // Move focus back to the container so it doesn't fallback to the body and closes the search bar
    container?.focus();
    selectedAlbums.delete(albumId);
    title = getSearchAlbumsTitle(allAlbums, selectedAlbums);
  };
</script>

<div id="album-selection" bind:this={container} tabindex="-1">
  <form autocomplete="off" id="search-albums-form">
    <Text class="pb-5">{$t('search_filter_albums_description')}</Text>
    <Combobox
      hideLabel
      onSelect={handleSelect}
      label={$t('albums')}
      defaultFirstOption
      options={allAlbums.map((album) => ({ id: album.id, label: album.albumName, value: album.id }))}
      bind:selectedOption
      placeholder={$t('search_albums')}
    />
  </form>

  {#if selectedAlbums.size > 0}
    <section class="flex flex-wrap gap-2 pt-5">
      {#each selectedAlbums as albumId (albumId)}
        {@const album = albumMap[albumId]}
        {#if album}
          <Button
            size="small"
            shape="round"
            color="primary"
            variant="outline"
            onclick={() => handleRemove(albumId)}
            trailingIcon={mdiClose}
            >{album.albumName}
          </Button>
        {/if}
      {/each}
    </section>
  {/if}
</div>
```

- [ ] **Step 6: Run the component test to verify it passes**

Run: `cd web && pnpm test src/lib/components/shared-components/search-bar/SearchAlbumsSection.spec.ts`
Expected: 3 tests PASS.

- [ ] **Step 7: Wire the section into `SearchFilters.svelte`**

In `web/src/lib/components/shared-components/search-bar/SearchFilters.svelte`:

1. Add `mdiImageMultiple` to the `@mdi/js` import list (keep it alphabetical: after `mdiImage`).
2. Change the sdk import to `import { getAllAlbums, getAllTags, type AlbumResponseDto, type PersonResponseDto, type TagResponseDto } from '@immich/sdk';`
3. Add `import SearchAlbumsSection from './SearchAlbumsSection.svelte';` next to the other section imports and `getSearchAlbumsTitle` to the `./search-bar-utils` import list.
4. After `let tags = $state<TagResponseDto[]>();` add:

```ts
  let albumsPromise = $state<Promise<AlbumResponseDto[]>>();
  let albums = $state<AlbumResponseDto[]>();
```

5. After `let tagsTitle = $state<string>();` add `let albumsTitle = $state<string>();`
6. In the `filters` array, add after the tags spread (before the `media` entry):

```ts
    {
      name: 'albums',
      icon: mdiImageMultiple,
      title: $t('albums'),
      activeTitle: () => albumsTitle,
    },
```

7. In `clear()` change to `peopleTitle = tagsTitle = albumsTitle = undefined;`
8. In `onMount`, after the tags block add:

```ts
    if (searchManager.filter.albumIds.size > 0 && !albumsPromise) {
      albumsPromise = getAllAlbums({});
      void albumsPromise.then((res) => (albums = res));
    }
```

9. After the tags `$effect` add:

```ts
  $effect(() => {
    if (albums) {
      albumsTitle = getSearchAlbumsTitle(albums, searchManager.filter.albumIds);
    }
  });
```

10. In the section switch, add after the `tags` branch:

```svelte
          {:else if activeFilter === 'albums'}
            <SearchAlbumsSection bind:title={albumsTitle} parentPromise={albumsPromise} />
```

- [ ] **Step 8: Check, lint and commit**

Run: `cd web && pnpm run check:svelte && pnpm run check:typescript && pnpm exec eslint src/lib/components/shared-components/search-bar src/lib/managers --max-warnings 0 && pnpm exec prettier --check src/lib/components/shared-components/search-bar ../i18n/en.json`
Expected: no errors. Fix formatting with `pnpm exec prettier --write <file>` if prettier complains.

Run: `cd web && pnpm test src/lib/components/shared-components/search-bar`
Expected: all PASS.

```bash
git add i18n/en.json web/src/lib/components/shared-components/search-bar
git commit -m "feat(web): filter search by album"
```

---

### Task 4: Album chip on the search results page

**Files:**
- Modify: `web/src/routes/(user)/search/[[photos=photos]]/[[assetId=id]]/+page.svelte`

**Interfaces:**
- Consumes: `terms.albumIds?: string[]` (parsed from the URL `query` param); `getAlbumInfo({ id })` from `@immich/sdk`.
- Produces: a removable "Albums: <names>" chip, matching the people/tags chips. No exported API.

- [ ] **Step 1: Implement**

In the page's `@immich/sdk` import add `getAlbumInfo` (alphabetical: before `getPerson`).

In `getHumanReadableSearchKey`'s `keyMap` add after `tagIds: $t('tags'),`:

```ts
      albumIds: $t('albums'),
```

After the `getTagNames` function add:

```ts
  async function getAlbumNames(albumIds: string[]) {
    const albumNames = await Promise.all(
      albumIds.map(async (albumId) => {
        const album = await getAlbumInfo({ id: albumId });

        return album.albumName;
      }),
    );

    return albumNames.join(', ');
  }
```

In the chip markup, add after the `tagIds` branch (before `{:else if searchKey === 'rating'}`):

```svelte
              {:else if searchKey === 'albumIds' && Array.isArray(value)}
                {#await getAlbumNames(value) then albumNames}
                  {albumNames}
                {/await}
```

- [ ] **Step 2: Check, lint and commit**

Run: `cd web && pnpm run check:svelte && pnpm run check:typescript && pnpm exec eslint "src/routes/(user)/search" --max-warnings 0 && pnpm exec prettier --check "src/routes/(user)/search"`
Expected: no errors.

```bash
git add "web/src/routes/(user)/search"
git commit -m "feat(web): show the album filter as a chip on search results"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full affected test suites**

Run: `cd server && pnpm test src/services/search.service.spec.ts && cd ../web && pnpm test src/lib/managers src/lib/components/shared-components/search-bar`
Expected: all PASS.

- [ ] **Step 2: Manual check in a running dev stack**

Run the dev stack (`make dev` from the repo root, or your usual flow), then with two users where user A owns an album shared with user B (user B is not a partner of A):

1. As user B open the search bar, Filter by: Albums, pick the shared album, press Search. Expected: A's photos from that album appear; the chip "Albums: <name>" is shown.
2. Type a text query (smart search, if ML is enabled) with the same album selected. Expected: results from A's shared album appear (this fails before Task 1).
3. Remove the chip. Expected: search reruns without the album restriction; reloading the page with the chip present keeps the selection.
4. Pick two albums. Expected: only photos present in both are returned (all-of semantics).

- [ ] **Step 3: Report**

Summarize results to the user, noting that mobile is unchanged.
