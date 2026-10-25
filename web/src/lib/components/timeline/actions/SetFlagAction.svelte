<script lang="ts">
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleBulkSetFlag } from '$lib/services/asset.service';
  import { optionClickCallbackStore } from '$lib/stores/context-menu.store';
  import { AssetFlag } from '@immich/sdk';
  import { mdiClose, mdiFlag, mdiFlagOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    onFlagged?: (ids: string[], flag: AssetFlag | null) => void;
  }

  let { onFlagged }: Props = $props();

  const handleFlag = async (flag: AssetFlag | null) => {
    // eslint-disable-next-line unicorn/no-optional-chaining-on-undeclared-variable
    $optionClickCallbackStore?.();
    const ids = await handleBulkSetFlag(assetMultiSelectManager.assets, flag, onFlagged);
    if (ids) {
      assetMultiSelectManager.clear();
    }
  };
</script>

{#if !authManager.isSharedLink}
  <ButtonContextMenu icon={mdiFlagOutline} title={$t('set_flag')}>
    <MenuOption icon={mdiFlag} text={$t('flag_picked')} onClick={() => handleFlag(AssetFlag.Pick)} />
    <MenuOption icon={mdiClose} text={$t('flag_rejected')} onClick={() => handleFlag(AssetFlag.Reject)} />
    <MenuOption icon={mdiFlagOutline} text={$t('clear_flag')} onClick={() => handleFlag(null)} />
  </ButtonContextMenu>
{/if}
