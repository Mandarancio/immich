import { AlbumUserRole, AssetVisibility, LoginResponseDto } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

type Asset = { id: string };

const setFavorite = (accessToken: string, id: string, isFavorite: boolean) =>
  request(app).put(`/assets/${id}`).set('Authorization', `Bearer ${accessToken}`).send({ isFavorite });

const getFavoriteBuckets = (accessToken: string) =>
  request(app).get('/timeline/buckets').query({ isFavorite: true }).set('Authorization', `Bearer ${accessToken}`);

const getFavoriteStats = (accessToken: string) =>
  request(app).get('/assets/statistics').query({ isFavorite: true }).set('Authorization', `Bearer ${accessToken}`);

const searchFavorites = async (accessToken: string) => {
  const { status, body } = await request(app)
    .post('/search/metadata')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ isFavorite: true });
  expect(status).toBe(200);
  return (body.assets.items as Asset[]).map(({ id }) => id);
};

describe('shared favorites', () => {
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let member: LoginResponseDto;
  let stranger: LoginResponseDto;
  let partnerOwner: LoginResponseDto;
  let partner: LoginResponseDto;
  let assetId: string;
  let albumId: string;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    [owner, member, stranger, partnerOwner, partner] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.create('fav-owner')),
      utils.userSetup(admin.accessToken, createUserDto.create('fav-member')),
      utils.userSetup(admin.accessToken, createUserDto.create('fav-stranger')),
      utils.userSetup(admin.accessToken, createUserDto.create('fav-partner-owner')),
      utils.userSetup(admin.accessToken, createUserDto.create('fav-partner')),
    ]);

    const asset = await utils.createAsset(owner.accessToken);
    assetId = asset.id;
    const album = await utils.createAlbum(owner.accessToken, {
      albumName: 'shared',
      assetIds: [assetId],
      albumUsers: [{ userId: member.userId, role: AlbumUserRole.Viewer }],
    });
    albumId = album.id;

    await utils.createPartner(partnerOwner.accessToken, partner.userId);
    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
  });

  describe('album members', () => {
    it('should let an album viewer favorite a photo and see it as a favorite only for themselves', async () => {
      const { status, body } = await setFavorite(member.accessToken, assetId, true);
      expect(status).toBe(200);
      expect(body).toMatchObject({ id: assetId, isFavorite: true });

      const asMember = await utils.getAssetInfo(member.accessToken, assetId);
      const asOwner = await utils.getAssetInfo(owner.accessToken, assetId);
      expect(asMember.isFavorite).toBe(true);
      expect(asOwner.isFavorite).toBe(false);
    });

    it('should list the favorite on the favorites timeline and in statistics of the member only', async () => {
      await setFavorite(member.accessToken, assetId, true);

      const memberBuckets = await getFavoriteBuckets(member.accessToken);
      expect(memberBuckets.status).toBe(200);
      expect(memberBuckets.body).toHaveLength(1);

      const ownerBuckets = await getFavoriteBuckets(owner.accessToken);
      expect(ownerBuckets.status).toBe(200);
      expect(ownerBuckets.body).toHaveLength(0);

      const memberStats = await getFavoriteStats(member.accessToken);
      expect(memberStats.status).toBe(200);
      expect(memberStats.body).toMatchObject({ images: 1 });

      const ownerStats = await getFavoriteStats(owner.accessToken);
      expect(ownerStats.status).toBe(200);
      expect(ownerStats.body).toMatchObject({ images: 0, videos: 0 });
    });

    it('should find the favorite via search for the member only', async () => {
      await setFavorite(member.accessToken, assetId, true);

      expect(await searchFavorites(member.accessToken)).toEqual([assetId]);
      expect(await searchFavorites(owner.accessToken)).toEqual([]);
    });

    it('should not let a non-owner change other fields', async () => {
      const before = await utils.getAssetInfo(owner.accessToken, assetId);

      const { status } = await request(app)
        .put(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${member.accessToken}`)
        .send({ isFavorite: true, description: 'nope' });
      expect(status).toBe(400);

      const after = await utils.getAssetInfo(owner.accessToken, assetId);
      expect(after.exifInfo?.description ?? '').toBe(before.exifInfo?.description ?? '');
      expect(after.exifInfo?.description ?? '').not.toBe('nope');
    });

    it('should reject a user without access and not record a favorite', async () => {
      await setFavorite(member.accessToken, assetId, true);

      const { status } = await setFavorite(stranger.accessToken, assetId, true);
      expect(status).toBe(400);

      expect(await searchFavorites(stranger.accessToken)).toEqual([]);
      const strangerBuckets = await getFavoriteBuckets(stranger.accessToken);
      expect(strangerBuckets.status).toBe(200);
      expect(strangerBuckets.body).toHaveLength(0);
      const strangerStats = await getFavoriteStats(stranger.accessToken);
      expect(strangerStats.body).toMatchObject({ images: 0, videos: 0 });

      // the member's favorite and the owner's state are unaffected
      expect(await searchFavorites(member.accessToken)).toEqual([assetId]);
      const asOwner = await utils.getAssetInfo(owner.accessToken, assetId);
      expect(asOwner.isFavorite).toBe(false);
    });

    it('should unfavorite and drop the photo from the favorites of the member', async () => {
      await setFavorite(member.accessToken, assetId, true);
      expect(await searchFavorites(member.accessToken)).toEqual([assetId]);

      const { status, body } = await setFavorite(member.accessToken, assetId, false);
      expect(status).toBe(200);
      expect(body).toMatchObject({ isFavorite: false });

      expect(await searchFavorites(member.accessToken)).toEqual([]);
      const buckets = await getFavoriteBuckets(member.accessToken);
      expect(buckets.status).toBe(200);
      expect(buckets.body).toHaveLength(0);
      const stats = await getFavoriteStats(member.accessToken);
      expect(stats.body).toMatchObject({ images: 0, videos: 0 });

      const asMember = await utils.getAssetInfo(member.accessToken, assetId);
      expect(asMember.isFavorite).toBe(false);
    });

    it('should hide the favorite when the member loses access and restore it when access is regained', async () => {
      await setFavorite(member.accessToken, assetId, true);
      expect(await searchFavorites(member.accessToken)).toEqual([assetId]);

      const removed = await request(app)
        .delete(`/albums/${albumId}/user/${member.userId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      expect(removed.status).toBe(204);

      const info = await request(app).get(`/assets/${assetId}`).set('Authorization', `Bearer ${member.accessToken}`);
      expect(info.status).toBe(400);
      expect(await searchFavorites(member.accessToken)).toEqual([]);
      const hiddenBuckets = await getFavoriteBuckets(member.accessToken);
      expect(hiddenBuckets.status).toBe(200);
      expect(hiddenBuckets.body).toHaveLength(0);
      const hiddenStats = await getFavoriteStats(member.accessToken);
      expect(hiddenStats.body).toMatchObject({ images: 0, videos: 0 });

      const added = await request(app)
        .put(`/albums/${albumId}/users`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ albumUsers: [{ userId: member.userId, role: AlbumUserRole.Viewer }] });
      expect(added.status).toBe(200);

      const restored = await utils.getAssetInfo(member.accessToken, assetId);
      expect(restored.isFavorite).toBe(true);
      expect(await searchFavorites(member.accessToken)).toEqual([assetId]);
      const restoredBuckets = await getFavoriteBuckets(member.accessToken);
      expect(restoredBuckets.body).toHaveLength(1);
      const restoredStats = await getFavoriteStats(member.accessToken);
      expect(restoredStats.body).toMatchObject({ images: 1 });
    });
  });

  describe('partners', () => {
    let partnerAssetId: string;

    beforeAll(async () => {
      const asset = await utils.createAsset(partnerOwner.accessToken);
      partnerAssetId = asset.id;
      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
    });

    it('should let a partner favorite a timeline asset without changing the state of the owner', async () => {
      const { status, body } = await setFavorite(partner.accessToken, partnerAssetId, true);
      expect(status).toBe(200);
      expect(body).toMatchObject({ id: partnerAssetId, isFavorite: true });

      const asPartner = await utils.getAssetInfo(partner.accessToken, partnerAssetId);
      const asOwner = await utils.getAssetInfo(partnerOwner.accessToken, partnerAssetId);
      expect(asPartner.isFavorite).toBe(true);
      expect(asOwner.isFavorite).toBe(false);
    });

    it('should list the partner favorite on the favorites timeline, in search and in statistics of the partner only', async () => {
      await setFavorite(partner.accessToken, partnerAssetId, true);

      const partnerBuckets = await getFavoriteBuckets(partner.accessToken);
      expect(partnerBuckets.status).toBe(200);
      expect(partnerBuckets.body).toHaveLength(1);
      expect(await searchFavorites(partner.accessToken)).toEqual([partnerAssetId]);
      const partnerStats = await getFavoriteStats(partner.accessToken);
      expect(partnerStats.status).toBe(200);
      expect(partnerStats.body).toMatchObject({ images: 1 });

      const ownerBuckets = await getFavoriteBuckets(partnerOwner.accessToken);
      expect(ownerBuckets.status).toBe(200);
      expect(ownerBuckets.body).toHaveLength(0);
      expect(await searchFavorites(partnerOwner.accessToken)).toEqual([]);
      const ownerStats = await getFavoriteStats(partnerOwner.accessToken);
      expect(ownerStats.status).toBe(200);
      expect(ownerStats.body).toMatchObject({ images: 0, videos: 0 });
    });

    it('should not let a partner change other fields', async () => {
      const { status } = await request(app)
        .put(`/assets/${partnerAssetId}`)
        .set('Authorization', `Bearer ${partner.accessToken}`)
        .send({ isFavorite: true, description: 'nope' });
      expect(status).toBe(400);

      const after = await utils.getAssetInfo(partnerOwner.accessToken, partnerAssetId);
      expect(after.exifInfo?.description ?? '').not.toBe('nope');
    });

    it('should not let a partner favorite an archived asset', async () => {
      const asset = await utils.createAsset(partnerOwner.accessToken, { visibility: AssetVisibility.Archive });

      const { status } = await setFavorite(partner.accessToken, asset.id, true);
      expect(status).toBe(400);

      // nothing was recorded for the archived asset
      expect(await searchFavorites(partner.accessToken)).not.toContain(asset.id);
    });

    it('should not let a partner favorite a locked asset', async () => {
      const asset = await utils.createAsset(partnerOwner.accessToken, { visibility: AssetVisibility.Locked });

      const { status } = await setFavorite(partner.accessToken, asset.id, true);
      expect(status).toBe(400);

      expect(await searchFavorites(partner.accessToken)).not.toContain(asset.id);
    });

    it('should not let a partner favorite a trashed asset', async () => {
      const asset = await utils.createAsset(partnerOwner.accessToken);
      await utils.deleteAssets(partnerOwner.accessToken, [asset.id]);

      const { status } = await setFavorite(partner.accessToken, asset.id, true);
      expect(status).toBe(400);
    });
  });
});
