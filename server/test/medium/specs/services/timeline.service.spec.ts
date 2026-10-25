import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AlbumUserRole, AssetOrderBy, AssetVisibility, SharedLinkType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { DB } from 'src/schema/index.js';
import { TimelineService } from 'src/services/timeline.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(TimelineService, {
    database: db || defaultDatabase,
    real: [AssetRepository, AccessRepository, PartnerRepository],
    mock: [LoggingRepository],
  });
};

const setupSharedAlbum = async (ctx: ReturnType<typeof setup>['ctx']) => {
  const { user: owner } = await ctx.newUser();
  const { user: member } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: owner.id });
  await ctx.newExif({ assetId: asset.id, make: 'Canon' });
  const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
  await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });
  return { owner, member, asset, album };
};

const readBucket = async (
  sut: ReturnType<typeof setup>['sut'],
  user: { id: string },
  options: Parameters<ReturnType<typeof setup>['sut']['getTimeBuckets']>[1] = {},
) => {
  const auth = factory.auth({ user });
  const buckets = await sut.getTimeBuckets(auth, options);
  return Promise.all(
    buckets.map(async ({ timeBucket }) => JSON.parse(await sut.getTimeBucket(auth, { ...options, timeBucket }))),
  );
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(TimelineService.name, () => {
  describe('getTimeBuckets', () => {
    it('should get time buckets by month', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const dates = [new Date('1970-01-01'), new Date('1970-02-10'), new Date('1970-02-11'), new Date('1970-02-11')];
      for (const localDateTime of dates) {
        const { asset } = await ctx.newAsset({ ownerId: user.id, localDateTime });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      }

      const response = sut.getTimeBuckets(auth, {});
      await expect(response).resolves.toEqual([
        { count: 3, timeBucket: '1970-02-01' },
        { count: 1, timeBucket: '1970-01-01' },
      ]);
    });

    it('should return error if time bucket is requested with partners asset and archived', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const response1 = sut.getTimeBuckets(auth, { withPartners: true, visibility: AssetVisibility.Archive });
      await expect(response1).rejects.toBeInstanceOf(BadRequestException);
      await expect(response1).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );

      const response2 = sut.getTimeBuckets(auth, { withPartners: true });
      await expect(response2).rejects.toBeInstanceOf(BadRequestException);
      await expect(response2).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );
    });

    it('should return error if time bucket is requested with partners asset and favorite', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const response1 = sut.getTimeBuckets(auth, { withPartners: true, isFavorite: false });
      await expect(response1).rejects.toBeInstanceOf(BadRequestException);
      await expect(response1).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );

      const response2 = sut.getTimeBuckets(auth, { withPartners: true, isFavorite: true });
      await expect(response2).rejects.toBeInstanceOf(BadRequestException);
      await expect(response2).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );
    });

    it('should return error if time bucket is requested with partners asset and trash', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const response = sut.getTimeBuckets(auth, { withPartners: true, isTrashed: true });
      await expect(response).rejects.toBeInstanceOf(BadRequestException);
      await expect(response).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );
    });

    it('should return error if time bucket is requested with locked visibility for partner', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

      const auth = factory.auth({ user, session: { hasElevatedPermission: true } });

      const response = sut.getTimeBuckets(auth, { userId: partner.id, visibility: AssetVisibility.Locked });
      await expect(response).rejects.toThrow("You may not access another user's locked timeline");
    });

    it('should not allow access for unrelated shared links', async () => {
      const { sut } = setup();
      const auth = factory.auth({ sharedLink: {} });
      const response = sut.getTimeBuckets(auth, {});
      await expect(response).rejects.toBeInstanceOf(BadRequestException);
      await expect(response).rejects.toThrow('Not found or no timeline.read access');
    });
  });

  describe('getTimeBucket', () => {
    it('should return time bucket', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        localDateTime: new Date('1970-02-12'),
        deletedAt: new Date(),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      const auth = factory.auth({ user: { id: user.id } });
      const rawResponse = await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', isTrashed: true });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual(expect.objectContaining({ isTrashed: [true] }));
    });

    it('should handle a bucket without any assets', async () => {
      const { sut } = setup();
      const rawResponse = await sut.getTimeBucket(factory.auth(), { timeBucket: '1970-02-01' });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual({
        city: [],
        country: [],
        createdAt: [],
        duration: [],
        id: [],
        visibility: [],
        isFavorite: [],
        isImage: [],
        isTrashed: [],
        livePhotoVideoId: [],
        fileCreatedAt: [],
        localOffsetHours: [],
        ownerId: [],
        projectionType: [],
        ratio: [],
        status: [],
        thumbhash: [],
      });
    });

    it('should handle 5 digit years', async () => {
      const { sut } = setup();
      const rawResponse = await sut.getTimeBucket(factory.auth(), { timeBucket: '012345-01-01' });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual(expect.objectContaining({ id: [] }));
    });

    it('should return time bucket in trash', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        localDateTime: new Date('1970-02-12'),
        deletedAt: new Date(),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      const auth = factory.auth({ user: { id: user.id } });
      const rawResponse = await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', isTrashed: true });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual(expect.objectContaining({ isTrashed: [true] }));
    });

    it('should return false for favorite status unless asset owner', async () => {
      const { sut, ctx } = setup();
      const [{ asset: asset1 }, { asset: asset2 }] = await Promise.all([
        ctx.newUser().then(async ({ user }) => {
          const result = await ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('1970-02-12'),
            localDateTime: new Date('1970-02-12'),
            isFavorite: true,
          });
          await ctx.newExif({ assetId: result.asset.id, make: 'Canon' });
          return result;
        }),

        ctx.newUser().then(async ({ user }) => {
          const result = await ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('1970-02-13'),
            localDateTime: new Date('1970-02-13'),
            isFavorite: true,
          });
          await ctx.newExif({ assetId: result.asset.id, make: 'Canon' });
          return result;
        }),
      ]);

      await Promise.all([
        ctx.newPartner({ sharedById: asset1.ownerId, sharedWithId: asset2.ownerId }),
        ctx.newPartner({ sharedById: asset2.ownerId, sharedWithId: asset1.ownerId }),
      ]);

      const auth1 = factory.auth({ user: { id: asset1.ownerId } });
      const rawResponse1 = await sut.getTimeBucket(auth1, {
        timeBucket: '1970-02-01',
        withPartners: true,
        visibility: AssetVisibility.Timeline,
      });
      const response1 = JSON.parse(rawResponse1);
      expect(response1).toEqual(expect.objectContaining({ id: [asset2.id, asset1.id], isFavorite: [false, true] }));

      const auth2 = factory.auth({ user: { id: asset2.ownerId } });
      const rawResponse2 = await sut.getTimeBucket(auth2, {
        timeBucket: '1970-02-01',
        withPartners: true,
        visibility: AssetVisibility.Timeline,
      });
      const response2 = JSON.parse(rawResponse2);
      expect(response2).toEqual(expect.objectContaining({ id: [asset2.id, asset1.id], isFavorite: [true, false] }));
    });
  });

  describe('shared favorites', () => {
    it('should list a favorited shared-album asset on the favorites timeline of the favoriting user only', async () => {
      const { sut, ctx } = setup();
      const { owner, member, asset } = await setupSharedAlbum(ctx);
      await ctx.get(AssetRepository).addFavorites(member.id, [asset.id]);

      await expect(sut.getTimeBuckets(factory.auth({ user: member }), { isFavorite: true })).resolves.toHaveLength(1);
      await expect(sut.getTimeBuckets(factory.auth({ user: owner }), { isFavorite: true })).resolves.toHaveLength(0);
    });

    it('should flag the asset as favorite inside an album bucket for the favoriting user only', async () => {
      const { sut, ctx } = setup();
      const { owner, member, asset, album } = await setupSharedAlbum(ctx);
      await ctx.get(AssetRepository).addFavorites(member.id, [asset.id]);
      const buckets = await sut.getTimeBuckets(factory.auth({ user: member }), { albumId: album.id });
      const bucket = buckets[0].timeBucket;

      const read = async (user: typeof member) =>
        JSON.parse(await sut.getTimeBucket(factory.auth({ user }), { albumId: album.id, timeBucket: bucket }));

      const memberView = await read(member);
      const ownerView = await read(owner);
      expect(memberView.isFavorite).toEqual([true]);
      expect(ownerView.isFavorite).toEqual([false]);
    });

    it('should list a favorited partner asset on the favorites timeline', async () => {
      const { sut, ctx } = setup();
      const { user: sharer } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      await ctx.newPartner({ sharedById: sharer.id, sharedWithId: viewer.id });
      const { asset } = await ctx.newAsset({ ownerId: sharer.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      await ctx.get(AssetRepository).addFavorites(viewer.id, [asset.id]);

      await expect(sut.getTimeBuckets(factory.auth({ user: viewer }), { isFavorite: true })).resolves.toHaveLength(1);
    });

    it('should hide a stale favorite after access was lost', async () => {
      const { sut, ctx } = setup();
      const { member, asset, album } = await setupSharedAlbum(ctx);
      await ctx.get(AssetRepository).addFavorites(member.id, [asset.id]);
      await ctx.database
        .deleteFrom('album_user')
        .where('albumId', '=', album.id)
        .where('userId', '=', member.id)
        .execute();

      await expect(sut.getTimeBuckets(factory.auth({ user: member }), { isFavorite: true })).resolves.toHaveLength(0);
    });

    it('should hide a favorited partner asset once the partner archives it', async () => {
      const { sut, ctx } = setup();
      const { user: sharer } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      await ctx.newPartner({ sharedById: sharer.id, sharedWithId: viewer.id });
      const { asset } = await ctx.newAsset({ ownerId: sharer.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      await ctx.get(AssetRepository).addFavorites(viewer.id, [asset.id]);
      await expect(sut.getTimeBuckets(factory.auth({ user: viewer }), { isFavorite: true })).resolves.toHaveLength(1);

      await ctx.database
        .updateTable('asset')
        .set({ visibility: AssetVisibility.Archive })
        .where('id', '=', asset.id)
        .execute();

      await expect(sut.getTimeBuckets(factory.auth({ user: viewer }), { isFavorite: true })).resolves.toHaveLength(0);
    });

    it('should hide a favorited partner asset once the partner is removed', async () => {
      const { sut, ctx } = setup();
      const { user: sharer } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      await ctx.newPartner({ sharedById: sharer.id, sharedWithId: viewer.id });
      const { asset } = await ctx.newAsset({ ownerId: sharer.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      await ctx.get(AssetRepository).addFavorites(viewer.id, [asset.id]);
      await ctx.database
        .deleteFrom('partner')
        .where('sharedById', '=', sharer.id)
        .where('sharedWithId', '=', viewer.id)
        .execute();

      await expect(sut.getTimeBuckets(factory.auth({ user: viewer }), { isFavorite: true })).resolves.toHaveLength(0);
    });

    it('should not list another user trashed shared asset on the trashed favorites timeline', async () => {
      const { sut, ctx } = setup();
      const { owner, member, asset } = await setupSharedAlbum(ctx);
      await ctx.get(AssetRepository).addFavorites(member.id, [asset.id]);
      await ctx.database.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();

      await expect(
        sut.getTimeBuckets(factory.auth({ user: member }), { isFavorite: true, isTrashed: true }),
      ).resolves.toHaveLength(0);
      await expect(sut.getTimeBuckets(factory.auth({ user: owner }), { isTrashed: true })).resolves.toHaveLength(1);
    });

    it('should exclude an asset the member favorited from the non-favorites timeline', async () => {
      const { sut, ctx } = setup();
      const { member, asset, album } = await setupSharedAlbum(ctx);
      await ctx.get(AssetRepository).addFavorites(member.id, [asset.id]);

      await expect(
        sut.getTimeBuckets(factory.auth({ user: member }), { albumId: album.id, isFavorite: false }),
      ).resolves.toHaveLength(0);
      await expect(
        sut.getTimeBuckets(factory.auth({ user: member }), { albumId: album.id, isFavorite: true }),
      ).resolves.toHaveLength(1);
    });

    it('should not report the link creator personal favorites on a shared link bucket', async () => {
      const { sut, ctx } = setup();
      const { owner, member, asset, album } = await setupSharedAlbum(ctx);
      await ctx.get(AssetRepository).addFavorites(member.id, [asset.id]);
      const { id: sharedLinkId } = await ctx.get(SharedLinkRepository).create({
        allowUpload: false,
        key: Buffer.from('favorites-link'),
        type: SharedLinkType.Album,
        userId: member.id,
        albumId: album.id,
      });
      const [{ timeBucket: bucket }] = await sut.getTimeBuckets(factory.auth({ user: owner }), { albumId: album.id });

      const auth = factory.auth({ user: member, sharedLink: { id: sharedLinkId, showExif: true } });
      const response = JSON.parse(await sut.getTimeBucket(auth, { albumId: album.id, timeBucket: bucket }));
      expect(response.isFavorite).toEqual([false]);
    });

    it('should not filter shared link buckets by the link creator personal favorites', async () => {
      const { sut, ctx } = setup();
      const { member, asset, album } = await setupSharedAlbum(ctx);
      await ctx.get(AssetRepository).addFavorites(member.id, [asset.id]);
      const { id: sharedLinkId } = await ctx.get(SharedLinkRepository).create({
        allowUpload: false,
        key: Buffer.from('favorites-filter-link'),
        type: SharedLinkType.Album,
        userId: member.id,
        albumId: album.id,
      });
      const auth = factory.auth({ user: member, sharedLink: { id: sharedLinkId, showExif: true } });
      const [{ timeBucket: bucket }] = await sut.getTimeBuckets(auth, { albumId: album.id });

      await expect(sut.getTimeBuckets(auth, { albumId: album.id, isFavorite: true })).resolves.toHaveLength(0);
      await expect(sut.getTimeBuckets(auth, { albumId: album.id, isFavorite: false })).resolves.toHaveLength(1);
      const hidden = JSON.parse(
        await sut.getTimeBucket(auth, { albumId: album.id, timeBucket: bucket, isFavorite: true }),
      );
      expect(hidden.id).toEqual([]);
      const visible = JSON.parse(
        await sut.getTimeBucket(auth, { albumId: album.id, timeBucket: bucket, isFavorite: false }),
      );
      expect(visible.id).toEqual([asset.id]);
    });

    it('should keep the owner favorite behaviour unchanged', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      await expect(sut.getTimeBuckets(factory.auth({ user }), { isFavorite: true })).resolves.toHaveLength(1);
      await expect(sut.getTimeBuckets(factory.auth({ user }), { isFavorite: false })).resolves.toHaveLength(0);
    });

    describe('owner rows are only a mirror of the column', () => {
      it('should not treat a stale owner row as favorite when the column is false', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: user.id, isFavorite: false });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
        await ctx.get(AssetRepository).addFavorites(user.id, [asset.id]);

        const auth = factory.auth({ user });
        await expect(sut.getTimeBuckets(auth, { isFavorite: true })).resolves.toHaveLength(0);
        await expect(sut.getTimeBuckets(auth, { isFavorite: false })).resolves.toHaveLength(1);
        const [bucket] = await readBucket(sut, user);
        expect(bucket.id).toEqual([asset.id]);
        expect(bucket.isFavorite).toEqual([false]);
        const hidden = await readBucket(sut, user, { isFavorite: true });
        expect(hidden).toEqual([]);
      });

      it('should keep an owned asset favorite when the column is true and there is no owner row', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });

        const auth = factory.auth({ user });
        await expect(sut.getTimeBuckets(auth, { isFavorite: true })).resolves.toHaveLength(1);
        await expect(sut.getTimeBuckets(auth, { isFavorite: false })).resolves.toHaveLength(0);
        const [bucket] = await readBucket(sut, user);
        expect(bucket.isFavorite).toEqual([true]);
      });

      it('should not list a stale owner row through the shared favorites path of a shared album', async () => {
        const { sut, ctx } = setup();
        const { user: owner } = await ctx.newUser();
        const { user: other } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: owner.id, isFavorite: false });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
        // the owner is a member of another user's album that contains their own asset
        const { album } = await ctx.newAlbum({ ownerId: other.id }, [asset.id]);
        await ctx.newAlbumUser({ albumId: album.id, userId: owner.id, role: AlbumUserRole.Viewer });
        await ctx.get(AssetRepository).addFavorites(owner.id, [asset.id]);

        await expect(sut.getTimeBuckets(factory.auth({ user: owner }), { isFavorite: true })).resolves.toHaveLength(0);
      });
    });
  });

  it('should strip geodata metadata if shared link without exif', async () => {
    const { sut, ctx } = setup();
    const sharedLinkRepo = ctx.get(SharedLinkRepository);

    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      localDateTime: new Date('1970-02-12'),
      deletedAt: new Date(),
    });
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

    const { id: sharedLinkId } = await sharedLinkRepo.create({
      allowUpload: false,
      key: Buffer.from('123'),
      type: SharedLinkType.Album,
      userId: user.id,
      albumId: album.id,
    });

    await ctx.newExif({ assetId: asset.id, city: 'Austin', country: 'USA' });
    const auth = factory.auth({ sharedLink: { id: sharedLinkId, showExif: false } });
    const rawResponse = await sut.getTimeBucket(auth, { albumId: album.id, timeBucket: '1970-02-01', isTrashed: true });
    const response = JSON.parse(rawResponse);
    expect(response).not.toEqual(expect.objectContaining({ city: expect.any(Array), country: expect.any(Array) }));
  });
});
