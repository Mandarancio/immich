import { updateAssets } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import TestWrapper from '$lib/components/TestWrapper.svelte';
import SetRatingAction from '$lib/components/timeline/actions/SetRatingAction.svelte';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  updateAssets: vi.fn(),
}));

describe('SetRatingAction', () => {
  const first = timelineAssetFactory.build({ ownerId: 'viewer', rating: null });
  const second = timelineAssetFactory.build({ ownerId: 'someone-else', rating: 2 });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(updateAssets).mockReset();
    vi.mocked(updateAssets).mockResolvedValue(undefined as never);
    authManager.setUser(userAdminFactory.build({ id: 'viewer' }));
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: true } }));
    first.rating = null;
    second.rating = 2;
    assetMultiSelectManager.clear();
    assetMultiSelectManager.selectAssets([first, second]);
  });

  afterEach(() => {
    assetMultiSelectManager.clear();
  });

  it('rates every selected asset and reports the update', async () => {
    const onRated = vi.fn();
    render(TestWrapper, { component: SetRatingAction, componentProps: { onRated } });

    await fireEvent.click(screen.getByRole('button', { name: 'set_rating' }));
    const options = screen.getAllByRole('menuitem');
    expect(options).toHaveLength(6);
    await fireEvent.click(options[2]);

    await waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({ assetBulkUpdateDto: { ids: [first.id, second.id], rating: 3 } }),
    );
    await waitFor(() => expect(onRated).toHaveBeenCalledWith([first.id, second.id], 3));
    expect(first.rating).toBe(3);
    expect(second.rating).toBe(3);
    expect(assetMultiSelectManager.selectionActive).toBe(false);
  });

  it('clears the rating by sending null', async () => {
    const onRated = vi.fn();
    render(TestWrapper, { component: SetRatingAction, componentProps: { onRated } });

    await fireEvent.click(screen.getByRole('button', { name: 'set_rating' }));
    await fireEvent.click(screen.getAllByRole('menuitem')[5]);

    await waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({ assetBulkUpdateDto: { ids: [first.id, second.id], rating: null } }),
    );
    await waitFor(() => expect(onRated).toHaveBeenCalledWith([first.id, second.id], null));
    expect(second.rating).toBeNull();
  });

  it('keeps the local state untouched when the request fails', async () => {
    vi.mocked(updateAssets).mockRejectedValue(new Error('nope'));
    const onRated = vi.fn();
    render(TestWrapper, { component: SetRatingAction, componentProps: { onRated } });

    await fireEvent.click(screen.getByRole('button', { name: 'set_rating' }));
    await fireEvent.click(screen.getAllByRole('menuitem')[0]);

    await waitFor(() => expect(updateAssets).toHaveBeenCalled());
    expect(onRated).not.toHaveBeenCalled();
    expect(second.rating).toBe(2);
  });

  it('is hidden when ratings are disabled', () => {
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: false } }));
    render(TestWrapper, { component: SetRatingAction, componentProps: {} });

    expect(screen.queryByRole('button', { name: 'set_rating' })).toBeNull();
  });

  it('is hidden on a shared link', () => {
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
    render(TestWrapper, { component: SetRatingAction, componentProps: {} });

    expect(screen.queryByRole('button', { name: 'set_rating' })).toBeNull();
  });
});
