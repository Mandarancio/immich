import { AlbumUserRole, LoginResponseDto, SharedLinkType } from '@immich/sdk';
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

const flagOf = async (accessToken: string, assetId: string) => {
  const asset = await utils.getAssetInfo(accessToken, assetId);
  return asset.flag ?? null;
};

// all assets of the filtered timeline, with the flag of the viewer
const getFlaggedAssets = async (accessToken: string, query: Query) => {
  const buckets = await request(app).get('/timeline/buckets').query(query).set(auth(accessToken));
  expect(buckets.status).toBe(200);

  const assets: Array<{ id: string; flag: string | null }> = [];
  for (const { timeBucket } of buckets.body as { timeBucket: string }[]) {
    const bucket = await request(app)
      .get('/timeline/bucket')
      .query({ ...query, timeBucket })
      .set(auth(accessToken));
    expect(bucket.status).toBe(200);
    const { id, flag } = bucket.body as { id: string[]; flag: (string | null)[] };
    for (const [index, assetId] of id.entries()) {
      assets.push({ id: assetId, flag: flag[index] });
    }
  }

  return assets;
};

describe('per-user asset state (pick/reject flag)', () => {
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let editor: LoginResponseDto;
  let viewer: LoginResponseDto;
  let stranger: LoginResponseDto;
  let albumId: string;

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

  const timelineQuery = (query: Query = {}) => ({ albumId, ...query });

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    [owner, editor, viewer, stranger] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.create('flag-owner')),
      utils.userSetup(admin.accessToken, createUserDto.create('flag-editor')),
      utils.userSetup(admin.accessToken, createUserDto.create('flag-viewer')),
      utils.userSetup(admin.accessToken, createUserDto.create('flag-stranger')),
    ]);

    const album = await utils.createAlbum(owner.accessToken, {
      albumName: 'shared flags',
      albumUsers: [
        { userId: editor.userId, role: AlbumUserRole.Editor },
        { userId: viewer.userId, role: AlbumUserRole.Viewer },
      ],
    });
    albumId = album.id;
  });

  it('should let the owner pick, reject, overwrite and clear a flag', async () => {
    const assetId = await createSharedAsset();

    const picked = await updateState(owner.accessToken, assetId, { flag: 'pick' });
    expect(picked.status).toBe(200);
    expect(picked.body).toMatchObject({ id: assetId, flag: 'pick' });
    expect(await flagOf(owner.accessToken, assetId)).toBe('pick');

    // pick and reject are mutually exclusive, the last write wins
    const rejected = await updateState(owner.accessToken, assetId, { flag: 'reject' });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ flag: 'reject' });
    expect(await flagOf(owner.accessToken, assetId)).toBe('reject');

    const cleared = await updateState(owner.accessToken, assetId, { flag: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.flag ?? null).toBeNull();
    expect(await flagOf(owner.accessToken, assetId)).toBeNull();
  });

  it('should set the flag of several assets with a bulk update', async () => {
    const first = await createSharedAsset();
    const second = await createSharedAsset();

    const bulk = await updateStates(owner.accessToken, [first, second], { flag: 'pick' });
    expect(bulk.status).toBe(204);
    for (const id of [first, second]) {
      expect(await flagOf(owner.accessToken, id)).toBe('pick');
    }

    const overwritten = await updateStates(owner.accessToken, [first, second], { flag: 'reject' });
    expect(overwritten.status).toBe(204);
    for (const id of [first, second]) {
      expect(await flagOf(owner.accessToken, id)).toBe('reject');
    }

    const cleared = await updateStates(owner.accessToken, [first, second], { flag: null });
    expect(cleared.status).toBe(204);
    for (const id of [first, second]) {
      expect(await flagOf(owner.accessToken, id)).toBeNull();
    }
  });

  for (const [name, getMember] of [
    ['editor', () => editor],
    ['viewer', () => viewer],
  ] as const) {
    it(`should let an album ${name} flag a shared photo without affecting the owner`, async () => {
      const member = getMember();
      const assetId = await createSharedAsset();
      await updateState(owner.accessToken, assetId, { flag: 'reject' });

      const { status, body } = await updateState(member.accessToken, assetId, { flag: 'pick' });
      expect(status).toBe(200);
      expect(body).toMatchObject({ id: assetId, flag: 'pick' });

      expect(await flagOf(member.accessToken, assetId)).toBe('pick');
      expect(await flagOf(owner.accessToken, assetId)).toBe('reject');

      // clearing the flag of the member leaves the owner flag alone
      const cleared = await updateState(member.accessToken, assetId, { flag: null });
      expect(cleared.status).toBe(200);
      expect(await flagOf(member.accessToken, assetId)).toBeNull();
      expect(await flagOf(owner.accessToken, assetId)).toBe('reject');
    });
  }

  it('should reject a user without access and leave the flag untouched', async () => {
    const assetId = await createSharedAsset();
    await updateState(viewer.accessToken, assetId, { flag: 'pick' });

    const { status } = await updateState(stranger.accessToken, assetId, { flag: 'reject' });
    expect(status).toBe(400);
    const bulk = await updateStates(stranger.accessToken, [assetId], { flag: 'reject' });
    expect(bulk.status).toBe(400);

    expect(await flagOf(viewer.accessToken, assetId)).toBe('pick');
    expect(await flagOf(owner.accessToken, assetId)).toBeNull();
  });

  it('should reject an unknown flag value', async () => {
    const assetId = await createSharedAsset();
    const { status } = await updateState(owner.accessToken, assetId, { flag: 'maybe' });
    expect(status).toBe(400);
  });

  it('should filter the timeline by the flag of the viewer only', async () => {
    const assetId = await createSharedAsset();
    const { status } = await updateState(viewer.accessToken, assetId, { flag: 'pick' });
    expect(status).toBe(200);

    for (const flags of ['pick', 'pick,reject', 'none,pick']) {
      const asViewer = await getFlaggedAssets(viewer.accessToken, timelineQuery({ flags }));
      expect(asViewer).toContainEqual({ id: assetId, flag: 'pick' });

      // the owner has not flagged the photo, so only a filter including none matches
      const asOwner = await getFlaggedAssets(owner.accessToken, timelineQuery({ flags }));
      if (flags.includes('none')) {
        expect(asOwner).toContainEqual({ id: assetId, flag: null });
      } else {
        expect(asOwner.map(({ id }) => id)).not.toContain(assetId);
      }
    }

    for (const flags of ['reject', 'none']) {
      const asViewer = await getFlaggedAssets(viewer.accessToken, timelineQuery({ flags }));
      expect(asViewer.map(({ id }) => id)).not.toContain(assetId);
    }

    const unflaggedForOthers = await getFlaggedAssets(editor.accessToken, timelineQuery({ flags: 'none' }));
    expect(unflaggedForOthers).toContainEqual({ id: assetId, flag: null });
  });

  it('should find the flagged photo via album-scoped search for the flagging member only', async () => {
    const assetId = await createSharedAsset();
    await updateState(editor.accessToken, assetId, { flag: 'reject' });

    const search = async (accessToken: string, flags: string[]) => {
      const { status, body } = await request(app)
        .post('/search/metadata')
        .set(auth(accessToken))
        .send({ albumIds: [albumId], flags });
      expect(status).toBe(200);
      return (body.assets.items as { id: string }[]).map(({ id }) => id);
    };

    expect(await search(editor.accessToken, ['reject'])).toContain(assetId);
    expect(await search(editor.accessToken, ['pick'])).not.toContain(assetId);
    expect(await search(owner.accessToken, ['reject'])).not.toContain(assetId);
    expect(await search(owner.accessToken, ['none'])).toContain(assetId);
    expect(await search(viewer.accessToken, ['reject'])).not.toContain(assetId);
  });

  it('should not let a shared link set or see a flag', async () => {
    const assetId = await createSharedAsset();
    await updateState(owner.accessToken, assetId, { flag: 'pick' });
    const link = await utils.createSharedLink(owner.accessToken, { type: SharedLinkType.Album, albumId });

    const { status } = await request(app).put(`/assets/${assetId}?key=${link.key}`).send({ flag: 'reject' });
    expect([401, 403]).toContain(status);
    expect(await flagOf(owner.accessToken, assetId)).toBe('pick');

    // the personal flag of the link creator never leaks through the link
    const info = await request(app).get(`/assets/${assetId}?key=${link.key}`);
    expect(info.status).toBe(200);
    expect(info.body.flag ?? null).toBeNull();
  });
});
