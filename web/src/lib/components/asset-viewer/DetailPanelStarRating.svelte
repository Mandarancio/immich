<script lang="ts">
  import StarRating, { type Rating } from '$lib/elements/StarRating.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleRate } from '$lib/services/asset.service';
  import { handlePromiseError } from '$lib/utils';
  import { type AssetResponseDto } from '@immich/sdk';

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset }: Props = $props();

  // exifInfo.rating is already the viewer-effective rating
  let rating = $derived(asset.exifInfo?.rating ?? null) as Rating;
</script>

{#if !authManager.isSharedLink && authManager.authenticated && authManager.preferences.ratings.enabled}
  <section class="px-4 pt-4">
    <StarRating {rating} onRating={(value) => handlePromiseError(handleRate(asset, value ?? 0))} />
  </section>
{/if}
