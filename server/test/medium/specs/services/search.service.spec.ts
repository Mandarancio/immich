import { Kysely } from 'kysely';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { MetadataSearchDto, SearchSuggestionType } from 'src/dtos/search.dto.js';
import {
  AlbumUserRole,
  AssetColorLabel,
  AssetFlag,
  AssetOrder,
  AssetVisibility,
  SearchOrderField,
  SharedLinkType,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { DB } from 'src/schema/index.js';
import { SearchService } from 'src/services/search.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const unitVector = (index: number) => JSON.stringify(Array.from({ length: 512 }, (_, i) => (i === index ? 1 : 0)));

const setup = (db?: Kysely<DB>) => {
  return newMediumService(SearchService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AssetRepository,
      DatabaseRepository,
      SearchRepository,
      PartnerRepository,
      PersonRepository,
      SharedLinkRepository,
    ],
    mock: [LoggingRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const setupShared = async () => {
  const { sut, ctx } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: member } = await ctx.newUser();
  // rated 1 by the owner (exif); the member rates it 4 and labels it red, the owner labels it blue
  const { asset } = await ctx.newAsset({ ownerId: owner.id });
  await ctx.newExif({ assetId: asset.id, rating: 1 });
  // only the member rates and labels this one
  const { asset: plain } = await ctx.newAsset({ ownerId: owner.id });
  await ctx.newExif({ assetId: plain.id, rating: 2 });
  const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id, plain.id]);
  await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });
  const assets = ctx.get(AssetRepository);
  await assets.setUserState(member.id, [asset.id], {
    rating: 4,
    colorLabel: AssetColorLabel.Red,
    flag: AssetFlag.Pick,
  });
  await assets.setUserState(owner.id, [asset.id], { colorLabel: AssetColorLabel.Blue, flag: AssetFlag.Reject });
  // an album shared link created by the member, who has a personal rating and color on `asset`
  const { id: sharedLinkId } = await ctx.get(SharedLinkRepository).create({
    allowUpload: false,
    key: Buffer.from(`search-${member.id}`),
    type: SharedLinkType.Album,
    userId: member.id,
    albumId: album.id,
  });
  const link = factory.auth({ user: member, sharedLink: { id: sharedLinkId, showExif: true } });
  return {
    sut,
    owner: factory.auth({ user: owner }),
    member: factory.auth({ user: member }),
    link,
    asset,
    plain,
    album,
  };
};

const setupLiked = async () => {
  const { sut, ctx } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: member } = await ctx.newUser();
  const { user: outsider } = await ctx.newUser();
  const { asset: likedByMember } = await ctx.newAsset({ ownerId: owner.id });
  const { asset: likedByOwner } = await ctx.newAsset({ ownerId: owner.id });
  const { asset: plain } = await ctx.newAsset({ ownerId: owner.id });
  // owned by the viewer, but only liked in an album the viewer is not part of
  const { asset: foreignLike } = await ctx.newAsset({ ownerId: owner.id });
  const { album } = await ctx.newAlbum({ ownerId: owner.id }, [likedByMember.id, likedByOwner.id, plain.id]);
  await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });
  const { album: foreignAlbum } = await ctx.newAlbum({ ownerId: outsider.id }, [foreignLike.id]);

  const like = (userId: string, albumId: string, assetId: string) =>
    ctx.database.insertInto('activity').values({ userId, albumId, assetId, isLiked: true }).execute();
  await like(member.id, album.id, likedByMember.id);
  await like(owner.id, album.id, likedByOwner.id);
  await like(outsider.id, foreignAlbum.id, foreignLike.id);

  const { id: sharedLinkId } = await ctx.get(SharedLinkRepository).create({
    allowUpload: false,
    key: Buffer.from(`liked-${member.id}`),
    type: SharedLinkType.Album,
    userId: member.id,
    albumId: album.id,
  });

  return {
    sut,
    owner: factory.auth({ user: owner }),
    member: factory.auth({ user: member }),
    outsider: factory.auth({ user: outsider }),
    link: factory.auth({ user: member, sharedLink: { id: sharedLinkId, showExif: true } }),
    album,
    likedByMember,
    likedByOwner,
    plain,
    foreignLike,
  };
};

