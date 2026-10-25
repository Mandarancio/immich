import { AlbumUserRole, LoginResponseDto } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

describe('shared favorites', () => {
  let owner: LoginResponseDto;
  let member: LoginResponseDto;
  let stranger: LoginResponseDto;
  let assetId: string;

  beforeAll(async () => {
    await utils.resetDatabase();
    const admin = await utils.adminSetup({ onboarding: false });
    [owner, member, stranger] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.create('fav-owner')),
      utils.userSetup(admin.accessToken, createUserDto.create('fav-member')),
      utils.userSetup(admin.accessToken, createUserDto.create('fav-stranger')),
    ]);

    const asset = await utils.createAsset(owner.accessToken);
    assetId = asset.id;
    await utils.createAlbum(owner.accessToken, {
      albumName: 'shared',
      assetIds: [assetId],
      albumUsers: [{ userId: member.userId, role: AlbumUserRole.Viewer }],
    });
    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
  });

  it('should let an album viewer favorite a photo and see it as a favorite only for themselves', async () => {
    const { status, body } = await request(app)
      .put(`/assets/${assetId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ isFavorite: true });
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: assetId, isFavorite: true });

    const asMember = await utils.getAssetInfo(member.accessToken, assetId);
    const asOwner = await utils.getAssetInfo(owner.accessToken, assetId);
    expect(asMember.isFavorite).toBe(true);
    expect(asOwner.isFavorite).toBe(false);
  });

  it('should list the favorite on the favorites timeline and in statistics of the member only', async () => {
    const memberBuckets = await request(app)
      .get('/timeline/buckets')
      .query({ isFavorite: true })
      .set('Authorization', `Bearer ${member.accessToken}`);
    expect(memberBuckets.status).toBe(200);
    expect(memberBuckets.body).toHaveLength(1);

    const ownerBuckets = await request(app)
      .get('/timeline/buckets')
      .query({ isFavorite: true })
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(ownerBuckets.body).toHaveLength(0);

    const stats = await request(app)
      .get('/assets/statistics')
      .query({ isFavorite: true })
      .set('Authorization', `Bearer ${member.accessToken}`);
    expect(stats.body).toMatchObject({ images: 1 });
  });

  it('should find the favorite via search for the member', async () => {
    const { status, body } = await request(app)
      .post('/search/metadata')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ isFavorite: true });
    expect(status).toBe(200);
    expect(body.assets.items.map(({ id }: { id: string }) => id)).toEqual([assetId]);
  });

  it('should not let a non-owner change other fields', async () => {
    const { status } = await request(app)
      .put(`/assets/${assetId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ isFavorite: true, description: 'nope' });
    expect(status).toBe(400);
  });

  it('should reject a user without access', async () => {
    const { status } = await request(app)
      .put(`/assets/${assetId}`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .send({ isFavorite: true });
    expect(status).toBe(400);
  });

  it('should unfavorite', async () => {
    const { status, body } = await request(app)
      .put(`/assets/${assetId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ isFavorite: false });
    expect(status).toBe(200);
    expect(body).toMatchObject({ isFavorite: false });
  });
});
