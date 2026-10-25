import { AssetColorLabel, updateAssets } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import TestWrapper from '$lib/components/TestWrapper.svelte';
import SetColorLabelAction from '$lib/components/timeline/actions/SetColorLabelAction.svelte';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  updateAssets: vi.fn(),
}));

describe('SetColorLabelAction', () => {
  const first = timelineAssetFactory.build({ ownerId: 'viewer', colorLabel: null });
  const second = timelineAssetFactory.build({ ownerId: 'someone-else', colorLabel: AssetColorLabel.Red });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(updateAssets).mockReset();
    vi.mocked(updateAssets).mockResolvedValue(undefined as never);
    authManager.setUser(userAdminFactory.build({ id: 'viewer' }));
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: false } }));
    first.colorLabel = null;
    second.colorLabel = AssetColorLabel.Red;
    assetMultiSelectManager.clear();
    assetMultiSelectManager.selectAssets([first, second]);
  });

  afterEach(() => {
    assetMultiSelectManager.clear();
  });

  it('labels every selected asset and reports the update', async () => {
    const onLabeled = vi.fn();
    render(TestWrapper, { component: SetColorLabelAction, componentProps: { onLabeled } });

    await fireEvent.click(screen.getByRole('button', { name: 'set_color_label' }));
    await fireEvent.click(screen.getByRole('button', { name: 'color_label_blue' }));

    await waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({
        assetBulkUpdateDto: { ids: [first.id, second.id], colorLabel: AssetColorLabel.Blue },
      }),
    );
    await waitFor(() => expect(onLabeled).toHaveBeenCalledWith([first.id, second.id], AssetColorLabel.Blue));
    expect(first.colorLabel).toBe(AssetColorLabel.Blue);
    expect(second.colorLabel).toBe(AssetColorLabel.Blue);
    expect(assetMultiSelectManager.selectionActive).toBe(false);
  });

  it('clears the label by sending null', async () => {
    const onLabeled = vi.fn();
    render(TestWrapper, { component: SetColorLabelAction, componentProps: { onLabeled } });

    await fireEvent.click(screen.getByRole('button', { name: 'set_color_label' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: /clear_color_label/ }));

    await waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({
        assetBulkUpdateDto: { ids: [first.id, second.id], colorLabel: null },
      }),
    );
    await waitFor(() => expect(onLabeled).toHaveBeenCalledWith([first.id, second.id], null));
    expect(second.colorLabel).toBeNull();
  });

  it('keeps the local state untouched when the request fails', async () => {
    vi.mocked(updateAssets).mockRejectedValue(new Error('nope'));
    const onLabeled = vi.fn();
    render(TestWrapper, { component: SetColorLabelAction, componentProps: { onLabeled } });

    await fireEvent.click(screen.getByRole('button', { name: 'set_color_label' }));
    await fireEvent.click(screen.getByRole('button', { name: 'color_label_green' }));

    await waitFor(() => expect(updateAssets).toHaveBeenCalled());
    expect(onLabeled).not.toHaveBeenCalled();
    expect(second.colorLabel).toBe(AssetColorLabel.Red);
  });

  it('is hidden on a shared link', () => {
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
    render(TestWrapper, { component: SetColorLabelAction, componentProps: {} });

    expect(screen.queryByRole('button', { name: 'set_color_label' })).toBeNull();
  });
});
