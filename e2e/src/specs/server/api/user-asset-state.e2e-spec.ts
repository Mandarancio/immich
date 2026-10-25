import { AlbumUserRole, LoginResponseDto } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

type Query = Record<string, string | number | boolean>;
type BucketAsset = { id: string; rating: number | null; colorLabel: string | null };

const auth = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

const updateState = (accessToken: string, id: string, body: Record<string, unknown>) =>
  request(app).put(`/assets/${id}`).set(auth(accessToken)).send(body);

const updateStates = (accessToken: string, ids: string[], body: Record<string, unknown>) =>
  request(app)
    .put('/assets')
    .set(auth(accessToken))
    .send({ ids, ...body });

// all assets of the filtered timeline, with the viewer's rating and color label
const getFilteredAssets = async (accessToken: string, query: Record<string, string | number | boolean>) => {
  const buckets = await request(app).get('/timeline/buckets').query(query).set(auth(accessToken));
  expect(buckets.status).toBe(200);

  const assets: BucketAsset[] = [];
  for (const { timeBucket } of buckets.body as { timeBucket: string }[]) {
    const bucket = await request(app)
      .get('/timeline/bucket')
      .query({ ...query, timeBucket })
      .set(auth(accessToken));
    expect(bucket.status).toBe(200);
    const { id, rating, colorLabel } = bucket.body as {
      id: string[];
      rating: (number | null)[];
      colorLabel: (string | null)[];
    };
    for (const [index, assetId] of id.entries()) {
      assets.push({ id: assetId, rating: rating[index], colorLabel: colorLabel[index] });
    }
  }

  return assets;
};