const sorted = (values: string[]) => values.toSorted();

const ids = (response: { assets: { items: Array<{ id: string }> } }) => response.assets.items.map(({ id }) => id);

const searchIds = async (sut: SearchService, auth: AuthDto, dto: MetadataSearchDto) =>
  ids(await sut.searchMetadata(auth, dto));

describe(SearchService.name, () => {
  it('should work', () => {
    const { sut } = setup();
    expect(sut).toBeDefined();
  });

  it('should find a favorited shared-album asset with the legacy isFavorite filter', async () => {
    const { sut, ctx } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: member } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    await ctx.newExif({ assetId: asset.id, make: 'Canon' });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
    await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });
    await ctx.get(AssetRepository).setUserState(member.id, [asset.id], { isFavorite: true });

    const asMember = await sut.searchMetadata(factory.auth({ user: member }), { size: 250, isFavorite: true });
    expect(asMember.assets.items.map(({ id }) => id)).toEqual([asset.id]);
    expect(asMember.assets.items[0].isFavorite).toBe(true);

    const asOwner = await sut.searchMetadata(factory.auth({ user: owner }), { size: 250, isFavorite: true });
    expect(asOwner.assets.items).toHaveLength(0);

    const unfavorited = await sut.searchMetadata(factory.auth({ user: member }), { size: 250, isFavorite: false });
    expect(unfavorited.assets.items).toHaveLength(0);
  });

  it('should return assets', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();

    const assets = [];
    const sizes = [12_334, 599, 123_456];

    for (let i = 0; i < sizes.length; i++) {
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: sizes[i] });
      assets.push(asset);
    }

    const auth = factory.auth({ user: { id: user.id } });

    await expect(sut.searchLargeAssets(auth, { size: 250 })).resolves.toEqual([
      expect.objectContaining({ id: assets[2].id }),
      expect.objectContaining({ id: assets[0].id }),
      expect.objectContaining({ id: assets[1].id }),
    ]);
  });

  it('should not return hidden assets', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();

    const { asset: visibleAsset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newExif({ assetId: visibleAsset.id, fileSizeInByte: 1000 });
    const { asset: hiddenAsset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Hidden });
    await ctx.newExif({ assetId: hiddenAsset.id, fileSizeInByte: 2000 });

    const auth = factory.auth({ user: { id: user.id } });

    await expect(sut.searchLargeAssets(auth, { size: 250 })).resolves.toEqual([
      expect.objectContaining({ id: visibleAsset.id }),
    ]);
  });

  describe('searchStatistics', () => {
    it('should return statistics when filtering by personIds', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      const auth = factory.auth({ user: { id: user.id } });

      const result = await sut.searchStatistics(auth, { personIds: [person.personGroupId] });

      expect(result).toEqual({ total: 1 });
    });

    it('should return zero when no assets match the personIds filter', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });

      const auth = factory.auth({ user: { id: user.id } });

      const result = await sut.searchStatistics(auth, { personIds: [person.personGroupId] });

      expect(result).toEqual({ total: 0 });
    });

    it('should not return locked assets of partner in elevated session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();

      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

      await ctx.newAsset({ ownerId: partner.id, visibility: AssetVisibility.Locked });

      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

      const result = await sut.searchStatistics(auth, { visibility: AssetVisibility.Locked });

      expect(result).toEqual({ total: 0 });
    });

    it('should not return locked assets of partner in elevated session without a visibility filter', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();

      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

      await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      await ctx.newAsset({ ownerId: partner.id, visibility: AssetVisibility.Locked });
      await ctx.newAsset({ ownerId: partner.id });

      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

      await expect(sut.searchStatistics(auth, {})).resolves.toEqual({ total: 2 });

      const response = await sut.searchMetadata(auth, { size: 250, withStacked: false });
      expect(response.assets.items.map(({ ownerId, visibility }) => ({ ownerId, visibility }))).toEqual(
        expect.arrayContaining([
          { ownerId: user.id, visibility: AssetVisibility.Locked },
          { ownerId: partner.id, visibility: AssetVisibility.Timeline },
        ]),
      );
      expect(response.assets.items).toHaveLength(2);
    });
  });

  describe('withStacked option', () => {
    it('should exclude stacked assets when withStacked is false', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      const { asset: primaryAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: stackedAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: unstackedAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newStack({ ownerId: user.id }, [primaryAsset.id, stackedAsset.id]);

      const auth = factory.auth({ user: { id: user.id } });

      const response = await sut.searchMetadata(auth, { size: 250, withStacked: false });

      expect(response.assets.items.length).toBe(1);
      expect(response.assets.items[0].id).toBe(unstackedAsset.id);
    });

    describe('visibility', () => {
      it('should filter out locked assets in a default session', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();

        await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

        const auth = factory.auth({ user: { id: user.id } });

        const response = await sut.searchMetadata(auth, { size: 250, withStacked: false });

        expect(response.assets.items.length).toBe(0);
      });

      it('should return locked assets in an elevated session', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();

        await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

        const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

        const response = await sut.searchMetadata(auth, { size: 250, withStacked: false });

        expect(response.assets.items.length).toBe(1);
      });
    });
  });

  describe('viewer-aware rating and color label', () => {
    describe('legacy', () => {
      it('should match the rating of the viewer, not the exif rating, for a member', async () => {
        const { sut, member, asset, album } = await setupShared();
        expect(await searchIds(sut, member, { size: 250, albumIds: [album.id], rating: 4 })).toEqual([asset.id]);
        expect(await searchIds(sut, member, { size: 250, albumIds: [album.id], rating: 1 })).toEqual([]);
      });

      it('should still match the exif rating for the owner', async () => {
        const { sut, owner, asset, album } = await setupShared();
        expect(await searchIds(sut, owner, { size: 250, albumIds: [album.id], rating: 1 })).toEqual([asset.id]);
        expect(await searchIds(sut, owner, { size: 250, albumIds: [album.id], rating: 4 })).toEqual([]);
      });

      it('should fall back to the exif rating for a member without an own rating', async () => {
        const { sut, member, plain, album } = await setupShared();
        expect(await searchIds(sut, member, { size: 250, albumIds: [album.id], rating: 2 })).toEqual([plain.id]);
      });

      it('should filter by the color labels of the viewer only', async () => {
        const { sut, owner, member, asset, plain, album } = await setupShared();
        const search = (auth: typeof member, colorLabels: Array<AssetColorLabel | 'none'>) =>
          sut.searchMetadata(auth, { size: 250, albumIds: [album.id], colorLabels }).then((response) => ids(response));

        expect(await search(member, [AssetColorLabel.Red])).toEqual([asset.id]);
        expect(await search(owner, [AssetColorLabel.Red])).toEqual([]);
        expect(await search(owner, [AssetColorLabel.Blue])).toEqual([asset.id]);
        expect(await search(member, [AssetColorLabel.Blue])).toEqual([]);
        expect(await search(member, ['none'])).toEqual([plain.id]);
        const both = await search(member, ['none', AssetColorLabel.Red]);
        expect(both.sort()).toEqual([asset.id, plain.id].sort());
      });

      it('should not leak the personal rating and color of the link creator through a shared link', async () => {
        const { sut, link, asset, plain, album } = await setupShared();
        const base = { size: 250, albumIds: [album.id] };
        // the creator rated `asset` 4 and labeled it red; the shared link only sees the exif rating (1)
        expect(await searchIds(sut, link, { ...base, rating: 4 })).toEqual([]);
        expect(await searchIds(sut, link, { ...base, rating: 1 })).toEqual([asset.id]);
        expect(await searchIds(sut, link, { ...base, colorLabels: [AssetColorLabel.Red] })).toEqual([]);
        const none = await searchIds(sut, link, { ...base, colorLabels: ['none'] });
        expect(none.sort()).toEqual([asset.id, plain.id].sort());
      });
    });

    describe('new shape', () => {
      it('should match the rating of the viewer, not the exif rating, for a member', async () => {
        const { sut, member, asset, album } = await setupShared();
        const filter = (eq: number) => ({ albumIds: { any: [album.id] }, rating: { eq } });
        expect(await searchIds(sut, member, { size: 250, filter: filter(4) })).toEqual([asset.id]);
        expect(await searchIds(sut, member, { size: 250, filter: filter(1) })).toEqual([]);
      });

      it('should still match the exif rating for the owner', async () => {
        const { sut, owner, asset, album } = await setupShared();
        const response = await sut.searchMetadata(owner, {
          size: 250,
          filter: { albumIds: { any: [album.id] }, rating: { lte: 1 } },
        });
        expect(ids(response)).toEqual([asset.id]);
      });

      it('should filter by the color labels of the viewer only', async () => {
        const { sut, owner, member, asset, plain, album } = await setupShared();
        const search = (auth: typeof member, colorLabels: Array<AssetColorLabel | 'none'>) =>
          sut
            .searchMetadata(auth, { size: 250, filter: { albumIds: { any: [album.id] }, colorLabels } })
            .then((response) => ids(response));

        expect(await search(member, [AssetColorLabel.Red])).toEqual([asset.id]);
        expect(await search(owner, [AssetColorLabel.Red])).toEqual([]);
        expect(await search(owner, [AssetColorLabel.Blue])).toEqual([asset.id]);
        expect(await search(member, ['none'])).toEqual([plain.id]);
      });

      it('should not leak the personal rating and color of the link creator through a shared link', async () => {
        const { sut, link, asset, plain, album } = await setupShared();
        const albumIds = { any: [album.id] };
        const search = (filter: object) => searchIds(sut, link, { size: 250, filter: { albumIds, ...filter } });
        expect(await search({ rating: { eq: 4 } })).toEqual([]);
        expect(await search({ rating: { eq: 1 } })).toEqual([asset.id]);
        expect(await search({ colorLabels: [AssetColorLabel.Red] })).toEqual([]);
        const none = await search({ colorLabels: ['none'] });
        expect(none.sort()).toEqual([asset.id, plain.id].sort());
        expect(await search({ or: [{ colorLabels: [AssetColorLabel.Red] }] })).toEqual([]);
      });

      it('should apply colorLabels inside an or branch', async () => {
        const { sut, member, asset, album } = await setupShared();
        const response = await sut.searchMetadata(member, {
          size: 250,
          filter: {
            albumIds: { any: [album.id] },
            or: [{ colorLabels: [AssetColorLabel.Red] }],
          },
        });
        expect(ids(response)).toEqual([asset.id]);
      });
    });
  });

  describe('viewer flags', () => {
    describe('legacy', () => {
      it('should filter by the flags of the viewer only', async () => {
        const { sut, owner, member, asset, plain, album } = await setupShared();
        const search = (auth: typeof member, flags: Array<AssetFlag | 'none'>) =>
          sut.searchMetadata(auth, { size: 250, albumIds: [album.id], flags }).then((response) => ids(response));

        expect(await search(member, [AssetFlag.Pick])).toEqual([asset.id]);
        expect(await search(owner, [AssetFlag.Pick])).toEqual([]);
        expect(await search(owner, [AssetFlag.Reject])).toEqual([asset.id]);
        expect(await search(member, [AssetFlag.Reject])).toEqual([]);
        expect(await search(member, ['none'])).toEqual([plain.id]);
        const both = await search(member, ['none', AssetFlag.Pick]);
        expect(both.sort()).toEqual([asset.id, plain.id].sort());
      });

      it('should not leak the personal flag of the link creator through a shared link', async () => {
        const { sut, link, asset, plain, album } = await setupShared();
        const base = { size: 250, albumIds: [album.id] };
        expect(await searchIds(sut, link, { ...base, flags: [AssetFlag.Pick] })).toEqual([]);
        const none = await searchIds(sut, link, { ...base, flags: ['none'] });
        expect(none.sort()).toEqual([asset.id, plain.id].sort());
      });
    });

    describe('new shape', () => {
      it('should filter by the flags of the viewer only', async () => {
        const { sut, owner, member, asset, plain, album } = await setupShared();
        const search = (auth: typeof member, flags: Array<AssetFlag | 'none'>) =>
          sut
            .searchMetadata(auth, { size: 250, filter: { albumIds: { any: [album.id] }, flags } })
            .then((response) => ids(response));

        expect(await search(member, [AssetFlag.Pick])).toEqual([asset.id]);
        expect(await search(owner, [AssetFlag.Pick])).toEqual([]);
        expect(await search(owner, [AssetFlag.Reject])).toEqual([asset.id]);
        expect(await search(member, ['none'])).toEqual([plain.id]);
      });

      it('should not leak the personal flag of the link creator through a shared link', async () => {
        const { sut, link, asset, plain, album } = await setupShared();
        const albumIds = { any: [album.id] };
        const search = (filter: object) => searchIds(sut, link, { size: 250, filter: { albumIds, ...filter } });
        expect(await search({ flags: [AssetFlag.Pick] })).toEqual([]);
        const none = await search({ flags: ['none'] });
        expect(none.sort()).toEqual([asset.id, plain.id].sort());
        expect(await search({ or: [{ flags: [AssetFlag.Pick] }] })).toEqual([]);
      });

      it('should apply flags inside an or branch', async () => {
        const { sut, member, asset, album } = await setupShared();
        const response = await sut.searchMetadata(member, {
          size: 250,
          filter: {
            albumIds: { any: [album.id] },
            or: [{ flags: [AssetFlag.Pick] }],
          },
        });
        expect(ids(response)).toEqual([asset.id]);
      });
    });
  });

  describe('liked filters', () => {
    describe('legacy', () => {
      it('should find assets liked by any user in an accessible album', async () => {
        const { sut, owner, member, album, likedByMember, likedByOwner, plain } = await setupLiked();
        const search = (auth: AuthDto, isLiked: boolean) =>
          searchIds(sut, auth, { size: 250, albumIds: [album.id], isLiked });

        expect(sorted(await search(owner, true))).toEqual(sorted([likedByMember.id, likedByOwner.id]));
        expect(await search(owner, false)).toEqual([plain.id]);
        expect(sorted(await search(member, true))).toEqual(sorted([likedByMember.id, likedByOwner.id]));
      });

      it('should find assets liked by the viewer only', async () => {
        const { sut, owner, member, album, likedByMember, likedByOwner, plain } = await setupLiked();
        const search = (auth: AuthDto, isLikedByMe: boolean) =>
          searchIds(sut, auth, { size: 250, albumIds: [album.id], isLikedByMe });

        expect(await search(owner, true)).toEqual([likedByOwner.id]);
        expect(sorted(await search(owner, false))).toEqual(sorted([likedByMember.id, plain.id]));
        expect(await search(member, true)).toEqual([likedByMember.id]);
        expect(sorted(await search(member, false))).toEqual(sorted([likedByOwner.id, plain.id]));
      });

      it('should combine isLiked and isLikedByMe', async () => {
        const { sut, owner, album, likedByMember } = await setupLiked();
        const result = await searchIds(sut, owner, {
          size: 250,
          albumIds: [album.id],
          isLiked: true,
          isLikedByMe: false,
        });
        expect(result).toEqual([likedByMember.id]);
      });

      it('should not count a like in an album the viewer cannot access', async () => {
        const { sut, owner, likedByMember, likedByOwner, plain, foreignLike } = await setupLiked();
        const liked = await searchIds(sut, owner, { size: 250, isLiked: true });
        expect(sorted(liked)).toEqual(sorted([likedByMember.id, likedByOwner.id]));
        expect(liked).not.toContain(foreignLike.id);

        const notLiked = await searchIds(sut, owner, { size: 250, isLiked: false });
        expect(sorted(notLiked)).toEqual(sorted([plain.id, foreignLike.id]));
      });

      it('should not count a like in a deleted album', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
        await ctx.database
          .insertInto('activity')
          .values({ userId: user.id, albumId: album.id, assetId: asset.id, isLiked: true })
          .execute();
        const auth = factory.auth({ user });
        expect(await searchIds(sut, auth, { size: 250, isLiked: true })).toEqual([asset.id]);

        await ctx.softDeleteAlbum(album.id);
        expect(await searchIds(sut, auth, { size: 250, isLiked: true })).toEqual([]);
      });

      it('should not evaluate the likes of the link creator through a shared link', async () => {
        const { sut, link, album, likedByMember, likedByOwner, plain } = await setupLiked();
        const base = { size: 250, albumIds: [album.id] };
        const all = sorted([likedByMember.id, likedByOwner.id, plain.id]);

        expect(await searchIds(sut, link, { ...base, isLiked: true })).toEqual([]);
        expect(await searchIds(sut, link, { ...base, isLikedByMe: true })).toEqual([]);
        expect(sorted(await searchIds(sut, link, { ...base, isLiked: false }))).toEqual(all);
        expect(sorted(await searchIds(sut, link, { ...base, isLikedByMe: false }))).toEqual(all);
      });
    });

    describe('new shape', () => {
      it('should filter by isLiked and isLikedByMe', async () => {
        const { sut, owner, member, album, likedByMember, likedByOwner, plain } = await setupLiked();
        const albumIds = { any: [album.id] };
        const search = (auth: AuthDto, filter: object) =>
          searchIds(sut, auth, { size: 250, filter: { albumIds, ...filter } });

        expect(sorted(await search(owner, { isLiked: { eq: true } }))).toEqual(
          sorted([likedByMember.id, likedByOwner.id]),
        );
        expect(await search(owner, { isLiked: { eq: false } })).toEqual([plain.id]);
        expect(await search(owner, { isLikedByMe: { eq: true } })).toEqual([likedByOwner.id]);
        expect(await search(member, { isLikedByMe: { eq: true } })).toEqual([likedByMember.id]);
        expect(sorted(await search(member, { isLikedByMe: { eq: false } }))).toEqual(
          sorted([likedByOwner.id, plain.id]),
        );
      });

      it('should apply the liked filters inside an or branch', async () => {
        const { sut, owner, album, likedByMember, likedByOwner } = await setupLiked();
        const filter = { albumIds: { any: [album.id] } };
        expect(
          await searchIds(sut, owner, { size: 250, filter: { ...filter, or: [{ isLikedByMe: { eq: true } }] } }),
        ).toEqual([likedByOwner.id]);
        expect(
          await searchIds(sut, owner, {
            size: 250,
            filter: { ...filter, or: [{ isLiked: { eq: true }, isLikedByMe: { eq: false } }] },
          }),
        ).toEqual([likedByMember.id]);
      });

      it('should not count a like in an album the viewer cannot access', async () => {
        const { sut, owner, foreignLike } = await setupLiked();
        const liked = await searchIds(sut, owner, { size: 250, filter: { isLiked: { eq: true } } });
        expect(liked).not.toContain(foreignLike.id);
        const notLiked = await searchIds(sut, owner, { size: 250, filter: { isLiked: { eq: false } } });
        expect(notLiked).toContain(foreignLike.id);
      });

      it('should not evaluate the likes of the link creator through a shared link', async () => {
        const { sut, link, album, likedByMember, likedByOwner, plain } = await setupLiked();
        const albumIds = { any: [album.id] };
        const search = (filter: object) => searchIds(sut, link, { size: 250, filter: { albumIds, ...filter } });
        const all = sorted([likedByMember.id, likedByOwner.id, plain.id]);

        expect(await search({ isLiked: { eq: true } })).toEqual([]);
        expect(await search({ isLikedByMe: { eq: true } })).toEqual([]);
        expect(sorted(await search({ isLiked: { eq: false } }))).toEqual(all);
        expect(sorted(await search({ isLikedByMe: { eq: false } }))).toEqual(all);
        expect(await search({ or: [{ isLikedByMe: { eq: true } }] })).toEqual([]);
      });
    });
  });

  describe('albumIds option', () => {
    it('should return assets from shared album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: otherUser.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: user.id, role: AlbumUserRole.Editor });

      const auth = factory.auth({ user: { id: user.id } });

      const response = await sut.searchMetadata(auth, { size: 250, albumIds: [album.id] });

      expect(response.assets.items.length).toBe(1);
    });

    it('should not return assets for album, a user is not in, when partner sharing is enabled', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();

      await ctx.newPartner({ sharedById: otherUser.id, sharedWithId: user.id });

      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: otherUser.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      const auth = factory.auth({ user: { id: user.id } });

      await expect(sut.searchMetadata(auth, { size: 250, albumIds: [album.id] })).rejects.toThrow(
        'Not found or no album.read access',
      );
    });
  });

  describe('getSearchSuggestions', () => {
    it('should filter out empty search suggestions', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const { asset: assetWithEmptyMake } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: assetWithEmptyMake.id, make: '' });

      const auth = factory.auth({ user: { id: user.id } });
      const suggestions = await sut.getSearchSuggestions(auth, {
        type: SearchSuggestionType.CAMERA_MAKE,
        includeNull: true,
      });

      expect(suggestions).toEqual(['Canon', null]);
    });
  });

  describe('searchRandom', () => {
    it('should filter out locked assets in a default session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

      const auth = factory.auth({ user: { id: user.id } });

      const response = await sut.searchRandom(auth, { size: 250 });

      expect(response.length).toBe(0);
    });
  });

  describe('new search shape', () => {
    it('should filter by an exif field and return a cursor-less single page', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, city: 'Oslo' });
      const { asset: other } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: other.id, city: 'Bergen' });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, { size: 250, filter: { city: { eq: 'Oslo' } } });

      expect(response.assets.items).toEqual([expect.objectContaining({ id: asset.id })]);
      expect(response.assets.nextPage).toBeNull();
      expect(response.assets.nextCursor).toBeNull();
    });

    it('should combine OR branches', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: oslo } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: oslo.id, city: 'Oslo' });
      const { asset: favorite } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      await ctx.newAsset({ ownerId: user.id });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { or: [{ city: { eq: 'Oslo' } }, { isFavorite: { eq: true } }] },
      });

      expect(response.assets.items.map(({ id }) => id).toSorted()).toEqual([oslo.id, favorite.id].toSorted());
    });

    it('should scope a top-level album constraint to the album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, { size: 250, filter: { albumIds: { any: [album.id] } } });

      expect(response.assets.items).toEqual([expect.objectContaining({ id: asset.id })]);
    });

    it('should scope an album-constrained branch to the album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { or: [{ albumIds: { any: [album.id] } }] },
      });

      expect(response.assets.items).toEqual([expect.objectContaining({ id: asset.id })]);
    });

    it('should keep the ownership scope for branches without an album constraint', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset: ownOslo } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: ownOslo.id, city: 'Oslo' });
      const { asset: foreignOslo } = await ctx.newAsset({ ownerId: otherUser.id });
      await ctx.newExif({ assetId: foreignOslo.id, city: 'Oslo' });
      const { asset: albumAsset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: albumAsset.id });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { or: [{ albumIds: { any: [album.id] } }, { city: { eq: 'Oslo' } }] },
      });

      // the album branch searches the album, the city branch stays confined to the caller's own assets
      expect(response.assets.items.map(({ id }) => id).toSorted()).toEqual([ownOslo.id, albumAsset.id].toSorted());
    });

    it('should reject an inaccessible album anywhere in the filter', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: otherUser.id });

      const auth = factory.auth({ user: { id: user.id } });

      await expect(
        sut.searchMetadata(auth, { size: 250, filter: { or: [{ albumIds: { none: [album.id] } }] } }),
      ).rejects.toThrow('Not found or no album.read access');
    });

    it('should return locked assets only to an elevated session that asks for them', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: timeline } = await ctx.newAsset({ ownerId: user.id });
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

      const unelevated = await sut.searchMetadata(factory.auth({ user: { id: user.id } }), { size: 250, filter: {} });
      expect(unelevated.assets.items).toEqual([expect.objectContaining({ id: timeline.id })]);

      const elevatedAuth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
      const elevated = await sut.searchMetadata(elevatedAuth, {
        size: 250,
        filter: { visibility: { eq: AssetVisibility.Locked } },
      });
      expect(elevated.assets.items).toEqual([expect.objectContaining({ id: locked.id })]);
    });

    it('should exclude partner assets from a locked-only search', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });
      const { asset: ownLocked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      await ctx.newAsset({ ownerId: partner.id, visibility: AssetVisibility.Locked });

      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { visibility: { eq: AssetVisibility.Locked } },
      });

      expect(response.assets.items).toEqual([expect.objectContaining({ id: ownLocked.id })]);
    });

    it('should never return partner locked assets, even for locked-matching mixed filters', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });
      const { asset: ownLocked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { asset: partnerTimeline } = await ctx.newAsset({ ownerId: partner.id });
      await ctx.newAsset({ ownerId: partner.id, visibility: AssetVisibility.Locked });

      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { visibility: { in: [AssetVisibility.Locked, AssetVisibility.Timeline] } },
      });

      const ids = response.assets.items.map(({ id }) => id);
      expect(ids.toSorted()).toEqual([ownLocked.id, partnerTimeline.id].toSorted());
    });

    it('should paginate with an opaque cursor', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      for (let i = 0; i < 3; i++) {
        await ctx.newAsset({ ownerId: user.id });
      }

      const auth = factory.auth({ user: { id: user.id } });

      const firstPage = await sut.searchMetadata(auth, { filter: {}, size: 2 });
      expect(firstPage.assets.items.length).toBe(2);
      expect(firstPage.assets.nextPage).toBeNull();
      expect(firstPage.assets.nextCursor).toEqual(expect.any(String));

      const secondPage = await sut.searchMetadata(auth, { cursor: firstPage.assets.nextCursor!, size: 2 });
      expect(secondPage.assets.items.length).toBe(1);
      expect(secondPage.assets.nextCursor).toBeNull();

      const ids = [...firstPage.assets.items, ...secondPage.assets.items].map(({ id }) => id);
      expect(new Set(ids).size).toBe(3);
    });

    it('should order by fileSizeInBytes', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const sizes = [12_334, 599, 123_456];
      const assetIds: string[] = [];
      for (const fileSizeInByte of sizes) {
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        await ctx.newExif({ assetId: asset.id, fileSizeInByte });
        assetIds.push(asset.id);
      }

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        orderBy: { field: SearchOrderField.FileSizeInBytes, direction: AssetOrder.Asc },
      });

      expect(response.assets.items.map(({ id }) => id)).toEqual([assetIds[1], assetIds[0], assetIds[2]]);
    });

    it('should order smart search results by embedding distance with cursor offsets', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const searchRepository = ctx.get(SearchRepository);

      const assetIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        await searchRepository.upsert(asset.id, unitVector(i));
        assetIds.push(asset.id);
      }

      const options = { filter: {}, embedding: unitVector(0) };
      const scope = { userIds: [user.id], lockedOwnerId: user.id };
      const firstPage = await searchRepository.searchSmartV3({ take: 2 }, options, scope);
      expect(firstPage.items.length).toBe(2);
      expect(firstPage.items[0].id).toBe(assetIds[0]);
      expect(firstPage.hasNextPage).toBe(true);

      const secondPage = await searchRepository.searchSmartV3({ take: 2, skip: 2 }, options, scope);
      expect(secondPage.items.length).toBe(1);
      expect(secondPage.hasNextPage).toBe(false);
    });
  });
});
