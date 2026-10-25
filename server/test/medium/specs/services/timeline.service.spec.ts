import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AlbumUserRole, AssetColorLabel, AssetFlag, AssetOrderBy, AssetVisibility, SharedLinkType } from 'src/enum.js';
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

// owner assets: five (exif 5), three (exif 3), none (no rating), rejected (exif -1)
const setupRated = async (ctx: ReturnType<typeof setup>['ctx']) => {
  const { user: owner } = await ctx.newUser();
  const { user: member } = await ctx.newUser();
  const { user: partner } = await ctx.newUser();
  const assets: Record<string, string> = {};
  for (const [name, rating] of [
    ['five', 5],
    ['three', 3],
    ['none', null],
    ['rejected', -1],
  ] as const) {
    const { asset } = await ctx.newAsset({ ownerId: owner.id, localDateTime: new Date('2024-03-05') });
    await ctx.newExif({ assetId: asset.id, make: 'Canon', rating });
    assets[name] = asset.id;
  }
  const { album } = await ctx.newAlbum({ ownerId: owner.id }, Object.values(assets));
  await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });
  await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id });
  return { owner, member, partner, assets, album };
};

const idsOf = (bucket: { id: string[] }[] | undefined) => (bucket?.[0]?.id ?? []).toSorted();
const sorted = (...ids: string[]) => ids.toSorted();

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
        'Only non-archived, non-trashed, non-locked assets can be requested for other users',
      );

      const response2 = sut.getTimeBuckets(auth, { withPartners: true, visibility: AssetVisibility.Hidden });
      await expect(response2).rejects.toBeInstanceOf(BadRequestException);
      await expect(response2).rejects.toThrow(
        'Only non-archived, non-trashed, non-locked assets can be requested for other users',
      );
    });

    it('should default to timeline visibility if time bucket is requested with partners assets', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      await expect(sut.getTimeBuckets(auth, { withPartners: true })).resolves.toEqual([]);
    });

    it('should allow filtering by favorite on a timeline that includes partners', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      await expect(sut.getTimeBuckets(auth, { withPartners: true, isFavorite: false })).resolves.toEqual([]);
      await expect(sut.getTimeBuckets(auth, { withPartners: true, isFavorite: true })).resolves.toEqual([]);
    });

    it('should allow filtering by favorite on a partner timeline', async () => {
      const { sut, ctx } = setup();
      const { user: sharer } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      await ctx.newPartner({ sharedById: sharer.id, sharedWithId: viewer.id });
      const { asset } = await ctx.newAsset({ ownerId: sharer.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      await ctx.get(AssetRepository).setUserState(viewer.id, [asset.id], { isFavorite: true });

      const auth = factory.auth({ user: viewer });
      await expect(sut.getTimeBuckets(auth, { userId: sharer.id, isFavorite: true })).resolves.toHaveLength(1);
      await expect(sut.getTimeBuckets(auth, { userId: sharer.id, isFavorite: false })).resolves.toHaveLength(0);
    });

    it('should return error if time bucket is requested with partners asset and trash', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const response = sut.getTimeBuckets(auth, { withPartners: true, isTrashed: true });
      await expect(response).rejects.toBeInstanceOf(BadRequestException);
      await expect(response).rejects.toThrow(
        'Only non-archived, non-trashed, non-locked assets can be requested for other users',
      );
    });

    it('should return error if time bucket is requested with locked visibility for partner', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

      const auth = factory.auth({ user, session: { hasElevatedPermission: true } });

      const response = sut.getTimeBuckets(auth, { userId: partner.id, visibility: AssetVisibility.Locked });
      await expect(response).rejects.toThrow(
        'Only non-archived, non-trashed, non-locked assets can be requested for other users',
      );
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
        colorLabel: [],
        country: [],
        createdAt: [],
        duration: [],
        flag: [],
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
        rating: [],
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

      const createdAtResponse = await sut.getTimeBucket(factory.auth(), {
        timeBucket: '012345-01-01',
        orderBy: AssetOrderBy.CreatedAt,
      });
      expect(JSON.parse(createdAtResponse)).toEqual(expect.objectContaining({ id: [] }));
    });

    it('should bucket by upload month when ordering by createdAt', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const dates = [
        '1970-01-31T23:59:59.999Z',
        '1970-02-01T00:00:00.000Z',
        '1970-02-28T23:59:59.999Z',
        '1970-03-01T00:00:00.000Z',
      ];
      const ids: string[] = [];
      for (const createdAt of dates) {
        const { asset } = await ctx.newAsset({ ownerId: user.id, createdAt, localDateTime: new Date('2000-01-01') });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
        ids.push(asset.id);
      }

      const rawResponse = await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', orderBy: AssetOrderBy.CreatedAt });
      const response = JSON.parse(rawResponse);
      expect(response.id).toEqual([ids[2], ids[1]]);
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
      await ctx.get(AssetRepository).setUserState(member.id, [asset.id], { isFavorite: true });

      await expect(sut.getTimeBuckets(factory.auth({ user: member }), { isFavorite: true })).resolves.toHaveLength(1);
      await expect(sut.getTimeBuckets(factory.auth({ user: owner }), { isFavorite: true })).resolves.toHaveLength(0);
    });

    it('should flag the asset as favorite inside an album bucket for the favoriting user only', async () => {
      const { sut, ctx } = setup();
      const { owner, member, asset, album } = await setupSharedAlbum(ctx);
      await ctx.get(AssetRepository).setUserState(member.id, [asset.id], { isFavorite: true });
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
      await ctx.get(AssetRepository).setUserState(viewer.id, [asset.id], { isFavorite: true });

      await expect(sut.getTimeBuckets(factory.auth({ user: viewer }), { isFavorite: true })).resolves.toHaveLength(1);
    });

    it('should hide a stale favorite after access was lost', async () => {
      const { sut, ctx } = setup();
      const { member, asset, album } = await setupSharedAlbum(ctx);
      await ctx.get(AssetRepository).setUserState(member.id, [asset.id], { isFavorite: true });
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
      await ctx.get(AssetRepository).setUserState(viewer.id, [asset.id], { isFavorite: true });
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
      await ctx.get(AssetRepository).setUserState(viewer.id, [asset.id], { isFavorite: true });
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
      await ctx.get(AssetRepository).setUserState(member.id, [asset.id], { isFavorite: true });
      await ctx.database.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();

      await expect(
        sut.getTimeBuckets(factory.auth({ user: member }), { isFavorite: true, isTrashed: true }),
      ).resolves.toHaveLength(0);
      await expect(sut.getTimeBuckets(factory.auth({ user: owner }), { isTrashed: true })).resolves.toHaveLength(1);
    });

    it('should exclude an asset the member favorited from the non-favorites timeline', async () => {
      const { sut, ctx } = setup();
      const { member, asset, album } = await setupSharedAlbum(ctx);
      await ctx.get(AssetRepository).setUserState(member.id, [asset.id], { isFavorite: true });

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
      await ctx.get(AssetRepository).setUserState(member.id, [asset.id], { isFavorite: true });
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
      await ctx.get(AssetRepository).setUserState(member.id, [asset.id], { isFavorite: true });
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
        await ctx.get(AssetRepository).setUserState(user.id, [asset.id], { isFavorite: true });

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
        await ctx.get(AssetRepository).setUserState(owner.id, [asset.id], { isFavorite: true });

        await expect(sut.getTimeBuckets(factory.auth({ user: owner }), { isFavorite: true })).resolves.toHaveLength(0);
      });
    });
  });

  describe('rating and color label filters', () => {
    it('should filter by minimum rating for the owner and expose the effective rating', async () => {
      const { sut, ctx } = setup();
      const { owner, assets } = await setupRated(ctx);

      const buckets = await readBucket(sut, owner, { rating: 3 });
      expect(idsOf(buckets)).toEqual(sorted(assets.five, assets.three));
      const ratingById = Object.fromEntries(buckets[0].id.map((id: string, i: number) => [id, buckets[0].rating[i]]));
      expect(ratingById).toEqual({ [assets.five]: 5, [assets.three]: 3 });

      const all = await readBucket(sut, owner);
      const allById = Object.fromEntries(all[0].id.map((id: string, i: number) => [id, all[0].rating[i]]));
      expect(allById).toEqual({ [assets.five]: 5, [assets.three]: 3, [assets.none]: null, [assets.rejected]: -1 });
    });

    it('should filter unrated and combine rating with unrated as OR', async () => {
      const { sut, ctx } = setup();
      const { owner, assets } = await setupRated(ctx);

      expect(idsOf(await readBucket(sut, owner, { unrated: true }))).toEqual(sorted(assets.none));
      expect(idsOf(await readBucket(sut, owner, { rating: 4, unrated: true }))).toEqual(
        sorted(assets.five, assets.none),
      );
    });

    it('should apply the viewer rating for album members and fall back to exif', async () => {
      const { sut, ctx } = setup();
      const { member, assets, album } = await setupRated(ctx);
      await ctx.get(AssetRepository).setUserState(member.id, [assets.none], { rating: 4 });
      await ctx.get(AssetRepository).setUserState(member.id, [assets.five], { rating: 2 });

      const buckets = await readBucket(sut, member, { albumId: album.id, rating: 3 });
      expect(idsOf(buckets)).toEqual(sorted(assets.none, assets.three));
      const ratingById = Object.fromEntries(buckets[0].id.map((id: string, i: number) => [id, buckets[0].rating[i]]));
      expect(ratingById).toEqual({ [assets.none]: 4, [assets.three]: 3 });

      expect(idsOf(await readBucket(sut, member, { albumId: album.id, unrated: true }))).toEqual([]);
      await expect(
        sut.getTimeBuckets(factory.auth({ user: member }), { albumId: album.id, rating: 3 }),
      ).resolves.toEqual([expect.objectContaining({ count: 2 })]);
    });

    it('should apply the partner viewer rating on a partner timeline', async () => {
      const { sut, ctx } = setup();
      const { owner, partner, assets } = await setupRated(ctx);
      await ctx.get(AssetRepository).setUserState(partner.id, [assets.none], { rating: 5 });

      const options = { userId: owner.id } as const;
      expect(idsOf(await readBucket(sut, partner, { ...options, rating: 3 }))).toEqual(
        sorted(assets.five, assets.three, assets.none),
      );
      expect(idsOf(await readBucket(sut, partner, { ...options, unrated: true }))).toEqual([]);
      const buckets = await readBucket(sut, partner, options);
      const ratingById = Object.fromEntries(buckets[0].id.map((id: string, i: number) => [id, buckets[0].rating[i]]));
      expect(ratingById[assets.none]).toBe(5);
    });

    it('should filter by color label per viewer', async () => {
      const { sut, ctx } = setup();
      const { owner, member, assets, album } = await setupRated(ctx);
      const repo = ctx.get(AssetRepository);
      await repo.setUserState(owner.id, [assets.five], { colorLabel: AssetColorLabel.Red });
      await repo.setUserState(member.id, [assets.five], { colorLabel: AssetColorLabel.Blue });
      await repo.setUserState(member.id, [assets.three], { colorLabel: AssetColorLabel.Red });

      const everything = sorted(...Object.values(assets));
      const rest = (...excluded: string[]) => everything.filter((id) => !excluded.includes(id));

      expect(idsOf(await readBucket(sut, owner, { colorLabels: [AssetColorLabel.Red] }))).toEqual([assets.five]);
      expect(idsOf(await readBucket(sut, owner, { colorLabels: ['none'] }))).toEqual(rest(assets.five));
      expect(idsOf(await readBucket(sut, owner, { colorLabels: [AssetColorLabel.Red, 'none'] }))).toEqual(everything);

      const memberOptions = { albumId: album.id } as const;
      expect(idsOf(await readBucket(sut, member, { ...memberOptions, colorLabels: [AssetColorLabel.Red] }))).toEqual([
        assets.three,
      ]);
      expect(idsOf(await readBucket(sut, member, { ...memberOptions, colorLabels: [AssetColorLabel.Blue] }))).toEqual([
        assets.five,
      ]);
      expect(idsOf(await readBucket(sut, member, { ...memberOptions, colorLabels: ['none'] }))).toEqual(
        rest(assets.five, assets.three),
      );

      const buckets = await readBucket(sut, member, memberOptions);
      const colorById = Object.fromEntries(
        buckets[0].id.map((id: string, i: number) => [id, buckets[0].colorLabel[i]]),
      );
      expect(colorById).toEqual({
        [assets.five]: 'blue',
        [assets.three]: 'red',
        [assets.none]: null,
        [assets.rejected]: null,
      });
      const ownerBuckets = await readBucket(sut, owner);
      expect(ownerBuckets[0].colorLabel[ownerBuckets[0].id.indexOf(assets.five)]).toBe('red');
    });

    it('should filter by flag per viewer and expose the viewer flag', async () => {
      const { sut, ctx } = setup();
      const { owner, member, partner, assets, album } = await setupRated(ctx);
      const repo = ctx.get(AssetRepository);
      await repo.setUserState(owner.id, [assets.five], { flag: AssetFlag.Pick });
      await repo.setUserState(owner.id, [assets.three], { flag: AssetFlag.Reject });
      await repo.setUserState(member.id, [assets.five], { flag: AssetFlag.Reject });
      await repo.setUserState(member.id, [assets.none], { flag: AssetFlag.Pick });
      await repo.setUserState(partner.id, [assets.rejected], { flag: AssetFlag.Pick });

      const everything = sorted(...Object.values(assets));
      const rest = (...excluded: string[]) => everything.filter((id) => !excluded.includes(id));

      expect(idsOf(await readBucket(sut, owner, { flags: [AssetFlag.Pick] }))).toEqual([assets.five]);
      expect(idsOf(await readBucket(sut, owner, { flags: [AssetFlag.Reject] }))).toEqual([assets.three]);
      expect(idsOf(await readBucket(sut, owner, { flags: ['none'] }))).toEqual(rest(assets.five, assets.three));
      expect(idsOf(await readBucket(sut, owner, { flags: [AssetFlag.Pick, AssetFlag.Reject] }))).toEqual(
        sorted(assets.five, assets.three),
      );

      // combined with another filter is an AND
      await repo.setUserState(owner.id, [assets.five], { colorLabel: AssetColorLabel.Red });
      await repo.setUserState(owner.id, [assets.three], { colorLabel: AssetColorLabel.Blue });
      expect(
        idsOf(
          await readBucket(sut, owner, {
            flags: [AssetFlag.Pick, AssetFlag.Reject],
            colorLabels: [AssetColorLabel.Red],
          }),
        ),
      ).toEqual([assets.five]);
      expect(
        idsOf(await readBucket(sut, owner, { flags: [AssetFlag.Pick], colorLabels: [AssetColorLabel.Blue] })),
      ).toEqual([]);

      // album members only see their own flags
      const memberOptions = { albumId: album.id } as const;
      expect(idsOf(await readBucket(sut, member, { ...memberOptions, flags: [AssetFlag.Pick] }))).toEqual([
        assets.none,
      ]);
      expect(idsOf(await readBucket(sut, member, { ...memberOptions, flags: [AssetFlag.Reject] }))).toEqual([
        assets.five,
      ]);
      const memberBuckets = await readBucket(sut, member, memberOptions);
      const flagById = Object.fromEntries(
        memberBuckets[0].id.map((id: string, i: number) => [id, memberBuckets[0].flag[i]]),
      );
      expect(flagById).toEqual({
        [assets.five]: 'reject',
        [assets.three]: null,
        [assets.none]: 'pick',
        [assets.rejected]: null,
      });

      // partners only see their own flags
      const partnerOptions = { userId: owner.id } as const;
      expect(idsOf(await readBucket(sut, partner, { ...partnerOptions, flags: [AssetFlag.Pick] }))).toEqual([
        assets.rejected,
      ]);
      const partnerBuckets = await readBucket(sut, partner, partnerOptions);
      expect(partnerBuckets[0].flag[partnerBuckets[0].id.indexOf(assets.five)]).toBeNull();
      expect(partnerBuckets[0].flag[partnerBuckets[0].id.indexOf(assets.rejected)]).toBe('pick');

      const ownerBuckets = await readBucket(sut, owner);
      expect(ownerBuckets[0].flag[ownerBuckets[0].id.indexOf(assets.five)]).toBe('pick');
      expect(ownerBuckets[0].flag[ownerBuckets[0].id.indexOf(assets.three)]).toBe('reject');
    });

    it('should count buckets with the flag filter applied', async () => {
      const { sut, ctx } = setup();
      const { owner, assets } = await setupRated(ctx);
      await ctx.get(AssetRepository).setUserState(owner.id, [assets.five], { flag: AssetFlag.Pick });
      const auth = factory.auth({ user: owner });

      await expect(sut.getTimeBuckets(auth, { flags: [AssetFlag.Pick] })).resolves.toEqual([
        expect.objectContaining({ count: 1 }),
      ]);
      await expect(sut.getTimeBuckets(auth, { flags: [AssetFlag.Reject] })).resolves.toEqual([]);
      await expect(sut.getTimeBuckets(auth, { flags: ['none'] })).resolves.toEqual([
        expect.objectContaining({ count: 3 }),
      ]);
    });

    it('should show no flags and match every asset for none on shared links', async () => {
      const { sut, ctx } = setup();
      const { owner, assets, album } = await setupRated(ctx);
      await ctx.get(AssetRepository).setUserState(owner.id, [assets.five], { flag: AssetFlag.Pick });
      const { id: sharedLinkId } = await ctx.get(SharedLinkRepository).create({
        allowUpload: false,
        key: Buffer.from(`flag-${owner.id}`),
        type: SharedLinkType.Album,
        userId: owner.id,
        albumId: album.id,
      });
      const auth = factory.auth({ user: owner, sharedLink: { id: sharedLinkId, showExif: true } });
      const read = async (flags?: Array<AssetFlag | 'none'>) =>
        JSON.parse(await sut.getTimeBucket(auth, { albumId: album.id, timeBucket: '2024-03-01', flags }));

      const all = await read();
      expect(all.id.length).toBe(4);
      expect(all.flag).toEqual([null, null, null, null]);
      const none = await read(['none']);
      const picked = await read([AssetFlag.Pick]);
      expect(none.id.toSorted()).toEqual(all.id.toSorted());
      expect(picked.id ?? []).toEqual([]);
    });

    it('should count buckets with the filters applied', async () => {
      const { sut, ctx } = setup();
      const { owner, assets } = await setupRated(ctx);
      await ctx.get(AssetRepository).setUserState(owner.id, [assets.five], { colorLabel: AssetColorLabel.Green });
      const auth = factory.auth({ user: owner });

      await expect(sut.getTimeBuckets(auth, {})).resolves.toEqual([expect.objectContaining({ count: 4 })]);
      await expect(sut.getTimeBuckets(auth, { rating: 3 })).resolves.toEqual([expect.objectContaining({ count: 2 })]);
      await expect(sut.getTimeBuckets(auth, { rating: 3, unrated: true })).resolves.toEqual([
        expect.objectContaining({ count: 3 }),
      ]);
      await expect(sut.getTimeBuckets(auth, { unrated: true })).resolves.toEqual([
        expect.objectContaining({ count: 1 }),
      ]);
      await expect(sut.getTimeBuckets(auth, { colorLabels: [AssetColorLabel.Green] })).resolves.toEqual([
        expect.objectContaining({ count: 1 }),
      ]);
      await expect(sut.getTimeBuckets(auth, { colorLabels: [AssetColorLabel.Red] })).resolves.toEqual([]);
      await expect(sut.getTimeBuckets(auth, { colorLabels: ['none'] })).resolves.toEqual([
        expect.objectContaining({ count: 3 }),
      ]);
    });

    it('should ignore a stale owner mirror row for rating and favorites', async () => {
      const { sut, ctx } = setup();
      const { owner, assets } = await setupRated(ctx);
      await ctx.get(AssetRepository).setUserState(owner.id, [assets.none], { isFavorite: true, rating: 5 });

      expect(idsOf(await readBucket(sut, owner, { rating: 3 }))).toEqual(sorted(assets.five, assets.three));
      expect(idsOf(await readBucket(sut, owner, { unrated: true }))).toEqual([assets.none]);
      expect(await readBucket(sut, owner, { isFavorite: true })).toEqual([]);
    });

    it('should use the exif rating and no color for shared links', async () => {
      const { sut, ctx } = setup();
      const { owner, member, assets, album } = await setupRated(ctx);
      await ctx.get(AssetRepository).setUserState(owner.id, [assets.five], { colorLabel: AssetColorLabel.Red });
      await ctx.get(AssetRepository).setUserState(member.id, [assets.none], { rating: 5 });
      const { id: sharedLinkId } = await ctx.get(SharedLinkRepository).create({
        allowUpload: false,
        key: Buffer.from(`rating-${owner.id}`),
        type: SharedLinkType.Album,
        userId: owner.id,
        albumId: album.id,
      });
      const auth = factory.auth({ user: owner, sharedLink: { id: sharedLinkId, showExif: true } });

      const rated = await sut.getTimeBucket(auth, {
        albumId: album.id,
        timeBucket: '2024-03-01',
        rating: 3,
      });
      const parsed = JSON.parse(rated);
      expect(parsed.id.toSorted()).toEqual(sorted(assets.five, assets.three));
      expect(parsed.colorLabel).toEqual([null, null]);
    });

    it('should match every asset for the none color label and nothing for colors on shared links', async () => {
      const { sut, ctx } = setup();
      const { owner, assets, album } = await setupRated(ctx);
      await ctx.get(AssetRepository).setUserState(owner.id, [assets.five], { colorLabel: AssetColorLabel.Red });
      const { id: sharedLinkId } = await ctx.get(SharedLinkRepository).create({
        allowUpload: false,
        key: Buffer.from(`color-${owner.id}`),
        type: SharedLinkType.Album,
        userId: owner.id,
        albumId: album.id,
      });
      const auth = factory.auth({ user: owner, sharedLink: { id: sharedLinkId, showExif: true } });

      const all = JSON.parse(await sut.getTimeBucket(auth, { albumId: album.id, timeBucket: '2024-03-01' }));
      const none = JSON.parse(
        await sut.getTimeBucket(auth, {
          albumId: album.id,
          timeBucket: '2024-03-01',
          colorLabels: ['none'],
        }),
      );
      const red = JSON.parse(
        await sut.getTimeBucket(auth, {
          albumId: album.id,
          timeBucket: '2024-03-01',
          colorLabels: [AssetColorLabel.Red],
        }),
      );

      expect(all.id.length).toBeGreaterThan(0);
      expect(none.id.toSorted()).toEqual(all.id.toSorted());
      expect(red.id ?? []).toEqual([]);
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
