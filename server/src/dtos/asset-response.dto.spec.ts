import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AssetColorLabel } from 'src/enum.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { getForAsset } from 'test/mappers.js';

const build = (ownerId?: string) => {
  const factory = ownerId ? AssetFactory.from().owner({ id: ownerId }) : AssetFactory.from();
  return getForAsset(factory.exif({ rating: 2 }).build());
};

describe('mapAsset viewer state', () => {
  it('should use the viewer state for a non-owner', () => {
    const auth = AuthFactory.create();
    const asset = build();
    const viewerState = new Map([
      [asset.id, { isFavorite: true, rating: 4, colorLabel: AssetColorLabel.Red, flag: null }],
    ]);

    const dto = mapAsset(asset, { auth, viewerState });

    expect(dto.isFavorite).toBe(true);
    expect(dto.exifInfo?.rating).toBe(4);
    expect(dto.colorLabel).toBe(AssetColorLabel.Red);
  });

  it('should fall back to the exif rating when the viewer has no rating', () => {
    const auth = AuthFactory.create();
    const asset = build();
    const viewerState = new Map([[asset.id, { isFavorite: false, rating: null, colorLabel: null, flag: null }]]);

    const dto = mapAsset(asset, { auth, viewerState });

    expect(dto.exifInfo?.rating).toBe(2);
    expect(dto.colorLabel).toBeNull();
  });

  it('should keep the exif rating and column favorite for the owner, with the color from the state', () => {
    const auth = AuthFactory.create();
    const asset = build(auth.user.id);
    const viewerState = new Map([
      [asset.id, { isFavorite: true, rating: 5, colorLabel: AssetColorLabel.Blue, flag: null }],
    ]);

    const dto = mapAsset({ ...asset, isFavorite: false }, { auth, viewerState });

    expect(dto.isFavorite).toBe(false);
    expect(dto.exifInfo?.rating).toBe(2);
    expect(dto.colorLabel).toBe(AssetColorLabel.Blue);
  });

  it('should have no color label and the exif rating without viewer state', () => {
    const auth = AuthFactory.create();
    const asset = build();

    const dto = mapAsset(asset, { auth });

    expect(dto.isFavorite).toBe(false);
    expect(dto.exifInfo?.rating).toBe(2);
    expect(dto.colorLabel).toBeNull();
  });

  it('should have no color label and the exif rating without auth', () => {
    const dto = mapAsset(build());

    expect(dto.exifInfo?.rating).toBe(2);
    expect(dto.colorLabel).toBeNull();
  });
});
