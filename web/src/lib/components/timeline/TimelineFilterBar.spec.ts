import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import TimelineFilterBar from '$lib/components/timeline/TimelineFilterBar.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { TimelineFilterManager } from '$lib/managers/timeline-filter-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

describe('TimelineFilterBar component', () => {
  let filter: TimelineFilterManager;

  beforeEach(() => {
    filter = new TimelineFilterManager();
    authManager.setUser(userAdminFactory.build());
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: true } }));
  });

  afterEach(() => {
    authManager.reset();
  });

  it('sets the minimum rating when a star is clicked and clears it when clicked again', async () => {
    const user = userEvent.setup();
    render(TimelineFilterBar, { props: { filter } });

    await user.click(screen.getByTestId('filter-star-3'));
    expect(filter.rating).toBe(3);
    expect(screen.getByTestId('filter-star-3').getAttribute('aria-pressed')).toBe('true');

    await user.click(screen.getByTestId('filter-star-3'));
    expect(filter.rating).toBeUndefined();
    expect(screen.getByTestId('filter-star-3').getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles the unrated filter', async () => {
    const user = userEvent.setup();
    render(TimelineFilterBar, { props: { filter } });

    await user.click(screen.getByTestId('filter-unrated'));
    expect(filter.unrated).toBe(true);

    await user.click(screen.getByTestId('filter-unrated'));
    expect(filter.unrated).toBe(false);
  });

  it('toggles a color chip', async () => {
    const user = userEvent.setup();
    render(TimelineFilterBar, { props: { filter } });

    await user.click(screen.getByTestId('filter-color-red'));
    expect(filter.colorLabels).toContain('red');
    expect(screen.getByTestId('filter-color-red').getAttribute('aria-pressed')).toBe('true');

    await user.click(screen.getByTestId('filter-color-none'));
    expect(filter.colorLabels).toEqual(['red', 'none']);

    await user.click(screen.getByTestId('filter-color-red'));
    expect(filter.colorLabels).toEqual(['none']);
  });

  it('toggles the favorite filter', async () => {
    const user = userEvent.setup();
    render(TimelineFilterBar, { props: { filter } });

    await user.click(screen.getByTestId('filter-favorite'));
    expect(filter.isFavorite).toBe(true);
  });

  it('shows clear all only when a filter is active and resets the filter', async () => {
    const user = userEvent.setup();
    render(TimelineFilterBar, { props: { filter } });

    expect(screen.queryByTestId('filter-clear-all')).toBeNull();

    await user.click(screen.getByTestId('filter-color-blue'));
    await user.click(screen.getByTestId('filter-star-2'));
    expect(screen.getByTestId('filter-clear-all')).toBeTruthy();

    await user.click(screen.getByTestId('filter-clear-all'));
    expect(filter.active).toBe(false);
    expect(filter.colorLabels).toEqual([]);
    expect(filter.rating).toBeUndefined();
    expect(screen.queryByTestId('filter-clear-all')).toBeNull();
  });

  it('hides the favorite toggle with hideFavorite', () => {
    render(TimelineFilterBar, { props: { filter, hideFavorite: true } });

    expect(screen.queryByTestId('filter-favorite')).toBeNull();
    expect(screen.getByTestId('filter-color-red')).toBeTruthy();
  });

  it('hides star and unrated controls when ratings are disabled', () => {
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: false } }));
    render(TimelineFilterBar, { props: { filter } });

    expect(screen.queryByTestId('filter-star-1')).toBeNull();
    expect(screen.queryByTestId('filter-unrated')).toBeNull();
    expect(screen.getByTestId('filter-favorite')).toBeTruthy();
    expect(screen.getByTestId('filter-color-red')).toBeTruthy();
  });
});
