<script lang="ts">
  import SearchButton from './SearchButton.svelte';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import { Text } from '@immich/ui';
  import { mdiThumbUpOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let filters = $derived(searchManager.filter.display);
</script>

<div id="display-options-selection">
  <fieldset>
    <Text class="py-5" fontWeight="medium">{$t('library')}</Text>
    <div class="flex flex-wrap gap-2">
      <SearchButton checked active={filters.isFavorite} onclick={() => (filters.isFavorite = !filters.isFavorite)}
        >{$t('favorites')}</SearchButton
      >
      <SearchButton checked active={filters.isArchive} onclick={() => (filters.isArchive = !filters.isArchive)}
        >{$t('archive')}</SearchButton
      >
      <SearchButton checked active={filters.isNotInAlbum} onclick={() => (filters.isNotInAlbum = !filters.isNotInAlbum)}
        >{$t('search_filter_display_option_not_in_album')}</SearchButton
      >
      <SearchButton
        checked
        active={filters.isLiked}
        leadingIcon={mdiThumbUpOutline}
        onclick={() => (filters.isLiked = !filters.isLiked)}>{$t('search_filter_liked')}</SearchButton
      >
      <SearchButton
        checked
        active={filters.isLikedByMe}
        leadingIcon={mdiThumbUpOutline}
        onclick={() => (filters.isLikedByMe = !filters.isLikedByMe)}>{$t('search_filter_liked_by_me')}</SearchButton
      >
    </div>
  </fieldset>
</div>
