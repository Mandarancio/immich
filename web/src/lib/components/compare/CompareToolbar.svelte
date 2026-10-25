<script lang="ts">
  import { compareManager, MAGNIFIER_LEVELS } from '$lib/managers/compare-manager.svelte';
  import { Button, IconButton } from '@immich/ui';
  import { mdiImageFilterCenterFocus, mdiMagnify } from '@mdi/js';
  import { t } from 'svelte-i18n';

  const focusLabel = $derived(`${$t('compare_focus_mode')} (F)`);
  const magnifierLabel = $derived(`${$t('compare_magnifier')} (M)`);
</script>

<div
  role="toolbar"
  aria-label={$t('compare_tools')}
  data-testid="compare-toolbar"
  class="flex items-center gap-1 rounded-full bg-white/10 p-1"
>
  <IconButton
    shape="round"
    size="small"
    color="secondary"
    variant={compareManager.focusMode ? 'filled' : 'ghost'}
    icon={mdiImageFilterCenterFocus}
    aria-label={focusLabel}
    title={focusLabel}
    aria-pressed={compareManager.focusMode}
    data-testid="compare-tool-focus"
    onclick={() => compareManager.toggleFocusMode()}
  />
  <IconButton
    shape="round"
    size="small"
    color="secondary"
    variant={compareManager.magnifierEnabled ? 'filled' : 'ghost'}
    icon={mdiMagnify}
    aria-label={magnifierLabel}
    title={magnifierLabel}
    aria-pressed={compareManager.magnifierEnabled}
    data-testid="compare-tool-magnifier"
    onclick={() => compareManager.toggleMagnifier()}
  />
  {#if compareManager.magnifierEnabled}
    <div role="group" aria-label={$t('compare_magnifier_level')} class="flex items-center gap-1 pr-1">
      {#each MAGNIFIER_LEVELS as level (level)}
        <Button
          shape="round"
          size="tiny"
          color="secondary"
          variant={compareManager.magnifierLevel === level ? 'filled' : 'ghost'}
          aria-pressed={compareManager.magnifierLevel === level}
          data-testid="compare-magnifier-level-{level}"
          onclick={() => compareManager.setMagnifierLevel(level)}
        >
          {level}×
        </Button>
      {/each}
    </div>
  {/if}
</div>
