<script lang="ts">
  import ColorLabelPicker from '$lib/components/asset-viewer/ColorLabelPicker.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleBulkSetColorLabel } from '$lib/services/asset.service';
  import { optionClickCallbackStore } from '$lib/stores/context-menu.store';
  import type { AssetColorLabel } from '@immich/sdk';
  import { mdiPaletteOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    onLabeled?: (ids: string[], label: AssetColorLabel | null) => void;
  }

  let { onLabeled }: Props = $props();

  const handleLabel = async (label: AssetColorLabel | null) => {
    // eslint-disable-next-line unicorn/no-optional-chaining-on-undeclared-variable
    $optionClickCallbackStore?.();
    const ids = await handleBulkSetColorLabel(assetMultiSelectManager.assets, label, onLabeled);
    if (ids) {
      assetMultiSelectManager.clear();
    }
  };
</script>

{#if !authManager.isSharedLink}
  <ButtonContextMenu icon={mdiPaletteOutline} title={$t('set_color_label')}>
    <li class="bg-slate-100 p-4" role="none">
      <!-- the picker toggles, but the selection may be mixed, so the current value is never preselected -->
      <ColorLabelPicker value={null} onChange={(label) => handleLabel(label)} />
    </li>
    <MenuOption icon={mdiPaletteOutline} text={$t('clear_color_label')} onClick={() => handleLabel(null)} />
  </ButtonContextMenu>
{/if}
