import { updateAsset } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import DetailPanelStarRating from '$lib/components/asset-viewer/DetailPanelStarRating.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  updateAsset: vi.fn(),
}));

describe('DetailPanelStarRating', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(updateAsset).mockReset();
    authManager.setUser(userAdminFactory.build({ id: 'viewer' }));
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: true } }));
  });

  it('is editable for a non-owner', async () => {
    const asset = assetFactory.build({ ownerId: 'someone-else', isFavorite: false, exifInfo: { rating: null } });
    // distinct from the rendered prop so the test proves the server response (not the stale prop) is emitted
    const response = assetFactory.build({
      id: asset.id,
      ownerId: 'someone-else',
      isFavorite: true,
      exifInfo: { rating: 3 },
    });
    vi.mocked(updateAsset).mockResolvedValue(response);
    const emit = vi.spyOn(eventManager, 'emit');
    render(DetailPanelStarRating, { asset });

    const inputs = screen.getAllByRole('radio');
    expect(inputs).toHaveLength(5);
    for (const input of inputs) {
      expect((input as HTMLInputElement).disabled).toBe(false);
    }

    await fireEvent.click(inputs[2]);

    await waitFor(() => expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { rating: 3 } }));
    await waitFor(() => expect(emit).toHaveBeenCalledWith('AssetUpdate', response));
    expect(emit).not.toHaveBeenCalledWith('AssetUpdate', asset);
  });

  it('clears the rating by sending null', async () => {
    const asset = assetFactory.build({ ownerId: 'someone-else', exifInfo: { rating: 4 } });
    vi.mocked(updateAsset).mockResolvedValue(asset);
    render(DetailPanelStarRating, { asset });

    await fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { rating: null } }));
  });

  it('is editable for the owner', () => {
    const asset = assetFactory.build({ ownerId: 'viewer', exifInfo: { rating: 2 } });
    render(DetailPanelStarRating, { asset });

    for (const input of screen.getAllByRole('radio')) {
      expect((input as HTMLInputElement).disabled).toBe(false);
    }
  });

  it('is hidden on a shared link', () => {
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
    const asset = assetFactory.build({ ownerId: 'someone-else', exifInfo: { rating: 4 } });
    render(DetailPanelStarRating, { asset });

    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('is hidden when ratings are disabled', () => {
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: false } }));
    const asset = assetFactory.build({ ownerId: 'viewer' });
    render(DetailPanelStarRating, { asset });

    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });
});
