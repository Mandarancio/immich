<script lang="ts">
  import { flagValues } from '$lib/utils/flag';
  import { AssetFlag } from '@immich/sdk';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import SearchButton from './SearchButton.svelte';

  type Props = {
    selected: Array<AssetFlag | 'none'>;
  };

  let { selected = $bindable() }: Props = $props();

  const toggle = (value: AssetFlag | 'none') => {
    selected = selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
  };
</script>

<div id="flag-selection" class="flex flex-col">
  <Text class="my-5" fontWeight="medium">{$t('flag')}</Text>
  <div class="flex flex-wrap gap-2">
    {#each flagValues as flag (flag)}
      <SearchButton
        active={selected.includes(flag)}
        aria-pressed={selected.includes(flag)}
        onclick={() => toggle(flag)}
      >
        {$t(`flag_${flag === AssetFlag.Pick ? 'picked' : 'rejected'}`)}
      </SearchButton>
    {/each}
    <SearchButton
      active={selected.includes('none')}
      aria-pressed={selected.includes('none')}
      onclick={() => toggle('none')}
    >
      {$t('filter_unflagged')}
    </SearchButton>
  </div>
</div>
