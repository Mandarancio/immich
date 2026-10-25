import { fireEvent, render, screen } from '@testing-library/svelte';
import TestWrapper from '$lib/components/TestWrapper.svelte';
import CompareAction from '$lib/components/timeline/actions/CompareAction.svelte';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { compareManager } from '$lib/managers/compare-manager.svelte';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';

describe('CompareAction', () => {
  const select = (count: number) => {
    const assets = timelineAssetFactory.buildList(count);
    assetMultiSelectManager.clear();
    assetMultiSelectManager.selectAssets(assets);
    return assets;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    compareManager.close();
    assetMultiSelectManager.clear();
  });

  afterEach(() => {
    compareManager.close();
    assetMultiSelectManager.clear();
  });

  it.each([1, 7])('is disabled with the range hint for %i selected assets', async (count) => {
    select(count);
    render(TestWrapper, { component: CompareAction, componentProps: {} });

    const button = screen.getByRole('button', { name: 'compare_select_range' });
    expect(button).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'compare_photos' })).toBeNull();

    await fireEvent.click(button);
    expect(compareManager.isOpen).toBe(false);
  });

  it.each([2, 3, 6])('is enabled for %i selected assets', (count) => {
    select(count);
    render(TestWrapper, { component: CompareAction, componentProps: {} });

    expect(screen.getByRole('button', { name: 'compare_photos' })).toHaveProperty('disabled', false);
  });

  it('opens the compare manager with the selection and the callback, and keeps the selection', async () => {
    const assets = select(3);
    const onUpdated = vi.fn();
    const open = vi.spyOn(compareManager, 'open');
    render(TestWrapper, { component: CompareAction, componentProps: { onUpdated } });

    await fireEvent.click(screen.getByRole('button', { name: 'compare_photos' }));

    expect(open).toHaveBeenCalledWith(assets, onUpdated);
    expect(compareManager.isOpen).toBe(true);
    expect(assetMultiSelectManager.selectionActive).toBe(true);
    expect(assetMultiSelectManager.assets.map(({ id }) => id)).toEqual(assets.map(({ id }) => id));
  });

  it('is hidden on a shared link', () => {
    select(3);
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
    render(TestWrapper, { component: CompareAction, componentProps: {} });

    expect(screen.queryByRole('button', { name: 'compare_photos' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'compare_select_range' })).toBeNull();
  });
});
