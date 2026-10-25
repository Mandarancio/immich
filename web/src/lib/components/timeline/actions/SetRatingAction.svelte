<script lang="ts">
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleBulkRate } from '$lib/services/asset.service';
  import { mdiStarOffOutline, mdiStarOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    onRated?: (ids: string[], rating: number | null) => void;
  }

  let { onRated }: Props = $props();

  const ratings = [1, 2, 3, 4, 5];

  const handleRate = async (rating: number | null) => {
    const ids = await handleBulkRate(assetMultiSelectManager.assets, rating, onRated);
    if (ids) {
      assetMultiSelectManager.clear();
    }
  };
</script>

{#if authManager.preferences.ratings.enabled && !authManager.isSharedLink}
  <ButtonContextMenu icon={mdiStarOutline} title={$t('set_rating')}>
    {#each ratings as rating (rating)}
      <MenuOption
        icon={mdiStarOutline}
        text={$t('rating_count', { values: { count: rating } })}
        onClick={() => handleRate(rating)}
      />
    {/each}
    <MenuOption icon={mdiStarOffOutline} text={$t('rating_clear')} onClick={() => handleRate(null)} />
  </ButtonContextMenu>
{/if}
