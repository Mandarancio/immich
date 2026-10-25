import { AssetColorLabel, AssetFlag, updateAssets } from '@immich/sdk';
import { fireEvent, render } from '@testing-library/svelte';
import TimelineKeyboardActions from '$lib/components/timeline/actions/TimelineKeyboardActions.svelte';
import { AssetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  updateAssets: vi.fn(),
}));

describe('TimelineKeyboardActions rating and color shortcuts', () => {
  const first = timelineAssetFactory.build({ rating: null, colorLabel: AssetColorLabel.Red });
  const second = timelineAssetFactory.build({ rating: null, colorLabel: AssetColorLabel.Red });
  let selection: AssetMultiSelectManager;

  const renderActions = () =>
    render(TimelineKeyboardActions, {
      timelineManager: new TimelineManager(),
      assetInteraction: selection,
      scrollToAsset: () => false,
    });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(updateAssets).mockReset();
    vi.mocked(updateAssets).mockResolvedValue(undefined as never);
    authManager.setUser(userAdminFactory.build({ id: 'viewer' }));
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: true } }));
    first.rating = null;
    first.colorLabel = AssetColorLabel.Red;
    second.rating = null;
    second.colorLabel = AssetColorLabel.Red;
    selection = new AssetMultiSelectManager();
    selection.selectAssets([first, second]);
  });

  it('rates the selection with 3 and clears the selection', async () => {
    renderActions();
    await fireEvent.keyDown(document.body, { key: '3' });

    await vi.waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({ assetBulkUpdateDto: { ids: [first.id, second.id], rating: 3 } }),
    );
    await vi.waitFor(() => expect(selection.selectionActive).toBe(false));
  });

  it('toggles red off when every selected asset is already red', async () => {
    renderActions();
    await fireEvent.keyDown(document.body, { key: '6' });

    await vi.waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({
        assetBulkUpdateDto: { ids: [first.id, second.id], colorLabel: null },
      }),
    );
  });

  it('picks the selection with k and updates the timeline', async () => {
    const timelineManager = new TimelineManager();
    const update = vi
      .spyOn(timelineManager, 'update')
      .mockReturnValue({ updated: new Set(), notUpdated: new Set(), changedGeometry: false });
    render(TimelineKeyboardActions, {
      timelineManager,
      assetInteraction: selection,
      scrollToAsset: () => false,
    });
    await fireEvent.keyDown(document.body, { key: 'k' });

    await vi.waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({
        assetBulkUpdateDto: { ids: [first.id, second.id], flag: AssetFlag.Pick },
      }),
    );
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith([first.id, second.id], expect.any(Function)));

    const asset = timelineAssetFactory.build({ flag: null });
    update.mock.calls[0][1](asset);
    expect(asset.flag).toBe(AssetFlag.Pick);
    await vi.waitFor(() => expect(selection.selectionActive).toBe(false));
  });

  it('does nothing without a selection', async () => {
    selection.clear();
    renderActions();
    await fireEvent.keyDown(document.body, { key: '3' });

    expect(updateAssets).not.toHaveBeenCalled();
  });

  it('ignores rating keys when ratings are disabled', async () => {
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: false } }));
    renderActions();
    await fireEvent.keyDown(document.body, { key: '3' });

    expect(updateAssets).not.toHaveBeenCalled();
  });

  it('ignores the keys in a shared-link context', async () => {
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
    renderActions();
    await fireEvent.keyDown(document.body, { key: '3' });
    await fireEvent.keyDown(document.body, { key: '6' });
    await fireEvent.keyDown(document.body, { key: 'k' });

    expect(updateAssets).not.toHaveBeenCalled();
  });
});
