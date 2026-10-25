<script lang="ts">
  import { colorLabelClass, colorLabels } from '$lib/utils/color-label';
  import type { AssetColorLabel } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  interface Props {
    value: AssetColorLabel | null;
    onChange: (label: AssetColorLabel | null) => void;
    readOnly?: boolean;
  }

  let { value, onChange, readOnly = false }: Props = $props();

  const handleClick = (label: AssetColorLabel) => {
    if (readOnly) {
      return;
    }

    onChange(value === label ? null : label);
  };
</script>

<div class="flex flex-row items-center gap-2" role="group" aria-label={$t('color_label')}>
  {#each colorLabels as label (label)}
    {@const active = value === label}
    <button
      type="button"
      class={[
        'flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-subtle focus-visible:ring-2 focus-visible:ring-primary',
        active ? 'ring-2 ring-primary' : '',
        readOnly ? 'cursor-default opacity-70' : 'cursor-pointer',
      ]}
      aria-label={$t(`color_label_${label}`)}
      aria-pressed={active}
      disabled={readOnly}
      onclick={() => handleClick(label)}
    >
      <span class={['size-4 rounded-full', colorLabelClass[label]]}></span>
    </button>
  {/each}
</div>
