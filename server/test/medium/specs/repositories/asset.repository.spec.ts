import { Kysely } from 'kysely';
import { AssetOrder, AssetOrderBy, AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { down, up } from 'src/schema/migrations/1793000000000-AddAssetFavoriteTable.js';
import { BaseService } from 'src/services/base.service.js';
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

      await sut.addFavorites(viewer.id, [asset.id]);
      await sut.addFavorites(viewer.id, [asset.id]); // idempotent

      await expect(sut.getFavoriteIds(viewer.id, [asset.id])).resolves.toEqual(new Set([asset.id]));
      await expect(sut.getFavoriteIds(other.id, [asset.id])).resolves.toEqual(new Set());
      await expect(sut.getFavoriteIds(viewer.id, [])).resolves.toEqual(new Set());

      await sut.removeFavorites(viewer.id, [asset.id]);
      await expect(sut.getFavoriteIds(viewer.id, [asset.id])).resolves.toEqual(new Set());
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

      await down(db);
      const read = () =>
        db
          .selectFrom('asset_favorite')
          .select(['userId', 'assetId'])
          .execute()
          .then((rows) => rows.map(({ userId, assetId }) => `${userId}:${assetId}`).toSorted());

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
    });
  });

  describe('createAll', () => {
    it('should return an empty array when given an empty input', async () => {
      const { sut } = setup();
      await expect(sut.createAll([])).resolves.toStrictEqual([]);
    });
  });
});
