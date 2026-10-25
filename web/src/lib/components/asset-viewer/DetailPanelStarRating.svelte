<script lang="ts">
  import StarRating, { type Rating } from '$lib/elements/StarRating.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
  }

  let { asset, isOwner }: Props = $props();

  // exifInfo.rating is already the viewer-effective rating
  let rating = $derived(asset.exifInfo?.rating ?? null) as Rating;

  const handleChangeRating = async (rating: Rating) => {
    // only the asset owner may reject (-1)
    if (rating === -1 && !isOwner) {
      return;
    }

    try {
      const response = await updateAsset({ id: asset.id, updateAssetDto: { rating } });
      eventManager.emit('AssetUpdate', response);
    } catch (error) {
      handleError(error, $t('errors.cant_apply_changes'));
    }
  };
</script>

{#if !authManager.isSharedLink && authManager.authenticated && authManager.preferences.ratings.enabled}
  <section class="px-4 pt-4">
    <StarRating {rating} onRating={(rating) => handlePromiseError(handleChangeRating(rating))} />
  </section>
{/if}