describe('per-user asset state (rating and color label)', () => {
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let editor: LoginResponseDto;
  let viewer: LoginResponseDto;
  let stranger: LoginResponseDto;
  let albumId: string;

  // a fresh photo of the owner in the shared album, so tests do not depend on each other
  const createSharedAsset = async () => {
    const asset = await utils.createAsset(owner.accessToken);
    const { status } = await request(app)
      .put(`/albums/${albumId}/assets`)
      .set(auth(owner.accessToken))
      .send({ ids: [asset.id] });
    expect(status).toBe(200);
    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
    return asset.id;
  };

  const timelineQuery = (query: Record<string, string | number | boolean> = {}) => ({ albumId, ...query });

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    [owner, editor, viewer, stranger] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.create('state-owner')),
      utils.userSetup(admin.accessToken, createUserDto.create('state-editor')),
      utils.userSetup(admin.accessToken, createUserDto.create('state-viewer')),
      utils.userSetup(admin.accessToken, createUserDto.create('state-stranger')),
    ]);

    const album = await utils.createAlbum(owner.accessToken, {
      albumName: 'shared',
      albumUsers: [
        { userId: editor.userId, role: AlbumUserRole.Editor },
        { userId: viewer.userId, role: AlbumUserRole.Viewer },
      ],
    });
    albumId = album.id;
  });

  describe('album members', () => {
    for (const [name, getMember] of [
      ['editor', () => editor],
      ['viewer', () => viewer],
    ] as const) {
      it(`should let an album ${name} rate and label a photo privately`, async () => {
        const member = getMember();
        const assetId = await createSharedAsset();

        const { status, body } = await updateState(member.accessToken, assetId, { rating: 4, colorLabel: 'red' });
        expect(status).toBe(200);
        expect(body).toMatchObject({ id: assetId, colorLabel: 'red', exifInfo: { rating: 4 } });

        const asMember = await utils.getAssetInfo(member.accessToken, assetId);
        expect(asMember.colorLabel).toBe('red');
        expect(asMember.exifInfo?.rating).toBe(4);

        const asOwner = await utils.getAssetInfo(owner.accessToken, assetId);
        expect(asOwner.colorLabel ?? null).toBeNull();
        expect(asOwner.exifInfo?.rating ?? null).toBeNull();
      });
    }

    it('should filter the timeline by the rating and color label of the viewer only', async () => {
      const assetId = await createSharedAsset();
      const { status } = await updateState(viewer.accessToken, assetId, { rating: 4, colorLabel: 'red' });
      expect(status).toBe(200);

      const matching: Query[] = [{ colorLabels: 'red' }, { rating: 4 }, { rating: 3 }, { colorLabels: 'blue,red' }];
      for (const query of matching) {
        const asViewer = await getFilteredAssets(viewer.accessToken, timelineQuery(query));
        expect(asViewer).toContainEqual({ id: assetId, rating: 4, colorLabel: 'red' });

        const asOwner = await getFilteredAssets(owner.accessToken, timelineQuery(query));
        expect(asOwner.map(({ id }) => id)).not.toContain(assetId);
      }

      // too high a rating or another label does not match for the viewer
      const notMatching: Query[] = [{ rating: 5 }, { colorLabels: 'blue' }, { colorLabels: 'none' }, { unrated: true }];
      for (const query of notMatching) {
        const asViewer = await getFilteredAssets(viewer.accessToken, timelineQuery(query));
        expect(asViewer.map(({ id }) => id)).not.toContain(assetId);
      }

      // the owner and another member still see the photo as unrated and unlabeled
      for (const token of [owner.accessToken, editor.accessToken]) {
        const unlabeled = await getFilteredAssets(token, timelineQuery({ colorLabels: 'none' }));
        expect(unlabeled).toContainEqual({ id: assetId, rating: null, colorLabel: null });
        const unrated = await getFilteredAssets(token, timelineQuery({ unrated: true }));
        expect(unrated).toContainEqual({ id: assetId, rating: null, colorLabel: null });
      }
    });

    it('should find the labeled photo via album-scoped search for the labeling member only', async () => {
      const assetId = await createSharedAsset();
      await updateState(editor.accessToken, assetId, { colorLabel: 'green' });

      const search = async (accessToken: string) => {
        const { status, body } = await request(app)
          .post('/search/metadata')
          .set(auth(accessToken))
          .send({ albumIds: [albumId], colorLabels: ['green'] });
        expect(status).toBe(200);
        return (body.assets.items as { id: string }[]).map(({ id }) => id);
      };

      expect(await search(editor.accessToken)).toContain(assetId);
      expect(await search(owner.accessToken)).not.toContain(assetId);
      expect(await search(viewer.accessToken)).not.toContain(assetId);
    });

    it('should reject a rating of -1 from a non-owner', async () => {
      const assetId = await createSharedAsset();

      const { status } = await updateState(viewer.accessToken, assetId, { rating: -1 });
      expect(status).toBe(400);

      const asViewer = await utils.getAssetInfo(viewer.accessToken, assetId);
      expect(asViewer.exifInfo?.rating ?? null).toBeNull();
    });

    it('should not let a non-owner change other fields', async () => {
      const assetId = await createSharedAsset();

      const { status } = await updateState(editor.accessToken, assetId, { description: 'x' });
      expect([400, 403]).toContain(status);

      const mixed = await updateState(editor.accessToken, assetId, { rating: 3, description: 'x' });
      expect([400, 403]).toContain(mixed.status);

      const asOwner = await utils.getAssetInfo(owner.accessToken, assetId);
      expect(asOwner.exifInfo?.description ?? '').not.toBe('x');
      const asEditor = await utils.getAssetInfo(editor.accessToken, assetId);
      expect(asEditor.exifInfo?.rating ?? null).toBeNull();
    });

    it('should reject a user without access and leave the state untouched', async () => {
      const assetId = await createSharedAsset();
      await updateState(viewer.accessToken, assetId, { rating: 2, colorLabel: 'blue' });

      const { status } = await updateState(stranger.accessToken, assetId, { rating: 5, colorLabel: 'red' });
      expect(status).toBe(400);

      const bulk = await updateStates(stranger.accessToken, [assetId], { rating: 5 });
      expect(bulk.status).toBe(400);

      const asViewer = await utils.getAssetInfo(viewer.accessToken, assetId);
      expect(asViewer).toMatchObject({ colorLabel: 'blue', exifInfo: { rating: 2 } });
      const asOwner = await utils.getAssetInfo(owner.accessToken, assetId);
      expect(asOwner.exifInfo?.rating ?? null).toBeNull();
    });
  });

  describe('owner', () => {
    it('should write the rating to the asset and keep the color label private', async () => {
      const assetId = await createSharedAsset();

      const { status, body } = await updateState(owner.accessToken, assetId, { colorLabel: 'blue' });
      expect(status).toBe(200);
      expect(body).toMatchObject({ id: assetId, colorLabel: 'blue' });

      const asOwner = await utils.getAssetInfo(owner.accessToken, assetId);
      expect(asOwner.colorLabel).toBe('blue');
      const asViewer = await utils.getAssetInfo(viewer.accessToken, assetId);
      expect(asViewer.colorLabel ?? null).toBeNull();

      const bulk = await updateStates(owner.accessToken, [assetId], { rating: 2 });
      expect(bulk.status).toBe(204);

      const ratedOwner = await utils.getAssetInfo(owner.accessToken, assetId);
      expect(ratedOwner).toMatchObject({ colorLabel: 'blue', exifInfo: { rating: 2 } });

      // the owner's rating is the fallback for members without a rating of their own
      const ratedViewer = await utils.getAssetInfo(viewer.accessToken, assetId);
      expect(ratedViewer.exifInfo?.rating).toBe(2);
      expect(ratedViewer.colorLabel ?? null).toBeNull();
    });

    it('should not change the effective rating of a member who set their own', async () => {
      const assetId = await createSharedAsset();
      await updateState(editor.accessToken, assetId, { rating: 5 });

      const bulk = await updateStates(owner.accessToken, [assetId], { rating: 2 });
      expect(bulk.status).toBe(204);

      const asOwner = await utils.getAssetInfo(owner.accessToken, assetId);
      expect(asOwner.exifInfo?.rating).toBe(2);
      const asEditor = await utils.getAssetInfo(editor.accessToken, assetId);
      expect(asEditor.exifInfo?.rating).toBe(5);

      const buckets = await getFilteredAssets(editor.accessToken, timelineQuery({ rating: 5 }));
      expect(buckets).toContainEqual({ id: assetId, rating: 5, colorLabel: null });
    });

    it('should apply a bulk state update to several assets, including non-owned ones for members', async () => {
      const first = await createSharedAsset();
      const second = await createSharedAsset();

      const bulk = await updateStates(viewer.accessToken, [first, second], { rating: 3, colorLabel: 'purple' });
      expect(bulk.status).toBe(204);

      for (const id of [first, second]) {
        const asViewer = await utils.getAssetInfo(viewer.accessToken, id);
        expect(asViewer).toMatchObject({ colorLabel: 'purple', exifInfo: { rating: 3 } });
        const asOwner = await utils.getAssetInfo(owner.accessToken, id);
        expect(asOwner.colorLabel ?? null).toBeNull();
        expect(asOwner.exifInfo?.rating ?? null).toBeNull();
      }
    });
  });

  describe('clearing', () => {
    it('should fall back to the rating of the owner when a member clears their own state', async () => {
      const assetId = await createSharedAsset();
      await updateStates(owner.accessToken, [assetId], { rating: 3 });
      await updateState(editor.accessToken, assetId, { rating: 5, colorLabel: 'yellow' });

      const before = await utils.getAssetInfo(editor.accessToken, assetId);
      expect(before).toMatchObject({ colorLabel: 'yellow', exifInfo: { rating: 5 } });

      const { status, body } = await updateState(editor.accessToken, assetId, { rating: null, colorLabel: null });
      expect(status).toBe(200);
      expect(body.colorLabel ?? null).toBeNull();
      expect(body.exifInfo?.rating).toBe(3);

      const after = await utils.getAssetInfo(editor.accessToken, assetId);
      expect(after.colorLabel ?? null).toBeNull();
      expect(after.exifInfo?.rating).toBe(3);

      // and the timeline reflects the fallback
      const buckets = await getFilteredAssets(editor.accessToken, timelineQuery({ rating: 3 }));
      expect(buckets).toContainEqual({ id: assetId, rating: 3, colorLabel: null });
    });

    it('should leave the owner state untouched when a member clears theirs', async () => {
      const assetId = await createSharedAsset();
      await updateState(owner.accessToken, assetId, { colorLabel: 'red' });
      await updateState(viewer.accessToken, assetId, { rating: 4, colorLabel: 'green' });

      const { status } = await updateState(viewer.accessToken, assetId, { rating: null, colorLabel: null });
      expect(status).toBe(200);

      const asOwner = await utils.getAssetInfo(owner.accessToken, assetId);
      expect(asOwner.colorLabel).toBe('red');
      const asViewer = await utils.getAssetInfo(viewer.accessToken, assetId);
      expect(asViewer.colorLabel ?? null).toBeNull();
      expect(asViewer.exifInfo?.rating ?? null).toBeNull();
    });
  });
});
