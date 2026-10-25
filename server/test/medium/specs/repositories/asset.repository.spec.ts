import { Kysely } from 'kysely';
import { AssetColorLabel, AssetFileType, AssetOrder, AssetOrderBy, AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { down, up } from 'src/schema/migrations/1793000000000-AddAssetFavoriteTable.js';
import { down as downUserState, up as upUserState } from 'src/schema/migrations/1793000000001-AddAssetUserState.js';
import { BaseService } from 'src/services/base.service.js';
import { colorLabelsPredicate, ratingFor } from 'src/utils/database.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AssetRepository) };
};

const stateOf = async (sut: AssetRepository, userId: string, assetId: string) => {
  const states = await sut.getUserStates(userId, [assetId]);
  return states.get(assetId);
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

// Metadata extraction is repeatable: probing improves, files get repaired,
// and a re-run has to be able to correct what an earlier run stored.
const audioRow = (assetId: string, n: number) => ({
  assetId,
  bitrate: 100_000 + n,
  index: n,
  profile: n,
  codecName: `codec-${n}`,
});

const videoRow = (assetId: string, n: number) => ({
  assetId,
  bitrate: 200_000 + n,
  frameCount: 300 + n,
  timeBase: 600 + n,
  index: n,
  profile: n,
  level: n,
  colorPrimaries: n,
  colorTransfer: n,
  colorMatrix: n,
  dvProfile: n,
  dvLevel: n,
  dvBlSignalCompatibilityId: n,
  codecName: `vcodec-${n}`,
  formatName: `format-${n}`,
  formatLongName: `format long ${n}`,
  pixelFormat: `pixfmt-${n}`,
});

const keyframeRow = (assetId: string, n: number) => ({
  assetId,
  pts: [n],
  accDuration: [n],
  ownDuration: [n],
  totalDuration: 1000 + n,
  packetCount: 10 + n,
  outputFrames: 20 + n,
});

describe(AssetRepository.name, () => {
  describe('deleteFile', () => {
    it('should delete only the requested asset and file type', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: other } = await ctx.newAsset({ ownerId: user.id });
      await sut.upsertFiles([
        { assetId: asset.id, type: AssetFileType.Sidecar, path: '/photos/photo.jpg.xmp' },
        { assetId: asset.id, type: AssetFileType.Thumbnail, path: '/photos/thumbnail.jpg' },
        { assetId: other.id, type: AssetFileType.Sidecar, path: '/photos/other.jpg.xmp' },
      ]);

      await sut.deleteFile({ assetId: asset.id, type: AssetFileType.Sidecar });

      await expect(
        ctx.database
          .selectFrom('asset_file')
          .where('assetId', 'in', [asset.id, other.id])
          .select('path')
          .orderBy('path')
          .execute(),
      ).resolves.toEqual([{ path: '/photos/other.jpg.xmp' }, { path: '/photos/thumbnail.jpg' }]);
    });
  });

  describe('getTimeBucket', () => {
    it('should order assets by local day first and fileCreatedAt within each day', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      const [{ asset: previousLocalDayAsset }, { asset: nextLocalDayEarlierAsset }, { asset: nextLocalDayLaterAsset }] =
        await Promise.all([
          ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
            localDateTime: new Date('2026-03-08T22:30:00.000Z'),
          }),
          ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('2026-03-08T23:30:00.000Z'),
            localDateTime: new Date('2026-03-09T01:30:00.000Z'),
          }),
          ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('2026-03-08T23:45:00.000Z'),
            localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          }),
        ]);

      await Promise.all([
        ctx.newExif({ assetId: previousLocalDayAsset.id, timeZone: 'UTC-2' }),
        ctx.newExif({ assetId: nextLocalDayEarlierAsset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: nextLocalDayLaterAsset.id, timeZone: 'UTC+2' }),
      ]);

      const descendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        { order: AssetOrder.Desc, userIds: [user.id], visibility: AssetVisibility.Timeline },
        auth,
      );
      expect(JSON.parse(descendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [nextLocalDayLaterAsset.id, nextLocalDayEarlierAsset.id, previousLocalDayAsset.id],
        }),
      );

      const ascendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        { order: AssetOrder.Asc, userIds: [user.id], visibility: AssetVisibility.Timeline },
        auth,
      );
      expect(JSON.parse(ascendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [previousLocalDayAsset.id, nextLocalDayEarlierAsset.id, nextLocalDayLaterAsset.id],
        }),
      );
    });

    it('should order assets by originalFileName when fileCreatedAt is the same (takenAt)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      // create all the fake photos
      const [
        { asset: time1DSC0001Asset },
        { asset: time1DSC0002Asset },
        { asset: time2DSC0003Asset },
        { asset: time2DSC0004Asset },
      ] = await Promise.all([
        // both at 12:30AM
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
          localDateTime: new Date('2026-03-09T00:30:00.000Z'),
          originalFileName: 'DSC0001.jpg',
        }),
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
          localDateTime: new Date('2026-03-09T00:30:00.000Z'),
          originalFileName: 'DSC0002.jpg',
        }),
        // both at 1:45AM
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T01:45:00.000Z'),
          localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          originalFileName: 'DSC0003.jpg',
        }),
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T01:45:00.000Z'),
          localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          originalFileName: 'DSC0004.jpg',
        }),
      ]);

      // even though im not gonna do anything with these it's required!
      await Promise.all([
        ctx.newExif({ assetId: time1DSC0001Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time1DSC0002Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time2DSC0003Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time2DSC0004Asset.id, timeZone: 'UTC+2' }),
      ]);

      // check the values given by the bucket when descending
      const descendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        {
          order: AssetOrder.Desc,
          userIds: [user.id],
          visibility: AssetVisibility.Timeline,
          orderBy: AssetOrderBy.TakenAt,
        },
        auth,
      );
      // make sure they're ordered correctly
      expect(JSON.parse(descendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [time2DSC0004Asset.id, time2DSC0003Asset.id, time1DSC0002Asset.id, time1DSC0001Asset.id],
        }),
      );

      // now do the same when ascending
      const ascendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        {
          order: AssetOrder.Asc,
          userIds: [user.id],
          visibility: AssetVisibility.Timeline,
          orderBy: AssetOrderBy.TakenAt,
        },
        auth,
      );
      expect(JSON.parse(ascendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [time1DSC0001Asset.id, time1DSC0002Asset.id, time2DSC0003Asset.id, time2DSC0004Asset.id],
        }),
      );
    });

    it('should order assets by originalFileName when fileCreatedAt is the same (createdAt)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      // create all the fake photos
      const [
        { asset: time1DSC0001Asset },
        { asset: time1DSC0002Asset },
        { asset: time2DSC0003Asset },
        { asset: time2DSC0004Asset },
      ] = await Promise.all([
        // createdAt = uploadedAt, fileCreatedAt = file metadata
        // both at 12:30AM
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
          localDateTime: new Date('2026-03-09T00:30:00.000Z'),
          createdAt: new Date('2026-03-09T00:30:00.000Z'),
          originalFileName: 'DSC0001.jpg',
        }),
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
          localDateTime: new Date('2026-03-09T00:30:00.000Z'),
          createdAt: new Date('2026-03-09T00:30:00.000Z'),
          originalFileName: 'DSC0002.jpg',
        }),
        // both at 1:45AM
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T01:45:00.000Z'),
          localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          createdAt: new Date('2026-03-09T01:45:00.000Z'),
          originalFileName: 'DSC0003.jpg',
        }),
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T01:45:00.000Z'),
          localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          createdAt: new Date('2026-03-09T01:45:00.000Z'),
          originalFileName: 'DSC0004.jpg',
        }),
      ]);

      // even though im not gonna do anything with these it's required!
      await Promise.all([
        ctx.newExif({ assetId: time1DSC0001Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time1DSC0002Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time2DSC0003Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time2DSC0004Asset.id, timeZone: 'UTC+2' }),
      ]);

      // check the values given by the bucket when descending
      const descendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        {
          order: AssetOrder.Desc,
          userIds: [user.id],
          visibility: AssetVisibility.Timeline,
          orderBy: AssetOrderBy.CreatedAt,
        },
        auth,
      );
      // make sure they're ordered correctly
      expect(JSON.parse(descendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [time2DSC0004Asset.id, time2DSC0003Asset.id, time1DSC0002Asset.id, time1DSC0001Asset.id],
        }),
      );

      // now do the same when ascending
      const ascendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        {
          order: AssetOrder.Asc,
          userIds: [user.id],
          visibility: AssetVisibility.Timeline,
          orderBy: AssetOrderBy.CreatedAt,
        },
        auth,
      );
      expect(JSON.parse(ascendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [time1DSC0001Asset.id, time1DSC0002Asset.id, time2DSC0003Asset.id, time2DSC0004Asset.id],
        }),
      );
    });
  });

  describe('upsertExif', () => {
    it('should replace stored audio metadata on a second extraction', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'first' },
        audio: audioRow(asset.id, 2),
        lockedPropertiesBehavior: 'skip',
      });
      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'second' },
        audio: audioRow(asset.id, 1),
        lockedPropertiesBehavior: 'skip',
      });

      await expect(
        ctx.database.selectFrom('asset_audio').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual(audioRow(asset.id, 1));
    });

    it('should replace stored video metadata on a second extraction', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'first' },
        video: videoRow(asset.id, 2),
        lockedPropertiesBehavior: 'skip',
      });
      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'second' },
        video: videoRow(asset.id, 1),
        lockedPropertiesBehavior: 'skip',
      });

      await expect(
        ctx.database.selectFrom('asset_video').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual(videoRow(asset.id, 1));
    });

    it('should replace stored keyframe metadata on a second extraction', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'first' },
        keyframes: keyframeRow(asset.id, 2),
        lockedPropertiesBehavior: 'skip',
      });
      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'second' },
        keyframes: keyframeRow(asset.id, 1),
        lockedPropertiesBehavior: 'skip',
      });

      await expect(
        ctx.database.selectFrom('asset_keyframe').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual(keyframeRow(asset.id, 1));
    });

    // A probe that could not read a stream sends no object at all, and that must
    // not be read as "delete what is already known".
    it('should leave stored media metadata alone when an extraction omits it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'first' },
        audio: audioRow(asset.id, 2),
        lockedPropertiesBehavior: 'skip',
      });
      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'second' },
        lockedPropertiesBehavior: 'skip',
      });

      await expect(
        ctx.database.selectFrom('asset_audio').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual(audioRow(asset.id, 2));
    });
    it('should append to locked columns', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal'] });

      await sut.upsertExif({
        exif: { assetId: asset.id, lockedProperties: ['description'] },
        lockedPropertiesBehavior: 'append',
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['description', 'dateTimeOriginal'] });
    });

    it('should deduplicate locked columns', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal', 'description'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal', 'description'] });

      await sut.upsertExif({
        exif: { assetId: asset.id, lockedProperties: ['description'] },
        lockedPropertiesBehavior: 'append',
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['description', 'dateTimeOriginal'] });
    });
  });

  describe('unlockProperties', () => {
    it('should unlock one property', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal', 'description'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal', 'description'] });

      await sut.unlockProperties(asset.id, ['dateTimeOriginal']);

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['description'] });
    });

    it('should unlock all properties', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal', 'description'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal', 'description'] });

      await sut.unlockProperties(asset.id, ['description', 'dateTimeOriginal']);

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: null });
    });
  });

  describe('favorites', () => {
    it('should add, read and remove favorites per user', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: owner.id });

      await sut.setUserState(viewer.id, [asset.id], { isFavorite: true });
      await sut.setUserState(viewer.id, [asset.id], { isFavorite: true }); // idempotent

      const isFavorite = async (userId: string, ids: string[]) =>
        new Set([...(await sut.getUserStates(userId, ids))].filter(([, state]) => state.isFavorite).map(([id]) => id));
      await expect(isFavorite(viewer.id, [asset.id])).resolves.toEqual(new Set([asset.id]));
      await expect(isFavorite(other.id, [asset.id])).resolves.toEqual(new Set());
      await expect(isFavorite(viewer.id, [])).resolves.toEqual(new Set());

      await sut.setUserState(viewer.id, [asset.id], { isFavorite: false });
      await expect(isFavorite(viewer.id, [asset.id])).resolves.toEqual(new Set());
      await expect(sut.getUserStates(viewer.id, [asset.id])).resolves.toEqual(new Map());
    });
  });

  describe('user state', () => {
    it('setUserState upserts only the provided fields and deletes empty rows', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: owner } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: owner.id });

      await sut.setUserState(user.id, [asset.id], { rating: 4 });
      await sut.setUserState(user.id, [asset.id], { colorLabel: AssetColorLabel.Red });
      expect(await stateOf(sut, user.id, asset.id)).toEqual({
        isFavorite: false,
        rating: 4,
        colorLabel: 'red',
      });

      await sut.setUserState(user.id, [asset.id], { isFavorite: true });
      expect(await stateOf(sut, user.id, asset.id)).toEqual({
        isFavorite: true,
        rating: 4,
        colorLabel: 'red',
      });

      await sut.setUserState(user.id, [asset.id], { rating: null, colorLabel: null });
      expect(await stateOf(sut, user.id, asset.id)).toEqual({
        isFavorite: true,
        rating: null,
        colorLabel: null,
      });

      await sut.setUserState(user.id, [asset.id], { isFavorite: false });
      expect(await sut.getUserStates(user.id, [asset.id])).toEqual(new Map());
    });

    it('setUserState ignores an empty change and rejects an out of range rating', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.setUserState(user.id, [asset.id], {});
      await sut.setUserState(user.id, [asset.id], { rating: undefined });
      expect(await sut.getUserStates(user.id, [asset.id])).toEqual(new Map());

      await expect(sut.setUserState(user.id, [asset.id], { rating: 6 })).rejects.toThrow();
    });
  });

  describe('viewer-aware query helpers', () => {
    it('should resolve the effective rating per viewer', async () => {
      const { ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      const { asset: shared } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: noExif } = await ctx.newAsset({ ownerId: owner.id });
      await ctx.newExif({ assetId: shared.id, rating: 2 });
      await ctx.get(AssetRepository).setUserState(viewer.id, [shared.id], { rating: 5 });
      // an owner's own table rating never overrides the exif rating
      await ctx.get(AssetRepository).setUserState(owner.id, [shared.id], { rating: 4 });

      const rating = async (userId: string, id: string) => {
        const row = await ctx.database
          .selectFrom('asset')
          .select(ratingFor(userId).as('rating'))
          .where('asset.id', '=', id)
          .executeTakeFirstOrThrow();
        return row.rating;
      };

      await expect(rating(owner.id, shared.id)).resolves.toBe(2);
      await expect(rating(viewer.id, shared.id)).resolves.toBe(5);
      await expect(rating(owner.id, noExif.id)).resolves.toBeNull();

      await ctx.get(AssetRepository).setUserState(viewer.id, [shared.id], { rating: null });
      await expect(rating(viewer.id, shared.id)).resolves.toBe(2);
    });

    it('should resolve the color label and filter by it', async () => {
      const { ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      const { asset: red } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: blue } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: plain } = await ctx.newAsset({ ownerId: owner.id });
      await ctx.get(AssetRepository).setUserState(viewer.id, [red.id], { colorLabel: AssetColorLabel.Red });
      await ctx.get(AssetRepository).setUserState(viewer.id, [blue.id], { colorLabel: AssetColorLabel.Blue });
      await ctx.get(AssetRepository).setUserState(owner.id, [plain.id], { colorLabel: AssetColorLabel.Red });

      const ids = async (userId: string, labels: Array<AssetColorLabel | 'none'>) => {
        const rows = await ctx.database
          .selectFrom('asset')
          .select('asset.id')
          .where('asset.ownerId', '=', owner.id)
          .where(colorLabelsPredicate(userId, labels))
          .execute();
        return rows.map(({ id }) => id).toSorted();
      };

      await expect(ids(viewer.id, [AssetColorLabel.Red])).resolves.toEqual([red.id]);
      await expect(ids(viewer.id, [AssetColorLabel.Red, AssetColorLabel.Blue])).resolves.toEqual(
        [red.id, blue.id].toSorted(),
      );
      await expect(ids(viewer.id, ['none'])).resolves.toEqual([plain.id]);
      await expect(ids(viewer.id, ['none', AssetColorLabel.Blue])).resolves.toEqual([blue.id, plain.id].toSorted());
      await expect(ids(owner.id, [AssetColorLabel.Red])).resolves.toEqual([plain.id]);
    });
  });

  describe('asset_user_state migration', () => {
    it('should turn legacy favorite rows into favorite states and round trip', async () => {
      const db = await getKyselyDB();
      const { ctx } = setup(db);
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: other } = await ctx.newAsset({ ownerId: user.id });

      await downUserState(db);
      await db
        .insertInto('asset_favorite' as never)
        .values({ userId: user.id, assetId: asset.id } as never)
        .execute();

      const read = () =>
        db
          .selectFrom('asset_user_state')
          .select(['assetId', 'isFavorite', 'rating', 'colorLabel'])
          .orderBy('assetId')
          .execute();

      await upUserState(db);
      await expect(read()).resolves.toEqual([{ assetId: asset.id, isFavorite: true, rating: null, colorLabel: null }]);

      // rows that are not favorites are dropped when reverting, favorites survive the round trip
      await db.insertInto('asset_user_state').values({ userId: user.id, assetId: other.id, rating: 3 }).execute();
      await downUserState(db);
      await upUserState(db);
      await expect(read()).resolves.toEqual([{ assetId: asset.id, isFavorite: true, rating: null, colorLabel: null }]);
    });
  });

  describe('asset_favorite migration', () => {
    it('should backfill owner rows for every legacy favorite and nothing else', async () => {
      // a dedicated database, as the table is dropped to replay the migration over pre-existing assets
      const db = await getKyselyDB();
      const { ctx } = setup(db);
      const { user: userA } = await ctx.newUser();
      const { user: userB } = await ctx.newUser();
      const { asset: favorite } = await ctx.newAsset({ ownerId: userA.id, isFavorite: true });
      await ctx.newAsset({ ownerId: userA.id, isFavorite: false });
      const { asset: trashed } = await ctx.newAsset({ ownerId: userB.id, isFavorite: true, deletedAt: new Date() });
      const { asset: archived } = await ctx.newAsset({
        ownerId: userB.id,
        isFavorite: true,
        visibility: AssetVisibility.Archive,
      });
      await ctx.newAsset({ ownerId: userB.id, deletedAt: new Date() });

      // revert to the asset_favorite shape first, then replay the original migration over the pre-existing assets
      await downUserState(db);
      await down(db);
      const read = () =>
        db
          .selectFrom('asset_favorite' as never)
          .select(['userId', 'assetId'] as never)
          .execute()
          .then((rows) =>
            (rows as unknown as Array<{ userId: string; assetId: string }>)
              .map(({ userId, assetId }) => `${userId}:${assetId}`)
              .toSorted(),
          );

      const expected = [
        `${userA.id}:${favorite.id}`,
        `${userB.id}:${trashed.id}`,
        `${userB.id}:${archived.id}`,
      ].toSorted();

      await up(db);
      await expect(read()).resolves.toEqual(expected);

      // reverting and replaying must give the same result
      await down(db);
      await up(db);
      await expect(read()).resolves.toEqual(expected);

      // the backfill never changes the legacy column
      await expect(db.selectFrom('asset').select('id').where('isFavorite', '=', true).execute()).resolves.toHaveLength(
        3,
      );

      // restore the current schema
      await upUserState(db);
    });
  });

  describe('createAll', () => {
    it('should return an empty array when given an empty input', async () => {
      const { sut } = setup();
      await expect(sut.createAll([])).resolves.toStrictEqual([]);
    });
  });
});
