import { AssetColorLabel, getAssetInfo, updateAsset, type UserConfigDto } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { vitest } from 'vitest';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { queryClient } from '$lib/queries/client';
import { getUserConfigQuery } from '$lib/queries/config-user.query';
import { getAssetActions, handleDownloadAsset, handleRate, handleSetColorLabel } from '$lib/services/asset.service';
import { setSharedLink } from '$lib/utils';
import { getFormatter } from '$lib/utils/i18n';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { sharedLinkFactory } from '@test-data/factories/shared-link-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vitest.mock('@immich/ui', () => ({
  toastManager: {
    primary: vitest.fn(),
    info: vitest.fn(),
  },
}));

vitest.mock('$lib/utils/i18n', () => ({
  getFormatter: vitest.fn(),
  getPreferredLocale: vitest.fn(),
}));

vitest.mock('@immich/sdk');

vitest.mock('$lib/utils', async () => {
  const originalModule = await vitest.importActual('$lib/utils');
  return {
    ...originalModule,
    sleep: vitest.fn(),
  };
});

describe('AssetService', () => {
  describe('getAssetActions', () => {
    beforeEach(() => {
      setSharedLink(undefined);
      authManager.setPreferences(preferencesFactory.build());
      queryClient.setQueryData(getUserConfigQuery().queryKey, {
        machineLearning: {
          enabled: false,
          clip: { enabled: false },
          duplicateDetection: { enabled: false },
          facialRecognition: { enabled: false },
          ocr: { enabled: false },
        },
      } as UserConfigDto);
    });

    it('should allow shared link downloads if the user owns the asset and shared link downloads are disabled', () => {
      const ownerId = 'owner';
      const user = userAdminFactory.build({ id: ownerId });
      const asset = assetFactory.build({ ownerId });
      authManager.setUser(user);
      setSharedLink(sharedLinkFactory.build({ allowDownload: false }));
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.SharedLinkDownload.$if?.()).toStrictEqual(true);
    });

    it('should offer favorite to a logged-in user who does not own the asset', () => {
      const user = userAdminFactory.build({ id: 'viewer' });
      const asset = assetFactory.build({ ownerId: 'someone-else', isFavorite: false });
      authManager.setUser(user);
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.Favorite.$if?.()).toStrictEqual(true);
      expect(assetActions.Unfavorite.$if?.()).toStrictEqual(false);
    });

    it('should offer unfavorite for a favorited asset the user does not own', () => {
      const user = userAdminFactory.build({ id: 'viewer' });
      const asset = assetFactory.build({ ownerId: 'someone-else', isFavorite: true });
      authManager.setUser(user);
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.Favorite.$if?.()).toStrictEqual(false);
      expect(assetActions.Unfavorite.$if?.()).toStrictEqual(true);
    });

    it('should not offer favorite on a shared link for a non-owner', () => {
      const user = userAdminFactory.build({ id: 'viewer' });
      const asset = assetFactory.build({ ownerId: 'someone-else', isFavorite: false });
      authManager.setUser(user);
      setSharedLink(sharedLinkFactory.build());
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.Favorite.$if?.()).toStrictEqual(false);
    });

    describe('Rate', () => {
      beforeEach(() => {
        authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: true } }));
      });

      it('should offer rating to the owner', () => {
        authManager.setUser(userAdminFactory.build({ id: 'owner' }));
        const asset = assetFactory.build({ ownerId: 'owner' });
        expect(getAssetActions(() => '', asset).Rate.$if?.()).toStrictEqual(true);
      });

      it('should offer rating to a logged-in user who does not own the asset', () => {
        authManager.setUser(userAdminFactory.build({ id: 'viewer' }));
        const asset = assetFactory.build({ ownerId: 'someone-else' });
        expect(getAssetActions(() => '', asset).Rate.$if?.()).toStrictEqual(true);
      });

      it('should not offer rating on a shared link', () => {
        authManager.setUser(userAdminFactory.build({ id: 'viewer' }));
        setSharedLink(sharedLinkFactory.build());
        const asset = assetFactory.build({ ownerId: 'someone-else' });
        expect(getAssetActions(() => '', asset).Rate.$if?.()).toStrictEqual(false);
      });

      it('should not offer rating on a shared link route even to the logged-in owner', () => {
        authManager.setUser(userAdminFactory.build({ id: 'owner' }));
        const asset = assetFactory.build({ ownerId: 'owner' });
        const spy = vitest.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
        try {
          expect(getAssetActions(() => '', asset).Rate.$if?.()).toStrictEqual(false);
        } finally {
          spy.mockRestore();
        }
      });

      it('should not offer rating when ratings are disabled', () => {
        authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: false } }));
        authManager.setUser(userAdminFactory.build({ id: 'viewer' }));
        const asset = assetFactory.build({ ownerId: 'someone-else' });
        expect(getAssetActions(() => '', asset).Rate.$if?.()).toStrictEqual(false);
      });
    });

    describe('SetColorLabel', () => {
      beforeEach(() => {
        vitest.mocked(getFormatter).mockResolvedValue(vitest.fn().mockReturnValue('formatter'));
        vitest.mocked(updateAsset).mockReset();
        authManager.setUser(userAdminFactory.build({ id: 'viewer' }));
      });

      const press = (key: string) => ({ event: new KeyboardEvent('keydown', { key }) }) as never;

      it('should bind 6 to 9 and be offered to a logged-in user', () => {
        const asset = assetFactory.build({ ownerId: 'someone-else' });
        const { SetColorLabel } = getAssetActions(() => '', asset);
        expect(SetColorLabel.$if?.()).toStrictEqual(true);
        expect([SetColorLabel.shortcuts].flat().map((shortcut) => shortcut?.key)).toEqual(['6', '7', '8', '9']);
      });

      it('should set the color of the pressed key', async () => {
        const asset = assetFactory.build({ colorLabel: null });
        vitest.mocked(updateAsset).mockResolvedValue(asset);
        await getAssetActions(() => '', asset).SetColorLabel.onAction(press('7'));
        expect(updateAsset).toHaveBeenCalledWith({
          id: asset.id,
          updateAssetDto: { colorLabel: AssetColorLabel.Yellow },
        });
      });

      it('should clear the color when the asset already has it', async () => {
        const asset = assetFactory.build({ colorLabel: AssetColorLabel.Red });
        vitest.mocked(updateAsset).mockResolvedValue(asset);
        await getAssetActions(() => '', asset).SetColorLabel.onAction(press('6'));
        expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { colorLabel: null } });
      });

      it('should not be offered on a shared link', () => {
        setSharedLink(sharedLinkFactory.build());
        const asset = assetFactory.build({ ownerId: 'someone-else' });
        expect(getAssetActions(() => '', asset).SetColorLabel.$if?.()).toStrictEqual(false);
      });
    });

    it('should not allow shared link downloads if the user does not own the asset and shared link downloads are disabled', () => {
      const ownerId = 'owner';
      const user = userAdminFactory.build({ id: 'non-owner' });
      const asset = assetFactory.build({ ownerId });
      authManager.setUser(user);
      setSharedLink(sharedLinkFactory.build({ allowDownload: false }));
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.SharedLinkDownload.$if?.()).toStrictEqual(false);
    });

    it('should allow shared link downloads if shared link downloads are enabled regardless of user', () => {
      const asset = assetFactory.build();
      setSharedLink(sharedLinkFactory.build({ allowDownload: true }));
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.SharedLinkDownload.$if?.()).toStrictEqual(true);
    });
  });

  describe('handleDownloadAsset', () => {
    it('should use the asset originalFileName when showing toasts', async () => {
      const $t = vitest.fn().mockReturnValue('formatter');
      vitest.mocked(getFormatter).mockResolvedValue($t);
      const asset = assetFactory.build({ originalFileName: 'asset.heic' });
      await handleDownloadAsset(asset, { edited: false });
      expect($t).toHaveBeenNthCalledWith(1, 'downloading_asset_filename', { values: { filename: 'asset.heic' } });
      expect(toastManager.primary).toHaveBeenCalledWith('formatter');
    });

    it('should use the motion asset originalFileName when showing toasts', async () => {
      const $t = vitest.fn().mockReturnValue('formatter');
      vitest.mocked(getFormatter).mockResolvedValue($t);
      const motionAsset = assetFactory.build({ originalFileName: 'asset.mov' });
      vitest.mocked(getAssetInfo).mockResolvedValue(motionAsset);
      const asset = assetFactory.build({ originalFileName: 'asset.heic', livePhotoVideoId: '1' });
      await handleDownloadAsset(asset, { edited: false });
      expect($t).toHaveBeenNthCalledWith(1, 'downloading_asset_filename', { values: { filename: 'asset.heic' } });
      expect($t).toHaveBeenNthCalledWith(2, 'downloading_asset_filename', { values: { filename: 'asset-motion.mov' } });
      expect(toastManager.primary).toHaveBeenCalledWith('formatter');
    });
  });

  describe('handleRate', () => {
    beforeEach(() => {
      vitest.mocked(getFormatter).mockResolvedValue(vitest.fn().mockReturnValue('formatter'));
      vitest.mocked(updateAsset).mockReset();
    });

    it('should send the rating and emit the update', async () => {
      const asset = assetFactory.build({ exifInfo: { rating: null } });
      const updated = assetFactory.build({ id: asset.id, exifInfo: { rating: 3 } });
      vitest.mocked(updateAsset).mockResolvedValue(updated);
      const emit = vitest.spyOn(eventManager, 'emit');

      await handleRate(asset, 3);

      expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { rating: 3 } });
      expect(emit).toHaveBeenCalledWith('AssetUpdate', updated);
    });

    it('should clear the rating with 0', async () => {
      const asset = assetFactory.build({ exifInfo: { rating: 2 } });
      vitest.mocked(updateAsset).mockResolvedValue(asset);

      await handleRate(asset, 0);

      expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { rating: null } });
    });

    it('should never send -1 from the UI', async () => {
      const asset = assetFactory.build({ exifInfo: { rating: null } });

      await handleRate(asset, -1);

      expect(updateAsset).not.toHaveBeenCalled();
    });

    it('should never write on a shared link, even for a logged-in owner', async () => {
      authManager.setUser(userAdminFactory.build({ id: 'owner' }));
      const asset = assetFactory.build({ ownerId: 'owner', exifInfo: { rating: null } });
      const spy = vitest.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
      try {
        await handleRate(asset, 3);
      } finally {
        spy.mockRestore();
      }

      expect(updateAsset).not.toHaveBeenCalled();
    });
  });

  describe('handleSetColorLabel', () => {
    beforeEach(() => {
      vitest.mocked(getFormatter).mockResolvedValue(vitest.fn().mockReturnValue('formatter'));
      vitest.mocked(updateAsset).mockReset();
    });

    it('should send the color label and emit the update with the response', async () => {
      const asset = assetFactory.build();
      const updated = { ...asset, colorLabel: AssetColorLabel.Green };
      vitest.mocked(updateAsset).mockResolvedValue(updated);
      const emit = vitest.spyOn(eventManager, 'emit');

      await handleSetColorLabel(asset, AssetColorLabel.Green);

      expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { colorLabel: AssetColorLabel.Green } });
      expect(emit).toHaveBeenCalledWith('AssetUpdate', updated);
    });

    it('should clear the color label with null', async () => {
      const asset = assetFactory.build();
      vitest.mocked(updateAsset).mockResolvedValue(asset);

      await handleSetColorLabel(asset, null);

      expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { colorLabel: null } });
    });

    it('should never write on a shared link, even for a logged-in owner', async () => {
      authManager.setUser(userAdminFactory.build({ id: 'owner' }));
      const asset = assetFactory.build({ ownerId: 'owner' });
      const spy = vitest.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
      try {
        await handleSetColorLabel(asset, AssetColorLabel.Green);
      } finally {
        spy.mockRestore();
      }

      expect(updateAsset).not.toHaveBeenCalled();
    });

    it('should not emit when the update fails', async () => {
      const asset = assetFactory.build();
      vitest.mocked(updateAsset).mockRejectedValue(new Error('nope'));
      const emit = vitest.spyOn(eventManager, 'emit');
      emit.mockClear();

      await handleSetColorLabel(asset, AssetColorLabel.Red);

      expect(emit).not.toHaveBeenCalledWith('AssetUpdate', expect.anything());
    });
  });
});
