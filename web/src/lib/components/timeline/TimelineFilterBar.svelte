<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import type { TimelineFilterManager } from '$lib/managers/timeline-filter-manager.svelte';
  import { colorLabelClass, colorLabels } from '$lib/utils/color-label';
  import { Icon } from '@immich/ui';
  import { mdiClose, mdiHeart, mdiHeartOutline, mdiStar, mdiStarOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    filter: TimelineFilterManager;
    hideFavorite?: boolean;
  }

  let { filter, hideFavorite = false }: Props = $props();

  const stars = [1, 2, 3, 4, 5];
  const ratingsEnabled = $derived(authManager.authenticated && authManager.preferences.ratings.enabled);

  const colorLabelNames = $derived({
    red: $t('color_label_red'),
    yellow: $t('color_label_yellow'),
    green: $t('color_label_green'),
    blue: $t('color_label_blue'),
    purple: $t('color_label_purple'),
  });

  const buttonClass =
    'flex h-8 items-center gap-1 rounded-full border px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-primary';
  const idleClass = 'border-gray-300 text-dark hover:bg-subtle dark:border-gray-600';
  const activeClass = 'border-primary bg-primary text-light';
</script>

<div
  class="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 py-2"
  role="group"
  aria-label={$t('quick_filters')}
  data-testid="timeline-filter-bar"
>
  {#if !hideFavorite}
    <button
      type="button"
      data-testid="filter-favorite"
      class={[buttonClass, filter.isFavorite ? activeClass : idleClass]}
      aria-pressed={filter.isFavorite}
      aria-label={$t('favorites')}
      title={$t('favorites')}
      onclick={() => (filter.isFavorite = !filter.isFavorite)}
    >
      <Icon icon={filter.isFavorite ? mdiHeart : mdiHeartOutline} size="18" aria-hidden />
    </button>
  {/if}

  {#if ratingsEnabled}
    <div class="flex items-center gap-1" role="group" aria-label={$t('filter_rating_min')}>
      {#each stars as star (star)}
        {@const selected = filter.rating !== undefined && star <= filter.rating}
        <button
          type="button"
          data-testid="filter-star-{star}"
          class={[
            'rounded-full p-1 focus-visible:outline-2 focus-visible:outline-primary',
            selected ? 'text-primary' : 'text-gray-400 hover:text-primary',
          ]}
          aria-pressed={filter.rating === star}
          aria-label={$t('filter_rating_min_count', { values: { count: star } })}
          title={$t('filter_rating_min')}
          onclick={() => filter.setRating(filter.rating === star ? undefined : star)}
        >
          <Icon icon={selected ? mdiStar : mdiStarOutline} size="20" aria-hidden />
        </button>
      {/each}
    </div>

    <button
      type="button"
      data-testid="filter-unrated"
      class={[buttonClass, filter.unrated ? activeClass : idleClass]}
      aria-pressed={filter.unrated}
      onclick={() => (filter.unrated = !filter.unrated)}
    >
      {$t('filter_unrated')}
    </button>
  {/if}

  <div class="flex items-center gap-2" role="group" aria-label={$t('color')}>
    {#each colorLabels as label (label)}
      {@const pressed = filter.colorLabels.includes(label)}
      <button
        type="button"
        data-testid="filter-color-{label}"
        class={[
          'size-6 rounded-full border-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
          colorLabelClass[label],
          pressed ? 'border-dark ring-2 ring-primary' : 'border-transparent opacity-70 hover:opacity-100',
        ]}
        aria-pressed={pressed}
        aria-label={colorLabelNames[label]}
        title={colorLabelNames[label]}
        onclick={() => filter.toggleColor(label)}
      ></button>
    {/each}
    <button
      type="button"
      data-testid="filter-color-none"
      class={[buttonClass, 'h-6 px-2 text-xs', filter.colorLabels.includes('none') ? activeClass : idleClass]}
      aria-pressed={filter.colorLabels.includes('none')}
      onclick={() => filter.toggleColor('none')}
    >
      {$t('filter_no_color')}
    </button>
  </div>

  {#if filter.active}
    <button
      type="button"
      data-testid="filter-clear-all"
      class="flex items-center gap-1 text-sm text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
      onclick={() => filter.clear()}
    >
      <Icon icon={mdiClose} size="16" aria-hidden />
      {$t('clear_all')}
    </button>
  {/if}
</div>
