<script lang="ts">
  import { colorLabelClass, colorLabels } from '$lib/utils/color-label';
  import type { AssetColorLabel } from '@immich/sdk';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import SearchButton from './SearchButton.svelte';

  type Props = {
    selected: Array<AssetColorLabel | 'none'>;
  };

  let { selected = $bindable() }: Props = $props();

  const toggle = (value: AssetColorLabel | 'none') => {
    selected = selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
  };
</script>

<div id="color-label-selection" class="flex flex-col">
  <Text class="my-5" fontWeight="medium">{$t('color_label')}</Text>
  <div class="flex flex-wrap gap-2">
    {#each colorLabels as color (color)}
      {@const label = $t(`color_label_${color}`)}
      <SearchButton
        active={selected.includes(color)}
        aria-pressed={selected.includes(color)}
        onclick={() => toggle(color)}
      >
        <span class="flex items-center gap-2">
          <span class="size-3 rounded-full {colorLabelClass[color]}" aria-hidden="true"></span>
          {label}
        </span>
      </SearchButton>
    {/each}
    <SearchButton
      active={selected.includes('none')}
      aria-pressed={selected.includes('none')}
      onclick={() => toggle('none')}
    >
      {$t('filter_no_color')}
    </SearchButton>
  </div>
</div>
