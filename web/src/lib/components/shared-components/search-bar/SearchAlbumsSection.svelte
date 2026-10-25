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
