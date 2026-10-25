<script lang="ts">
  import { matchesShortcut, type Shortcut } from '$lib/actions/shortcut';
  import CompareSlot from '$lib/components/compare/CompareSlot.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { compareManager } from '$lib/managers/compare-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { colorLabelShortcut } from '$lib/utils/color-label';
  import { clearFlagShortcut, flagShortcut } from '$lib/utils/flag';
  import { getTabbable } from '$lib/utils/focus-util';
  import { AssetColorLabel, AssetFlag } from '@immich/sdk';
  import { IconButton } from '@immich/ui';
  import { mdiClose } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Binding = { shortcut: Shortcut; run: () => void };

  const ratingsEnabled = () => authManager.authenticated && authManager.preferences.ratings.enabled;

  const ratingKeys = ['0', '1', '2', '3', '4', '5'];

  const colorBindings: Binding[] = Object.values(AssetColorLabel)
    .filter((label) => colorLabelShortcut[label])
    .map((label) => ({
      shortcut: { key: colorLabelShortcut[label]! },
      run: () => handlePromiseError(compareManager.toggleColor(label)),
    }));

  const bindings: Binding[] = [
    { shortcut: { key: 'ArrowRight' }, run: () => compareManager.focusNext() },
    { shortcut: { key: 'ArrowDown' }, run: () => compareManager.focusNext() },
    { shortcut: { key: 'ArrowLeft' }, run: () => compareManager.focusPrevious() },
    { shortcut: { key: 'ArrowUp' }, run: () => compareManager.focusPrevious() },
    {
      shortcut: { key: flagShortcut[AssetFlag.Pick] },
      run: () => handlePromiseError(compareManager.toggleFlag(AssetFlag.Pick)),
    },
    {
      shortcut: { key: flagShortcut[AssetFlag.Reject] },
      run: () => handlePromiseError(compareManager.toggleFlag(AssetFlag.Reject)),
    },
    { shortcut: { key: clearFlagShortcut }, run: () => handlePromiseError(compareManager.setFlag(null)) },
    ...ratingKeys.map((key) => ({
      shortcut: { key },
      run: () => {
        if (ratingsEnabled()) {
          handlePromiseError(compareManager.rate(key === '0' ? null : Number(key)));
        }
      },
    })),
    ...colorBindings,
    { shortcut: { key: 'Backspace' }, run: () => compareManager.remove() },
    { shortcut: { key: 'z' }, run: () => compareManager.toggleActualSize() },
    { shortcut: { key: 'Escape' }, run: () => compareManager.close() },
  ];

  const hints = $derived([
    { keys: '←→↑↓', label: '' },
    { keys: 'K', label: $t('flag_picked') },
    { keys: 'R', label: $t('flag_rejected') },
    { keys: 'U', label: $t('clear_flag') },
    ...(ratingsEnabled() ? [{ keys: '0-5', label: $t('rating') }] : []),
    { keys: '6-9', label: $t('color_label') },
    { keys: '⌫', label: $t('remove') },
    { keys: 'Z', label: $t('compare_actual_size') },
    { keys: 'Esc', label: $t('compare_exit') },
  ]);

  /**
   * Behaviour of the open overlay: moves focus into it (and back on close), locks the page scroll and owns the
   * keyboard. Keys are handled in the capture phase on the window, before any page level shortcut handler
   * (which listen on the document) can see them, and every keydown is kept away from them while the overlay is open.
   * Only the keys the overlay handles are `preventDefault`ed, so browser shortcuts keep working.
   */
  const overlay = (node: HTMLElement) => {
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    node.focus();

    const trapTab = (event: KeyboardEvent) => {
      const tabbable = getTabbable(node, false);
      if (tabbable.length === 0) {
        return;
      }
      const first = tabbable[0];
      const last = tabbable.at(-1)!;
      const active = document.activeElement;
      const leavingStart = event.shiftKey && (active === first || active === node);
      const leavingEnd = !event.shiftKey && active === last;
      if (leavingStart) {
        last.focus();
        event.preventDefault();
      } else if (leavingEnd || !node.contains(active)) {
        first.focus();
        event.preventDefault();
      }
    };

    const onKeydown = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      event.stopPropagation();

      if (event.key === 'Tab') {
        trapTab(event);
        return;
      }

      const binding = bindings.find(({ shortcut }) => matchesShortcut(event, shortcut));
      if (binding) {
        event.preventDefault();
        binding.run();
      }
    };

    addEventListener('keydown', onKeydown, { capture: true });

    return {
      destroy() {
        removeEventListener('keydown', onKeydown, { capture: true });
        document.body.style.overflow = previousOverflow;
        if (previouslyFocused instanceof HTMLElement) {
          previouslyFocused.focus();
        }
      },
    };
  };

  const grid = $derived(compareManager.grid);
</script>

{#if compareManager.isOpen}
  <div
    data-testid="compare-view"
    class="fixed inset-0 z-1100 flex flex-col bg-black text-white outline-none"
    role="dialog"
    aria-modal="true"
    aria-label={$t('compare_photos')}
    tabindex="-1"
    use:overlay
  >
    <div class="flex h-14 shrink-0 items-center justify-between gap-4 px-4">
      <div class="flex items-center gap-3">
        <h2 class="text-lg font-medium">{$t('compare_photos')}</h2>
        <span data-testid="compare-remaining" class="text-sm text-white/70">{compareManager.remaining}</span>
      </div>

      {#if compareManager.remaining === 1}
        <p role="status" class="rounded-sm bg-white/15 px-3 py-1 text-sm">{$t('compare_one_left')}</p>
      {/if}

      <IconButton
        shape="round"
        color="secondary"
        variant="ghost"
        icon={mdiClose}
        aria-label={$t('compare_exit')}
        onclick={() => compareManager.close()}
      />
    </div>

    <div
      data-testid="compare-grid"
      class="grid min-h-0 flex-1 gap-1 px-1"
      style:grid-template-columns="repeat({grid.columns}, 1fr)"
      style:grid-template-rows="repeat({grid.rows}, 1fr)"
    >
      {#each compareManager.visible as asset (asset.id)}
        <CompareSlot {asset} focused={asset.id === compareManager.focusedId} />
      {/each}
    </div>

    <div
      data-testid="compare-hints"
      class="flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 py-2 text-xs text-white/70"
    >
      {#each hints as hint (hint.keys)}
        <span class="flex items-center gap-1">
          <kbd class="rounded-sm border border-white/30 px-1.5 py-0.5 font-mono text-white">{hint.keys}</kbd>
          {#if hint.label}
            {hint.label}
          {/if}
        </span>
      {/each}
    </div>
  </div>
{/if}
