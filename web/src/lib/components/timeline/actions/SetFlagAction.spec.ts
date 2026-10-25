import { AssetFlag, updateAssets } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import TestWrapper from '$lib/components/TestWrapper.svelte';
import SetFlagAction from '$lib/components/timeline/actions/SetFlagAction.svelte';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  updateAssets: vi.fn(),
}));

describe('SetFlagAction', () => {
  const first = timelineAssetFactory.build({ ownerId: 'viewer', flag: null });
  const second = timelineAssetFactory.build({ ownerId: 'someone-else', flag: AssetFlag.Reject });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(updateAssets).mockReset();
    vi.mocked(updateAssets).mockResolvedValue(undefined as never);
    authManager.setUser(userAdminFactory.build({ id: 'viewer' }));
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: false } }));
    first.flag = null;
    second.flag = AssetFlag.Reject;
    assetMultiSelectManager.clear();
    assetMultiSelectManager.selectAssets([first, second]);
  });

  afterEach(() => {
    assetMultiSelectManager.clear();
  });

  it('offers pick, reject and clear', async () => {
    render(TestWrapper, { component: SetFlagAction, componentProps: {} });

    await fireEvent.click(screen.getByRole('button', { name: 'set_flag' }));

    expect(screen.getByRole('menuitem', { name: /pick/ })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: /reject/ })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: /clear_flag/ })).toBeDefined();
  });

  it('picks every selected asset, reports the update and clears the selection', async () => {
    const onFlagged = vi.fn();
    render(TestWrapper, { component: SetFlagAction, componentProps: { onFlagged } });

    await fireEvent.click(screen.getByRole('button', { name: 'set_flag' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: /pick/ }));

    await waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({
        assetBulkUpdateDto: { ids: [first.id, second.id], flag: AssetFlag.Pick },
      }),
    );
    await waitFor(() => expect(onFlagged).toHaveBeenCalledWith([first.id, second.id], AssetFlag.Pick));
    expect(first.flag).toBe(AssetFlag.Pick);
    expect(second.flag).toBe(AssetFlag.Pick);
    expect(assetMultiSelectManager.selectionActive).toBe(false);
  });

  it('rejects every selected asset', async () => {
    render(TestWrapper, { component: SetFlagAction, componentProps: {} });

    await fireEvent.click(screen.getByRole('button', { name: 'set_flag' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: /reject/ }));

    await waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({
        assetBulkUpdateDto: { ids: [first.id, second.id], flag: AssetFlag.Reject },
      }),
    );
  });

  it('clears the flag by sending null', async () => {
    const onFlagged = vi.fn();
    render(TestWrapper, { component: SetFlagAction, componentProps: { onFlagged } });

    await fireEvent.click(screen.getByRole('button', { name: 'set_flag' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: /clear_flag/ }));

    await waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({ assetBulkUpdateDto: { ids: [first.id, second.id], flag: null } }),
    );
    await waitFor(() => expect(onFlagged).toHaveBeenCalledWith([first.id, second.id], null));
    expect(second.flag).toBeNull();
  });

  it('keeps the local state and selection untouched when the request fails', async () => {
    vi.mocked(updateAssets).mockRejectedValue(new Error('nope'));
    const onFlagged = vi.fn();
    render(TestWrapper, { component: SetFlagAction, componentProps: { onFlagged } });

    await fireEvent.click(screen.getByRole('button', { name: 'set_flag' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: /pick/ }));

    await waitFor(() => expect(updateAssets).toHaveBeenCalled());
    expect(onFlagged).not.toHaveBeenCalled();
    expect(second.flag).toBe(AssetFlag.Reject);
    expect(assetMultiSelectManager.selectionActive).toBe(true);
  });

  it('is hidden on a shared link', () => {
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
    render(TestWrapper, { component: SetFlagAction, componentProps: {} });

    expect(screen.queryByRole('button', { name: 'set_flag' })).toBeNull();
  });
});
