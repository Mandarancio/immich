import { omit } from 'lodash-es';
import type { TimelineFilter } from '$lib/managers/timeline-filter-manager.svelte';
import type { TimelineAsset, TimelineManagerOptions } from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function updateObject(target: any, source: any): boolean {
  if (!target) {
    return false;
  }
  let updated = false;
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }
    if (key === '__proto__' || key === 'constructor') {
      continue;
    }
    const isDate = target[key] instanceof Date;
    if (target[key] !== null && typeof target[key] === 'object' && !isDate) {
      updated ||= updateObject(target[key], source[key]);
    } else {
      if (target[key] !== source[key]) {
        target[key] = source[key];
        updated = true;
      }
    }
  }
  return updated;
}
/**
 * Strip the per-user fields (rating, colorLabel) from a payload that carries no viewer state, so that
 * applying it to an existing asset never overwrites the viewer's values.
 */
export function withoutUserState(asset: TimelineAsset): TimelineAsset {
  return omit(asset, ['rating', 'colorLabel']) as TimelineAsset;
}

/** Drop unset values, the favorite toggle when the page overrides it, and empty filters. */
export function normalizeFilter(
  filter: TimelineFilter | undefined,
  pageIsFavorite: boolean | undefined,
): TimelineFilter | undefined {
  if (!filter) {
    return undefined;
  }
  const normalized: TimelineFilter = {};
  if (filter.isFavorite && pageIsFavorite === undefined) {
    normalized.isFavorite = true;
  }
  if (filter.rating !== undefined) {
    normalized.rating = filter.rating;
  }
  if (filter.unrated) {
    normalized.unrated = true;
  }
  if (filter.colorLabels && filter.colorLabels.length > 0) {
    normalized.colorLabels = filter.colorLabels;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function isMismatched<T>(option: T | undefined, value: T): boolean {
  return option === undefined ? false : option !== value;
}

export function matchesFilter(filter: TimelineFilter | undefined, asset: TimelineAsset): boolean {
  if (!filter) {
    return true;
  }
  if (filter.isFavorite && !asset.isFavorite) {
    return false;
  }
  if (filter.rating !== undefined || filter.unrated) {
    // rating and unrated are OR'd; rating is a minimum (rejected, -1, never matches)
    const matchesRating = filter.rating !== undefined && asset.rating !== null && asset.rating >= filter.rating;
    const matchesUnrated = !!filter.unrated && asset.rating === null;
    if (!matchesRating && !matchesUnrated) {
      return false;
    }
  }
  return (
    !filter.colorLabels || filter.colorLabels.length === 0 || filter.colorLabels.includes(asset.colorLabel ?? 'none')
  );
}

/** Build the bucket request params: page options win over the filter's favorite toggle. */
export function toBucketRequestParams(options: TimelineManagerOptions) {
  const { filter, ...rest } = options;
  return {
    ...rest,
    isFavorite: options.isFavorite ?? filter?.isFavorite,
    rating: filter?.rating,
    unrated: filter?.unrated,
    colorLabels: filter?.colorLabels,
  };
}
