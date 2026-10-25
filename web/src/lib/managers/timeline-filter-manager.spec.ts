import { AssetColorLabel } from '@immich/sdk';
import { TimelineFilterManager } from '$lib/managers/timeline-filter-manager.svelte';

describe('TimelineFilterManager', () => {
  let filter: TimelineFilterManager;

  beforeEach(() => {
    filter = new TimelineFilterManager();
  });

  it('is inactive with an empty query by default', () => {
    expect(filter.active).toBe(false);
    expect(filter.query).toEqual({});
  });

  it('includes isFavorite only when true', () => {
    filter.isFavorite = true;
    expect(filter.active).toBe(true);
    expect(filter.query).toEqual({ isFavorite: true });

    filter.isFavorite = false;
    expect(filter.query).toEqual({});
  });

  it('sets and clears the rating', () => {
    filter.setRating(3);
    expect(filter.active).toBe(true);
    expect(filter.query).toEqual({ rating: 3 });

    filter.setRating();
    expect(filter.active).toBe(false);
    expect(filter.query).toEqual({});
  });

  it('includes unrated only when true, alongside rating', () => {
    filter.unrated = true;
    expect(filter.active).toBe(true);
    expect(filter.query).toEqual({ unrated: true });

    filter.setRating(4);
    expect(filter.query).toEqual({ rating: 4, unrated: true });
  });

  it('toggles color labels', () => {
    filter.toggleColor(AssetColorLabel.Red);
    filter.toggleColor('none');
    expect(filter.active).toBe(true);
    expect(filter.query).toEqual({ colorLabels: [AssetColorLabel.Red, 'none'] });

    filter.toggleColor(AssetColorLabel.Red);
    expect(filter.query).toEqual({ colorLabels: ['none'] });

    filter.toggleColor('none');
    expect(filter.active).toBe(false);
    expect(filter.query).toEqual({});
  });

  it('returns a query that is detached from internal state', () => {
    filter.toggleColor(AssetColorLabel.Blue);
    const { query } = filter;
    filter.toggleColor(AssetColorLabel.Green);
    expect(query.colorLabels).toEqual([AssetColorLabel.Blue]);
  });

  it('clear resets everything', () => {
    filter.isFavorite = true;
    filter.setRating(2);
    filter.unrated = true;
    filter.toggleColor(AssetColorLabel.Purple);

    filter.clear();

    expect(filter.active).toBe(false);
    expect(filter.isFavorite).toBe(false);
    expect(filter.rating).toBeUndefined();
    expect(filter.unrated).toBe(false);
    expect(filter.colorLabels).toEqual([]);
    expect(filter.query).toEqual({});
  });
});
