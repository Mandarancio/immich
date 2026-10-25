<script lang="ts">
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { COMPARE_MAX, COMPARE_MIN, compareManager, type CompareUpdate } from '$lib/managers/compare-manager.svelte';
  import { IconButton } from '@immich/ui';
  import { mdiCompare } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    onUpdated?: (ids: string[], update: CompareUpdate) => void;
  }

  let { onUpdated }: Props = $props();

  const count = $derived(assetMultiSelectManager.assets.length);
  const enabled = $derived(count >= COMPARE_MIN && count <= COMPARE_MAX);
  const title = $derived(enabled ? $t('compare_photos') : $t('compare_select_range'));

  const handleCompare = () => {
    // The selection stays as it is, so it is still there when the overlay closes.
    compareManager.open(assetMultiSelectManager.assets, onUpdated);
  };
</script>

{#if !authManager.isSharedLink}
  <IconButton
    shape="round"
    color="secondary"
    variant="ghost"
    aria-label={title}
    {title}
    icon={mdiCompare}
    disabled={!enabled}
    onclick={handleCompare}
  />
{/if}
