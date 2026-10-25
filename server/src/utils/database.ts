import { DatabaseConnectionParams, createPostgres } from '@immich/sql-tools';
import {
  AliasedRawBuilder,
  DeduplicateJoinsPlugin,
  Expression,
  ExpressionBuilder,
  Kysely,
  KyselyConfig,
  NotNull,
  OperandValueExpression,
  ReferenceExpression,
  SelectQueryBuilder,
  Selectable,
  ShallowDehydrateObject,
  SqlBool,
  expressionBuilder,
  sql,
} from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { Notice, PostgresError } from 'postgres';
import type { AudioStreamInfo, VectorExtension, VideoFormat, VideoPacketInfo, VideoStreamInfo } from 'src/types.js';
import { LockableProperty, Person, columns, lockableProperties } from 'src/database.js';
import { DummyValue, GenerateSqlQueries } from 'src/decorators.js';
import { AssetEditActionItem } from 'src/dtos/editing.dto.js';
import {
  DEFAULT_SEARCH_ORDER,
  IdsFilter,
  SearchFilterBranch,
  SearchOrder,
  StringFilter,
  StringPatternFilter,
  isAlbumConfined,
} from 'src/dtos/search.dto.js';
import {
  AssetColorLabel,
  AssetFileType,
  AssetFlag,
  AssetOrder,
  AssetOrderBy,
  AssetVisibility,
  DatabaseExtension,
  ExifOrientation,
  SearchOrderField,
} from 'src/enum.js';
import {
  AssetSearchBuilderOptions,
  AssetSearchBuilderV3Options,
  AssetSearchScope,
} from 'src/repositories/search.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import { fromChecksum } from 'src/utils/request.js';

export const getKyselyConfig = (connection: DatabaseConnectionParams): KyselyConfig => {
  return {
    dialect: new PostgresJSDialect({
      postgres: createPostgres({
        connection,
        onNotice: (notice: Notice) => {
          if (notice['severity'] !== 'NOTICE') {
            console.warn('Postgres notice:', notice);
          }
        },
      }),
    }),
    log(event) {
      if (event.level !== 'error') {
        return;
      }

      if (isAssetChecksumConstraint(event.error)) {
        return;
      }

      console.error('Query failed :', {
        durationMs: event.queryDurationMillis,
        error: event.error,
        sql: event.query.sql,
        params: event.query.parameters,
      });
    },
  };
};

const uniqueIds = (ids: string[]) => [...new Set(ids)];

export const asUuid = (id: string | Expression<string>) => sql<string>`${id}::uuid`;

export const anyUuid = (ids: string[]) => sql<string>`any(${`{${ids}}`}::uuid[])`;

export const unnest = (array: string[]) => sql<Record<string, string>>`unnest(array[${sql.join(array)}]::text[])`;

export const removeUndefinedKeys = <T extends object>(update: T, template: unknown) => {
  for (const key in update) {
    if ((template as T)[key] === undefined) {
      delete update[key];
    }
  }

  return update;
};

export const ASSET_CHECKSUM_CONSTRAINT = 'UQ_assets_owner_checksum';
export const VIDEO_STREAM_SESSION_PK_CONSTRAINT = 'video_stream_session_pkey';

export const isAssetChecksumConstraint = (error: unknown) =>
  (error as PostgresError)?.constraint_name === ASSET_CHECKSUM_CONSTRAINT;

export const isVideoStreamSessionPkConstraint = (error: unknown) =>
  (error as PostgresError)?.constraint_name === VIDEO_STREAM_SESSION_PK_CONSTRAINT;

export function withDefaultVisibility<O>(qb: SelectQueryBuilder<DB, 'asset', O>) {
  return qb.where('asset.visibility', 'in', [sql.lit(AssetVisibility.Archive), sql.lit(AssetVisibility.Timeline)]);
}

const selectExifInfo = (eb: AssetExpressionBuilder) =>
  eb.fn
    .toJson(eb.table('asset_exif'))
    .$castTo<ShallowDehydrateObject<Selectable<AssetExifTable>> | null>()
    .as('exifInfo');

// TODO come up with a better query that only selects the fields we need
export function withExif<O>(qb: SelectQueryBuilder<DB, 'asset', O>) {
  return qb.leftJoin('asset_exif', 'asset.id', 'asset_exif.assetId').select(selectExifInfo);
}

export function withExifInner<O>(qb: SelectQueryBuilder<DB, 'asset', O>) {
  return qb
    .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
    .select((eb) => eb.fn.toJson(eb.table('asset_exif')).as('exifInfo'))
    .$narrowType<{ exifInfo: NotNull }>();
}

export const dummy = sql`(select 1)`.as('dummy');

export function withAudioStream(eb: ExpressionBuilder<DB, 'asset_exif' | 'asset_audio'>) {
  return jsonObjectFrom(
    eb
      .selectFrom(dummy)
      .select(['asset_audio.index', 'asset_audio.codecName', 'asset_audio.profile', 'asset_audio.bitrate'])
      .where('asset_audio.assetId', 'is not', sql.lit(null))
      .$castTo<AudioStreamInfo | null>(),
  );
}

export function withVideoStream(eb: ExpressionBuilder<DB, 'asset_exif' | 'asset_video'>) {
  return jsonObjectFrom(
    eb
      .selectFrom(dummy)
      .select((eb) => [
        'asset_video.index',
        'asset_video.codecName',
        'asset_video.profile',
        'asset_video.level',
        'asset_video.bitrate',
        'asset_exif.exifImageWidth as width',
        'asset_exif.exifImageHeight as height',
        'asset_video.pixelFormat',
        'asset_video.frameCount',
        'asset_exif.fps as frameRate',
        'asset_video.timeBase',
        eb
          .case()
          .when('asset_exif.orientation', '=', sql.lit(ExifOrientation.Rotate90CW.toString()))
          .then(sql.lit(-90))
          .when('asset_exif.orientation', '=', sql.lit(ExifOrientation.Rotate270CW.toString()))
          .then(sql.lit(90))
          .when('asset_exif.orientation', '=', sql.lit(ExifOrientation.Rotate180.toString()))
          .then(sql.lit(180))
          .else(0)
          .end()
          .as('rotation'),
        'asset_video.colorPrimaries',
        'asset_video.colorMatrix',
        'asset_video.colorTransfer',
        'asset_video.dvProfile',
        'asset_video.dvLevel',
        'asset_video.dvBlSignalCompatibilityId',
      ])
      .where('asset_video.assetId', 'is not', sql.lit(null)),
  ).$castTo<(VideoStreamInfo & { timeBase: number }) | null>();
}

export function withVideoFormat(eb: ExpressionBuilder<DB, 'asset' | 'asset_video'>) {
  return jsonObjectFrom(
    eb
      .selectFrom(dummy)
      .select(['asset_video.formatName', 'asset_video.formatLongName', 'asset.duration', 'asset_video.bitrate'])
      .where('asset_video.assetId', 'is not', sql.lit(null)),
  ).$castTo<VideoFormat | null>();
}

export function withVideoPackets(eb: ExpressionBuilder<DB, 'asset' | 'asset_keyframe'>) {
  return jsonObjectFrom(
    eb
      .selectFrom(dummy)
      .where('asset_keyframe.assetId', 'is not', sql.lit(null))
      .select([
        'asset_keyframe.pts as keyframePts',
        'asset_keyframe.accDuration as keyframeAccDuration',
        'asset_keyframe.ownDuration as keyframeOwnDuration',
        'asset_keyframe.totalDuration',
        'asset_keyframe.packetCount',
        'asset_keyframe.outputFrames',
      ]),
  ).$castTo<VideoPacketInfo | null>();
}

export function withSmartSearch<O>(qb: SelectQueryBuilder<DB, 'asset', O>) {
  return qb
    .leftJoin('smart_search', 'asset.id', 'smart_search.assetId')
    .select((eb) => jsonObjectFrom(eb.table('smart_search')).as('smartSearch'));
}

export function withFaces(eb: ExpressionBuilder<DB, 'asset'>, withHidden?: boolean, withDeletedFace?: boolean) {
  return jsonArrayFrom(
    eb
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .whereRef('asset_face.assetId', '=', 'asset.id')
      .$if(!withDeletedFace, (qb) => qb.where('asset_face.deletedAt', 'is', null))
      .$if(!withHidden, (qb) => qb.where('asset_face.isVisible', '=', true)),
  ).as('faces');
}

export function withFiles(eb: ExpressionBuilder<DB, 'asset'>, type?: AssetFileType) {
  return jsonArrayFrom(
    eb
      .selectFrom('asset_file')
      .select(columns.assetFiles)
      .whereRef('asset_file.assetId', '=', 'asset.id')
      .$if(!!type, (qb) => qb.where('asset_file.type', '=', type!)),
  ).as('files');
}

export function withFilePath(eb: ExpressionBuilder<DB, 'asset'>, type: AssetFileType, isEdited = false) {
  return eb
    .selectFrom('asset_file')
    .select('asset_file.path')
    .whereRef('asset_file.assetId', '=', 'asset.id')
    .where('asset_file.type', '=', sql.lit(type))
    .where('asset_file.isEdited', '=', sql.lit(isEdited));
}

export type WithFacesAndPeopleOptions = {
  /** whose version of the person to select */
  viewingUserId?: string;
  withHidden?: boolean;
  withDeletedFace?: boolean;
};

export function withFacesAndPeople({ viewingUserId, withHidden, withDeletedFace }: WithFacesAndPeopleOptions) {
  return (eb: ExpressionBuilder<DB, 'asset'>) =>
    jsonArrayFrom(
      eb
        .selectFrom('asset_face')
        .leftJoinLateral(
          (eb) =>
            eb
              .selectFrom('person')
              .selectAll('person')
              .whereRef('person.personGroupId', '=', 'asset_face.personGroupId')
              .$if(!viewingUserId, (qb) => qb.whereRef('person.ownerId', '=', 'asset.ownerId'))
              .$if(!!viewingUserId, (qb) => qb.where('person.ownerId', '=', viewingUserId!))
              .as('person'),
          (join) => join.onTrue(),
        )
        .selectAll('asset_face')
        .select((eb) => eb.table('person').$castTo<ShallowDehydrateObject<Person>>().as('person'))
        .whereRef('asset_face.assetId', '=', 'asset.id')
        .$if(!withDeletedFace, (qb) => qb.where('asset_face.deletedAt', 'is', null))
        .$if(!withHidden, (qb) => qb.where('asset_face.isVisible', 'is', true)),
    ).as('faces');
}

export function hasPeople<O>(qb: SelectQueryBuilder<DB, 'asset', O>, personGroupIds: string[]) {
  return qb.innerJoin(
    (eb) =>
      eb
        .selectFrom('asset_face')
        .select('assetId')
        .where('personGroupId', '=', anyUuid(personGroupIds!))
        .where('deletedAt', 'is', null)
        .where('isVisible', 'is', true)
        .groupBy('assetId')
        .having((eb) => eb.fn.count('personGroupId').distinct(), '=', personGroupIds.length)
        .as('has_people'),
    (join) => join.onRef('has_people.assetId', '=', 'asset.id'),
  );
}

export function inSharedAlbum(userId: string, assetId: 'asset.id' | 'asset_face.assetId') {
  const eb = expressionBuilder<DB, 'asset' | 'asset_face'>();
  return eb.exists(
    eb
      .selectFrom('album_asset')
      .select(sql.lit(1).as('exists'))
      .innerJoin('album', (join) =>
        join.onRef('album.id', '=', 'album_asset.albumId').on('album.deletedAt', 'is', null),
      )
      .innerJoin('album_user', (join) =>
        join.onRef('album_user.albumId', '=', 'album.id').on('album_user.userId', '=', userId),
      )
      .whereRef('album_asset.assetId', '=', assetId),
  );
}

// the viewer's favorite state: the owner's own column is authoritative for owned assets, a per-user row for the rest;
// owner rows in asset_user_state are only a mirror and are never read, as other code paths write the column directly
export function isFavoriteFor(userId: string) {
  const eb = expressionBuilder<DB, 'asset'>();
  return eb.or([
    eb.and([eb('asset.ownerId', '=', userId), eb('asset.isFavorite', '=', true)]),
    eb.and([
      eb('asset.ownerId', '!=', userId),
      eb.exists(
        eb
          .selectFrom('asset_user_state')
          .select(sql.lit(1).as('exists'))
          .whereRef('asset_user_state.assetId', '=', 'asset.id')
          .where('asset_user_state.userId', '=', userId)
          .where('asset_user_state.isFavorite', '=', true),
      ),
    ]),
  ]);
}

// the viewer's own asset_user_state row for the current asset, as a correlated subselect
function userStateOf(userId: string) {
  return expressionBuilder<DB, 'asset'>()
    .selectFrom('asset_user_state')
    .whereRef('asset_user_state.assetId', '=', 'asset.id')
    .where('asset_user_state.userId', '=', userId);
}

// the exif rating of the current asset, as a correlated subselect
export function exifRating() {
  return expressionBuilder<DB, 'asset'>()
    .selectFrom('asset_exif')
    .select('asset_exif.rating')
    .whereRef('asset_exif.assetId', '=', 'asset.id');
}

// the effective rating: the exif rating for owned assets, the viewer's own rating (falling back to exif) otherwise
export function ratingFor(userId: string) {
  const ownRating = userStateOf(userId).select('asset_user_state.rating');

  return sql<
    number | null
  >`case when ${sql.ref('asset.ownerId')} = ${userId} then (${exifRating()}) else coalesce((${ownRating}), (${exifRating()})) end`;
}

// the viewer's own color label, for owned and non-owned assets alike
export function colorLabelFor(userId: string) {
  return sql<AssetColorLabel | null>`(${userStateOf(userId).select('asset_user_state.colorLabel')})`;
}

export function colorLabelsPredicate(userId: string, labels: Array<AssetColorLabel | 'none'>): Expression<SqlBool> {
  const eb = expressionBuilder<DB, 'asset'>();
  const colors = labels.filter((label): label is AssetColorLabel => label !== 'none');
  const conditions: Expression<SqlBool>[] = [];
  if (labels.includes('none')) {
    conditions.push(eb(colorLabelFor(userId), 'is', null));
  }
  if (colors.length > 0) {
    conditions.push(eb(colorLabelFor(userId), '=', sql<AssetColorLabel>`any(${`{${colors}}`}::text[])`));
  }
  return eb.or(conditions);
}

// the viewer's own pick/reject flag, for owned and non-owned assets alike
export function flagFor(userId: string) {
  return sql<AssetFlag | null>`(${userStateOf(userId).select('asset_user_state.flag')})`;
}

export function flagsPredicate(userId: string, flags: Array<AssetFlag | 'none'>): Expression<SqlBool> {
  const eb = expressionBuilder<DB, 'asset'>();
  const values = flags.filter((flag): flag is AssetFlag => flag !== 'none');
  const conditions: Expression<SqlBool>[] = [];
  if (flags.includes('none')) {
    conditions.push(eb(flagFor(userId), 'is', null));
  }
  if (values.length > 0) {
    conditions.push(eb(flagFor(userId), '=', sql<AssetFlag>`any(${`{${values}}`}::text[])`));
  }
  return eb.or(conditions);
}

export type StateViewer = { userId: string; sharedLink?: boolean };

export type StateFilters = {
  isFavorite?: boolean;
  rating?: number;
  unrated?: boolean;
  colorLabels?: Array<AssetColorLabel | 'none'>;
  flags?: Array<AssetFlag | 'none'>;
};

// shared links act as the link creator, whose personal state (favorites, rating overrides, colors) must not leak
export function viewerFavorite({ userId, sharedLink }: StateViewer) {
  if (!sharedLink) {
    return isFavoriteFor(userId);
  }
  const eb = expressionBuilder<DB, 'asset'>();
  return eb.and([eb('asset.ownerId', '=', userId), eb('asset.isFavorite', '=', true)]);
}

export function viewerRating({ userId, sharedLink }: StateViewer) {
  return sharedLink ? sql<number | null>`(${exifRating()})` : ratingFor(userId);
}

export function viewerColorLabel({ userId, sharedLink }: StateViewer) {
  return sharedLink ? sql<AssetColorLabel | null>`null::text` : colorLabelFor(userId);
}

// color label filter from the viewer's point of view
export function viewerColorLabelsPredicate(viewer: StateViewer, labels: Array<AssetColorLabel | 'none'>) {
  if (viewer.sharedLink) {
    // no label is ever visible to a shared link, so 'none' matches every asset and any color matches nothing
    return sql<SqlBool>`${sql.lit(labels.includes('none'))}`;
  }
  return colorLabelsPredicate(viewer.userId, labels);
}

export function viewerFlag({ userId, sharedLink }: StateViewer) {
  return sharedLink ? sql<AssetFlag | null>`null::text` : flagFor(userId);
}

export function viewerFlagsPredicate(viewer: StateViewer, flags: Array<AssetFlag | 'none'>) {
  if (viewer.sharedLink) {
    // no flag is ever visible to a shared link, so 'none' matches every asset and any flag matches nothing
    return sql<SqlBool>`${sql.lit(flags.includes('none'))}`;
  }
  return flagsPredicate(viewer.userId, flags);
}

// liked (thumbs-up) by any user in an album the viewer is a member of; owners have an album_user row too
export function likedInAccessibleAlbum(userId: string) {
  const eb = expressionBuilder<DB, 'asset'>();
  return eb.exists(
    eb
      .selectFrom('activity')
      .select(sql.lit(1).as('exists'))
      .innerJoin('album', (join) => join.onRef('album.id', '=', 'activity.albumId').on('album.deletedAt', 'is', null))
      .innerJoin('album_user', (join) =>
        join.onRef('album_user.albumId', '=', 'album.id').on('album_user.userId', '=', userId),
      )
      .whereRef('activity.assetId', '=', 'asset.id')
      .where('activity.isLiked', '=', true),
  );
}

// liked (thumbs-up) by the user themselves
export function likedBy(userId: string) {
  const eb = expressionBuilder<DB, 'asset'>();
  return eb.exists(
    eb
      .selectFrom('activity')
      .select(sql.lit(1).as('exists'))
      .whereRef('activity.assetId', '=', 'asset.id')
      .where('activity.userId', '=', userId)
      .where('activity.isLiked', '=', true),
  );
}

// likes are personal to a user, so a shared link never sees any: liked matches nothing, not liked matches everything
export function viewerLikedPredicate(viewer: StateViewer, eq: boolean): Expression<SqlBool> {
  if (viewer.sharedLink) {
    return sql<SqlBool>`${sql.lit(!eq)}`;
  }
  const eb = expressionBuilder<DB, 'asset'>();
  const liked = likedInAccessibleAlbum(viewer.userId);
  return eq ? liked : eb.not(liked);
}

export function viewerLikedByMePredicate(viewer: StateViewer, eq: boolean): Expression<SqlBool> {
  if (viewer.sharedLink) {
    return sql<SqlBool>`${sql.lit(!eq)}`;
  }
  const eb = expressionBuilder<DB, 'asset'>();
  const liked = likedBy(viewer.userId);
  return eq ? liked : eb.not(liked);
}

// favorite, rating, color label and flag filters, evaluated from the viewer's point of view;
// `rating` (at least n stars) and `unrated` are combined as an OR
export function applyStateFilters<TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  viewer: StateViewer,
  { isFavorite, rating, unrated, colorLabels, flags }: StateFilters,
) {
  const eb = expressionBuilder<DB, 'asset'>();
  const conditions: Expression<SqlBool>[] = [];

  if (isFavorite !== undefined) {
    const favorite = viewerFavorite(viewer);
    conditions.push(isFavorite ? favorite : eb.not(favorite));
  }

  const ratingConditions: Expression<SqlBool>[] = [];
  if (rating !== undefined) {
    ratingConditions.push(eb(viewerRating(viewer), '>=', rating));
  }
  if (unrated) {
    ratingConditions.push(eb(viewerRating(viewer), 'is', null));
  }
  if (ratingConditions.length > 0) {
    conditions.push(eb.or(ratingConditions));
  }

  if (colorLabels && colorLabels.length > 0) {
    conditions.push(viewerColorLabelsPredicate(viewer, colorLabels));
  }

  if (flags && flags.length > 0) {
    conditions.push(viewerFlagsPredicate(viewer, flags));
  }

  return conditions.length > 0 ? qb.where((eb) => eb.and(conditions)) : qb;
}

// readable through another user, mirroring the access checks: a shared album the user is a member of,
// or a partner share of a visible, non-trashed asset from an active sharer
export function isSharedWith(userId: string) {
  const eb = expressionBuilder<DB, 'asset'>();
  return eb.and([
    eb('asset.deletedAt', 'is', null),
    eb.or([
      inSharedAlbum(userId, 'asset.id'),
      eb.and([
        eb('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Hidden]),
        eb.exists(
          eb
            .selectFrom('partner')
            .select(sql.lit(1).as('exists'))
            .innerJoin('user as sharedBy', (join) =>
              join.onRef('sharedBy.id', '=', 'partner.sharedById').on('sharedBy.deletedAt', 'is', null),
            )
            .whereRef('partner.sharedById', '=', 'asset.ownerId')
            .where('partner.sharedWithId', '=', userId),
        ),
      ]),
    ]),
  ]);
}

// a favorite row only counts while the user still has access, so stale rows stay hidden;
// owned assets never qualify, their favorite state is the asset column
export function isSharedFavoriteFor(userId: string) {
  const eb = expressionBuilder<DB, 'asset'>();
  return eb.and([
    eb('asset.ownerId', '!=', userId),
    eb.exists(
      eb
        .selectFrom('asset_user_state')
        .select(sql.lit(1).as('exists'))
        .whereRef('asset_user_state.assetId', '=', 'asset.id')
        .where('asset_user_state.userId', '=', userId)
        .where('asset_user_state.isFavorite', '=', true),
    ),
    isSharedWith(userId),
  ]);
}

export function inAlbums<O>(qb: SelectQueryBuilder<DB, 'asset', O>, albumIds: string[]) {
  return qb.innerJoin(
    (eb) =>
      eb
        .selectFrom('album_asset')
        .select('assetId')
        .where('albumId', '=', anyUuid(albumIds!))
        .groupBy('assetId')
        .having((eb) => eb.fn.count('albumId').distinct(), '=', albumIds.length)
        .as('has_album'),
    (join) => join.onRef('has_album.assetId', '=', 'asset.id'),
  );
}

export function hasTags<O>(qb: SelectQueryBuilder<DB, 'asset', O>, tagIds: string[]) {
  return qb.innerJoin(
    (eb) =>
      eb
        .selectFrom('tag_asset')
        .select('assetId')
        .innerJoin('tag_closure', 'tag_asset.tagId', 'tag_closure.id_descendant')
        .where('tag_closure.id_ancestor', '=', anyUuid(tagIds))
        .groupBy('assetId')
        .having((eb) => eb.fn.count('tag_closure.id_ancestor').distinct(), '>=', tagIds.length)
        .as('has_tags'),
    (join) => join.onRef('has_tags.assetId', '=', 'asset.id'),
  );
}

export function withOwner(eb: ExpressionBuilder<DB, 'asset'>) {
  return jsonObjectFrom(eb.selectFrom('user').select(columns.user).whereRef('user.id', '=', 'asset.ownerId')).as(
    'owner',
  );
}

export function withLibrary(eb: ExpressionBuilder<DB, 'asset'>) {
  return jsonObjectFrom(
    eb.selectFrom('library').selectAll('library').whereRef('library.id', '=', 'asset.libraryId'),
  ).as('library');
}

export function withTags(eb: ExpressionBuilder<DB, 'asset'>) {
  return jsonArrayFrom(
    eb
      .selectFrom('tag')
      .select(columns.tag)
      .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
      .whereRef('asset.id', '=', 'tag_asset.assetId'),
  ).as('tags');
}

export function truncatedDate<O>(order: AssetOrderBy = AssetOrderBy.TakenAt, size?: 'DAY' | 'MONTH') {
  return sql<O>`date_trunc(${sql.lit(size ?? 'MONTH')}, ${sql.ref(order === AssetOrderBy.CreatedAt ? 'asset.createdAt' : 'localDateTime')} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
}

export function withTagId<O>(qb: SelectQueryBuilder<DB, 'asset', O>, tagId: string) {
  return qb.where((eb) =>
    eb.exists(
      eb
        .selectFrom('tag_closure')
        .innerJoin('tag_asset', 'tag_asset.tagId', 'tag_closure.id_descendant')
        .whereRef('tag_asset.assetId', '=', 'asset.id')
        .where('tag_closure.id_ancestor', '=', tagId),
    ),
  );
}

const isCJK = (c: number): boolean =>
  (c >= 0x4e_00 && c <= 0x9f_ff) ||
  (c >= 0xac_00 && c <= 0xd7_af) ||
  (c >= 0x30_40 && c <= 0x30_9f) ||
  (c >= 0x30_a0 && c <= 0x30_ff) ||
  (c >= 0x34_00 && c <= 0x4d_bf);

export const tokenizeForSearch = (text: string): string[] => {
  /* eslint-disable unicorn/prefer-code-point */
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c <= 32) {
      i++;
      continue;
    }

    const start = i;
    if (isCJK(c)) {
      while (i < text.length && isCJK(text.charCodeAt(i))) {
        i++;
      }
      if (i - start === 1) {
        tokens.push(text[start]);
      } else {
        for (let k = start; k < i - 1; k++) {
          tokens.push(text[k] + text[k + 1]);
        }
      }
    } else {
      while (i < text.length && text.charCodeAt(i) > 32 && !isCJK(text.charCodeAt(i))) {
        i++;
      }
      tokens.push(text.slice(start, i));
    }
  }
  return tokens;
};

// needed to properly type the return with the EditActionItem discriminated union type
type AliasedEditActions = AliasedRawBuilder<AssetEditActionItem[], 'edits'>;
export function withEdits(eb: ExpressionBuilder<DB, 'asset'>): AliasedEditActions {
  return jsonArrayFrom(
    eb
      .selectFrom('asset_edit')
      .select(['asset_edit.action', 'asset_edit.parameters'])
      .whereRef('asset_edit.assetId', '=', 'asset.id'),
  ).as('edits') as AliasedEditActions;
}

const joinDeduplicationPlugin = new DeduplicateJoinsPlugin();
/** TODO: This should only be used for search-related queries, not as a general purpose query builder */

export function searchAssetBuilderLegacy(kysely: Kysely<DB>, options: AssetSearchBuilderOptions) {
  options.withDeleted ||= !!(options.trashedAfter || options.trashedBefore || options.isOffline);

  return kysely
    .withPlugin(joinDeduplicationPlugin)
    .selectFrom('asset')
    .$if(!!options.visibility, (qb) =>
      options.visibility === 'not-locked'
        ? qb.where('asset.visibility', '!=', AssetVisibility.Locked)
        : qb.where('asset.visibility', '=', options.visibility!),
    )
    .$if(!!options.viewingUserId, (qb) =>
      qb.where((eb) =>
        eb.or([eb('asset.visibility', '!=', AssetVisibility.Locked), eb('asset.ownerId', '=', options.viewingUserId!)]),
      ),
    )
    .$if(!!options.albumIds && options.albumIds.length > 0, (qb) => inAlbums(qb, options.albumIds!))
    .$if(!!options.tagIds && options.tagIds.length > 0, (qb) => hasTags(qb, options.tagIds!))
    .$if(options.tagIds === null, (qb) =>
      qb.where((eb) => eb.not(eb.exists((eb) => eb.selectFrom('tag_asset').whereRef('assetId', '=', 'asset.id')))),
    )
    .$if(!!options.personIds && options.personIds.length > 0, (qb) => hasPeople(qb, options.personIds!))
    .$if(!!options.createdBefore, (qb) => qb.where('asset.createdAt', '<=', options.createdBefore!))
    .$if(!!options.createdAfter, (qb) => qb.where('asset.createdAt', '>=', options.createdAfter!))
    .$if(!!options.updatedBefore, (qb) => qb.where('asset.updatedAt', '<=', options.updatedBefore!))
    .$if(!!options.updatedAfter, (qb) => qb.where('asset.updatedAt', '>=', options.updatedAfter!))
    .$if(!!options.trashedBefore, (qb) => qb.where('asset.deletedAt', '<=', options.trashedBefore!))
    .$if(!!options.trashedAfter, (qb) => qb.where('asset.deletedAt', '>=', options.trashedAfter!))
    .$if(!!options.takenBefore, (qb) => qb.where('asset.fileCreatedAt', '<=', options.takenBefore!))
    .$if(!!options.takenAfter, (qb) => qb.where('asset.fileCreatedAt', '>=', options.takenAfter!))
    .$if(options.city !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.city', options.city === null ? 'is' : '=', options.city!),
    )
    .$if(options.state !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.state', options.state === null ? 'is' : '=', options.state!),
    )
    .$if(options.country !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.country', options.country === null ? 'is' : '=', options.country!),
    )
    .$if(options.make !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.make', options.make === null ? 'is' : '=', options.make!),
    )
    .$if(options.model !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.model', options.model === null ? 'is' : '=', options.model!),
    )
    .$if(options.lensModel !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.lensModel', options.lensModel === null ? 'is' : '=', options.lensModel!),
    )
    .$if(options.rating !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        // the rating as the viewer sees it; without a viewer only the exif rating is known
        .where(
          options.viewingUserId
            ? viewerRating({ userId: options.viewingUserId, sharedLink: options.sharedLink })
            : sql<number | null>`asset_exif.rating`,
          options.rating === null ? 'is' : '=',
          options.rating!,
        ),
    )
    .$if(!!options.colorLabels && options.colorLabels.length > 0 && !!options.viewingUserId, (qb) =>
      qb.where(
        viewerColorLabelsPredicate(
          { userId: options.viewingUserId!, sharedLink: options.sharedLink },
          options.colorLabels!,
        ),
      ),
    )
    .$if(!!options.flags && options.flags.length > 0 && !!options.viewingUserId, (qb) =>
      qb.where(
        viewerFlagsPredicate({ userId: options.viewingUserId!, sharedLink: options.sharedLink }, options.flags!),
      ),
    )
    .$if(options.isLiked !== undefined && !!options.viewingUserId, (qb) =>
      qb.where(
        viewerLikedPredicate({ userId: options.viewingUserId!, sharedLink: options.sharedLink }, options.isLiked!),
      ),
    )
    .$if(options.isLikedByMe !== undefined && !!options.viewingUserId, (qb) =>
      qb.where(
        viewerLikedByMePredicate(
          { userId: options.viewingUserId!, sharedLink: options.sharedLink },
          options.isLikedByMe!,
        ),
      ),
    )
    .$if(!!options.checksum, (qb) => qb.where('asset.checksum', '=', options.checksum!))
    .$if(!!options.id, (qb) => qb.where('asset.id', '=', asUuid(options.id!)))
    .$if(!!options.libraryId, (qb) => qb.where('asset.libraryId', '=', asUuid(options.libraryId!)))
    .$if(!!options.userIds, (qb) =>
      qb.where((eb) => {
        const isOwner = eb('asset.ownerId', '=', anyUuid(options.userIds!));
        // favorites search also covers assets other users shared with the viewer
        return options.isFavorite === true && options.viewingUserId
          ? eb.or([isOwner, isSharedFavoriteFor(options.viewingUserId)])
          : isOwner;
      }),
    )
    .$if(!!options.encodedVideoPath, (qb) =>
      qb
        .innerJoin('asset_file', (join) =>
          join
            .onRef('asset.id', '=', 'asset_file.assetId')
            .on('asset_file.type', '=', AssetFileType.EncodedVideo)
            .on('asset_file.isEdited', '=', false),
        )
        .where('asset_file.path', '=', options.encodedVideoPath!),
    )
    .$if(!!options.originalPath, (qb) =>
      qb.where(sql`f_unaccent(asset."originalPath")`, 'ilike', sql`'%' || f_unaccent(${options.originalPath}) || '%'`),
    )
    .$if(!!options.originalFileName, (qb) =>
      qb.where(
        sql`f_unaccent(asset."originalFileName")`,
        'ilike',
        sql`'%' || f_unaccent(${options.originalFileName}) || '%'`,
      ),
    )
    .$if(!!options.description, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where(sql`f_unaccent(asset_exif.description)`, 'ilike', sql`'%' || f_unaccent(${options.description}) || '%'`),
    )
    .$if(!!options.ocr, (qb) =>
      qb
        .innerJoin('ocr_search', 'asset.id', 'ocr_search.assetId')
        .where(() => sql`f_unaccent(ocr_search.text) %>> f_unaccent(${tokenizeForSearch(options.ocr!).join(' ')})`),
    )
    .$if(!!options.type, (qb) => qb.where('asset.type', '=', options.type!))
    .$if(options.isFavorite !== undefined, (qb) =>
      options.viewingUserId
        ? qb.where((eb) =>
            options.isFavorite ? isFavoriteFor(options.viewingUserId!) : eb.not(isFavoriteFor(options.viewingUserId!)),
          )
        : qb.where('asset.isFavorite', '=', options.isFavorite!),
    )
    .$if(options.isOffline !== undefined, (qb) => qb.where('asset.isOffline', '=', options.isOffline!))
    .$if(options.isEncoded !== undefined, (qb) =>
      qb.where((eb) => {
        const exists = eb.exists((eb) =>
          eb
            .selectFrom('asset_file')
            .whereRef('assetId', '=', 'asset.id')
            .where('type', '=', AssetFileType.EncodedVideo),
        );
        return options.isEncoded ? exists : eb.not(exists);
      }),
    )
    .$if(options.isMotion !== undefined, (qb) =>
      qb.where('asset.livePhotoVideoId', options.isMotion ? 'is not' : 'is', null),
    )
    .$if(!!options.isNotInAlbum && (!options.albumIds || options.albumIds.length === 0), (qb) =>
      qb.where((eb) => eb.not(eb.exists((eb) => eb.selectFrom('album_asset').whereRef('assetId', '=', 'asset.id')))),
    )
    .$if(options.withStacked === false, (qb) => qb.where('asset.stackId', 'is', null))
    .$if(!!options.withExif, withExifInner)
    .$if(!!(options.withFaces || options.withPeople), (qb) =>
      qb.select(withFacesAndPeople({ viewingUserId: options.viewingUserId! })),
    )
    .$if(!options.withDeleted, (qb) => qb.where('asset.deletedAt', 'is', null));
}

type AssetExpressionBuilder = ExpressionBuilder<DB, 'asset' | 'asset_exif'>;

const albumAssets = (eb: AssetExpressionBuilder) =>
  eb.selectFrom('album_asset').whereRef('album_asset.assetId', '=', 'asset.id');

const visibleFaces = (eb: AssetExpressionBuilder) =>
  eb
    .selectFrom('asset_face')
    .whereRef('asset_face.assetId', '=', 'asset.id')
    .where('asset_face.deletedAt', 'is', null)
    .where('asset_face.isVisible', '=', true);

const tagAssets = (eb: AssetExpressionBuilder) =>
  eb.selectFrom('tag_asset').whereRef('tag_asset.assetId', '=', 'asset.id');

// shared any/all/none mechanics; `matchesAll` only receives deduplicated multi-id lists,
// so its `count(distinct id) = ids.length` check stays satisfiable
function idsPredicates(
  eb: AssetExpressionBuilder,
  { any, all, none }: IdsFilter = {},
  ops: {
    matchesAny: (ids: string[]) => Expression<SqlBool>;
    matchesAll: (ids: string[]) => Expression<SqlBool>;
  },
) {
  const predicates: Expression<SqlBool>[] = [];
  if (any) {
    predicates.push(ops.matchesAny(any));
  }
  if (all) {
    const ids = uniqueIds(all);
    predicates.push(ids.length === 1 ? ops.matchesAny(ids) : ops.matchesAll(ids));
  }
  if (none) {
    predicates.push(eb.not(ops.matchesAny(none)));
  }
  return predicates;
}

function albumIdsPredicates(eb: AssetExpressionBuilder, filter?: IdsFilter) {
  const matching = (ids: string[]) => albumAssets(eb).where('album_asset.albumId', '=', anyUuid(ids));
  return idsPredicates(eb, filter, {
    matchesAny: (ids) => eb.exists(matching(ids)),
    matchesAll: (ids) =>
      eb.exists(
        matching(ids)
          .select('album_asset.assetId')
          .groupBy('album_asset.assetId')
          .having((eb) => eb.fn.count('album_asset.albumId').distinct(), '=', ids.length),
      ),
  });
}

function personIdsPredicates(eb: AssetExpressionBuilder, filter?: IdsFilter) {
  const matching = (ids: string[]) => visibleFaces(eb).where('asset_face.personGroupId', '=', anyUuid(ids));
  return idsPredicates(eb, filter, {
    matchesAny: (ids) => eb.exists(matching(ids)),
    matchesAll: (ids) =>
      eb.exists(
        matching(ids)
          .select('asset_face.assetId')
          .groupBy('asset_face.assetId')
          .having((eb) => eb.fn.count('asset_face.personGroupId').distinct(), '=', ids.length),
      ),
  });
}

function tagIdsPredicates(eb: AssetExpressionBuilder, filter?: IdsFilter) {
  const matching = (ids: string[]) =>
    tagAssets(eb)
      .innerJoin('tag_closure', 'tag_asset.tagId', 'tag_closure.id_descendant')
      .where('tag_closure.id_ancestor', '=', anyUuid(ids));
  return idsPredicates(eb, filter, {
    matchesAny: (ids) => eb.exists(matching(ids)),
    matchesAll: (ids) =>
      eb.exists(
        matching(ids)
          .select('tag_asset.assetId')
          .groupBy('tag_asset.assetId')
          .having((eb) => eb.fn.count('tag_closure.id_ancestor').distinct(), '=', ids.length),
      ),
  });
}

type ComparisonFilter<T> = {
  eq?: T | null;
  ne?: T | null;
  lt?: T;
  lte?: T;
  gt?: T;
  gte?: T;
  in?: T[];
  notIn?: T[];
};

// one operator dispatch for every filter shape; the DTO schemas constrain which
// operators (and null literals) each filter can actually carry;
// `column` is a column reference or an arbitrary SQL expression, e.g. a viewer-dependent rating
function comparisonPredicates<TB extends keyof DB, RE extends ReferenceExpression<DB, TB>>(
  eb: ExpressionBuilder<DB, TB>,
  column: RE,
  filter: ComparisonFilter<OperandValueExpression<DB, TB, RE>> = {},
) {
  const predicates: Expression<SqlBool>[] = [];
  if (filter.eq !== undefined) {
    predicates.push(filter.eq === null ? eb(column, 'is', null) : eb(column, '=', filter.eq));
  }
  if (filter.ne !== undefined) {
    predicates.push(filter.ne === null ? eb(column, 'is not', null) : eb(column, '!=', filter.ne));
  }
  if (filter.lt !== undefined) {
    predicates.push(eb(column, '<', filter.lt));
  }
  if (filter.lte !== undefined) {
    predicates.push(eb(column, '<=', filter.lte));
  }
  if (filter.gt !== undefined) {
    predicates.push(eb(column, '>', filter.gt));
  }
  if (filter.gte !== undefined) {
    predicates.push(eb(column, '>=', filter.gte));
  }
  if (filter.in !== undefined) {
    predicates.push(eb(column, 'in', filter.in));
  }
  if (filter.notIn !== undefined) {
    predicates.push(eb(column, 'not in', filter.notIn));
  }
  return predicates;
}

type StringColumn =
  | 'asset_exif.city'
  | 'asset_exif.state'
  | 'asset_exif.country'
  | 'asset_exif.make'
  | 'asset_exif.model'
  | 'asset_exif.lensModel'
  | 'asset_exif.description'
  | 'asset.originalFileName'
  | 'asset.originalPath';

function stringPatternPredicates(eb: AssetExpressionBuilder, column: StringColumn, filter: StringPatternFilter = {}) {
  const ref = sql.ref(column);
  const predicates = comparisonPredicates(eb, column, filter);
  if (filter.like !== undefined) {
    predicates.push(sql<SqlBool>`f_unaccent(${ref}) ilike ('%' || f_unaccent(${filter.like}) || '%')`);
  }
  if (filter.notLike !== undefined) {
    predicates.push(sql<SqlBool>`f_unaccent(${ref}) not ilike ('%' || f_unaccent(${filter.notLike}) || '%')`);
  }
  if (filter.startsWith !== undefined) {
    predicates.push(sql<SqlBool>`f_unaccent(${ref}) ilike (f_unaccent(${filter.startsWith}) || '%')`);
  }
  if (filter.endsWith !== undefined) {
    predicates.push(sql<SqlBool>`f_unaccent(${ref}) ilike ('%' || f_unaccent(${filter.endsWith}))`);
  }
  return predicates;
}

function checksumPredicates(eb: AssetExpressionBuilder, filter: StringFilter = {}) {
  return comparisonPredicates(eb, 'asset.checksum', {
    eq: filter.eq === undefined ? undefined : fromChecksum(filter.eq),
    ne: filter.ne === undefined ? undefined : fromChecksum(filter.ne),
    in: filter.in?.map((checksum) => fromChecksum(checksum)),
    notIn: filter.notIn?.map((checksum) => fromChecksum(checksum)),
  });
}

const encodedVideoFiles = (eb: AssetExpressionBuilder) =>
  eb
    .selectFrom('asset_file')
    .whereRef('asset_file.assetId', '=', 'asset.id')
    .where('asset_file.type', '=', AssetFileType.EncodedVideo);

function existsPredicates(
  eb: AssetExpressionBuilder,
  filter: { eq: boolean } | undefined,
  subquery: () => Expression<unknown>,
): Expression<SqlBool>[] {
  if (!filter) {
    return [];
  }
  const exists = eb.exists(subquery());
  return [filter.eq ? exists : eb.not(exists)];
}

function favoritePredicate(eb: AssetExpressionBuilder, eq: boolean, viewerId?: string) {
  if (!viewerId) {
    return eb('asset.isFavorite', '=', eq);
  }
  return eq ? isFavoriteFor(viewerId) : eb.not(isFavoriteFor(viewerId));
}

// predicates are collected as expressions rather than chained `where` calls so the same
// helpers can build each `or` branch, which must compose into eb.and/eb.or
function branchPredicates(eb: AssetExpressionBuilder, branch: SearchFilterBranch, viewer?: StateViewer) {
  const viewerId = viewer?.userId;
  const { encodedVideoPath } = branch;
  return [
    ...comparisonPredicates(eb, 'asset.id', branch.id),
    ...comparisonPredicates(eb, 'asset.libraryId', branch.libraryId),
    ...comparisonPredicates(eb, 'asset.type', branch.type),
    ...comparisonPredicates(eb, 'asset.visibility', branch.visibility),
    ...(branch.isFavorite ? [favoritePredicate(eb, branch.isFavorite.eq, viewerId)] : []),
    ...(branch.isOffline ? [eb('asset.isOffline', '=', branch.isOffline.eq)] : []),
    ...(branch.isMotion ? [eb('asset.livePhotoVideoId', branch.isMotion.eq ? 'is not' : 'is', null)] : []),
    ...existsPredicates(eb, branch.isEncoded, () => encodedVideoFiles(eb)),
    ...existsPredicates(eb, branch.hasAlbums, () => albumAssets(eb)),
    ...existsPredicates(eb, branch.hasPeople, () => visibleFaces(eb)),
    ...existsPredicates(eb, branch.hasTags, () => tagAssets(eb)),
    ...comparisonPredicates(eb, 'asset_exif.city', branch.city),
    ...comparisonPredicates(eb, 'asset_exif.state', branch.state),
    ...comparisonPredicates(eb, 'asset_exif.country', branch.country),
    ...comparisonPredicates(eb, 'asset_exif.make', branch.make),
    ...comparisonPredicates(eb, 'asset_exif.model', branch.model),
    ...comparisonPredicates(eb, 'asset_exif.lensModel', branch.lensModel),
    ...stringPatternPredicates(eb, 'asset_exif.description', branch.description),
    ...stringPatternPredicates(eb, 'asset.originalFileName', branch.originalFileName),
    ...stringPatternPredicates(eb, 'asset.originalPath', branch.originalPath),
    ...(branch.ocr
      ? [
          eb.exists(
            eb
              .selectFrom('ocr_search')
              .whereRef('ocr_search.assetId', '=', 'asset.id')
              .where(
                sql<SqlBool>`f_unaccent(ocr_search.text) %>> f_unaccent(${tokenizeForSearch(branch.ocr.matches).join(' ')})`,
              ),
          ),
        ]
      : []),
    // the rating as the viewer sees it; without a viewer only the exif rating is known
    ...comparisonPredicates(eb, viewer ? viewerRating(viewer) : sql<number | null>`asset_exif.rating`, branch.rating),
    // all service callers pass a viewer; without one colorLabels is ignored
    ...(branch.colorLabels && branch.colorLabels.length > 0 && viewer
      ? [viewerColorLabelsPredicate(viewer, branch.colorLabels)]
      : []),
    ...(branch.flags && branch.flags.length > 0 && viewer ? [viewerFlagsPredicate(viewer, branch.flags)] : []),
    ...(branch.isLiked && viewer ? [viewerLikedPredicate(viewer, branch.isLiked.eq)] : []),
    ...(branch.isLikedByMe && viewer ? [viewerLikedByMePredicate(viewer, branch.isLikedByMe.eq)] : []),
    ...comparisonPredicates(eb, 'asset_exif.fileSizeInByte', branch.fileSizeInBytes),
    ...comparisonPredicates(eb, 'asset.fileCreatedAt', branch.takenAt),
    ...comparisonPredicates(eb, 'asset.createdAt', branch.createdAt),
    ...comparisonPredicates(eb, 'asset.updatedAt', branch.updatedAt),
    ...comparisonPredicates(eb, 'asset.deletedAt', branch.trashedAt),
    ...albumIdsPredicates(eb, branch.albumIds),
    ...personIdsPredicates(eb, branch.personIds),
    ...tagIdsPredicates(eb, branch.tagIds),
    ...checksumPredicates(eb, branch.checksum),
    ...(encodedVideoPath
      ? [
          eb.exists(
            encodedVideoFiles(eb)
              .where('asset_file.isEdited', '=', false)
              .where((eb) => eb.and(comparisonPredicates(eb, 'asset_file.path', encodedVideoPath))),
          ),
        ]
      : []),
  ];
}

// ordering is deliberately left to the caller so aggregate-only consumers (counts, stats)
// can compose the same filters without stripping an order by
export function searchAssetBuilder(kysely: Kysely<DB>, options: AssetSearchBuilderV3Options, scope: AssetSearchScope) {
  const filter = options.filter ?? {};
  const branches = filter.or ?? [];
  const ownershipPredicate = (eb: AssetExpressionBuilder) => eb('asset.ownerId', '=', anyUuid(scope.userIds));
  // search universe: own+partner assets unless album-confined, which searches the albums instead;
  // ownership lands nowhere (top level confined), per unconfined branch, or hoisted globally
  const topConfined = isAlbumConfined(filter);
  const anyBranchConfined = branches.some((branch) => isAlbumConfined(branch));
  const scopePerBranch = !topConfined && anyBranchConfined;
  const scopeGlobally = !topConfined && !anyBranchConfined;

  return (
    kysely
      .withPlugin(joinDeduplicationPlugin)
      .selectFrom('asset')
      // postgres eliminates the left join when no exif column is referenced, so unused joins are free
      .leftJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .$if(!!options.withExif, (qb) => qb.select(selectExifInfo))
      .$if(scopeGlobally, (qb) => qb.where(ownershipPredicate))
      .where((eb) =>
        eb.or([eb('asset.visibility', '!=', AssetVisibility.Locked), eb('asset.ownerId', '=', scope.lockedOwnerId)]),
      )
      .$if(!!(options.withFaces || options.withPeople), (qb) =>
        qb.select(withFacesAndPeople({ viewingUserId: scope.viewingUserId! })),
      )
      .$if(options.withStacked === false, (qb) => qb.where('asset.stackId', 'is', null))
      .where((eb) => {
        const viewer = scope.viewingUserId ? { userId: scope.viewingUserId, sharedLink: scope.sharedLink } : undefined;
        const predicates = branchPredicates(eb, filter, viewer);
        if (branches.length > 0) {
          predicates.push(
            eb.or(
              branches.map((branch) =>
                eb.and([
                  ...branchPredicates(eb, branch, viewer),
                  ...(scopePerBranch && !isAlbumConfined(branch) ? [ownershipPredicate(eb)] : []),
                ]),
              ),
            ),
          );
        }
        return predicates.length > 0 ? eb.and(predicates) : eb.lit(true);
      })
  );
}

const searchOrderColumns = {
  [SearchOrderField.FileCreatedAt]: { column: 'asset.fileCreatedAt', nullable: false },
  [SearchOrderField.LocalDateTime]: { column: 'asset.localDateTime', nullable: false },
  [SearchOrderField.FileSizeInBytes]: { column: 'asset_exif.fileSizeInByte', nullable: true },
  [SearchOrderField.Rating]: { column: 'asset_exif.rating', nullable: true },
} as const;

export function withSearchOrder(qb: ReturnType<typeof searchAssetBuilder>, order?: SearchOrder) {
  const { field, direction } = order ?? DEFAULT_SEARCH_ORDER;
  const { column, nullable } = searchOrderColumns[field];
  return (
    qb
      .orderBy(column, (ob) => {
        const ordered = direction === AssetOrder.Asc ? ob.asc() : ob.desc();
        // nulls last: assets without an asset_exif row would otherwise lead descending results
        return nullable ? ordered.nullsLast() : ordered;
      })
      // id tie-break for deterministic pagination
      .orderBy('asset.id', direction)
  );
}

const scopeExample: AssetSearchScope = { userIds: [DummyValue.UUID], lockedOwnerId: DummyValue.UUID };

export const searchMetadataV3Examples: GenerateSqlQueries[] = [
  { name: 'baseline', params: [{ take: 100 }, {}, scopeExample] },
  {
    name: 'or-mixed-scope',
    params: [
      { take: 100 },
      {
        filter: { or: [{ albumIds: { any: [DummyValue.UUID] } }, { city: { eq: DummyValue.STRING } }] },
      },
      scopeExample,
    ],
  },
  {
    name: 'or-exif-only',
    params: [
      { take: 100 },
      {
        filter: { or: [{ city: { eq: DummyValue.STRING } }] },
      },
      scopeExample,
    ],
  },
  {
    name: 'string-eq-null',
    params: [{ take: 100 }, { filter: { city: { eq: null } } }, scopeExample],
  },
  {
    name: 'string-pattern-like',
    params: [
      { take: 100 },
      {
        filter: { description: { like: DummyValue.STRING } },
      },
      scopeExample,
    ],
  },
  {
    name: 'string-pattern-notLike',
    params: [
      { take: 100 },
      {
        filter: { description: { notLike: DummyValue.STRING } },
      },
      scopeExample,
    ],
  },
  {
    name: 'string-pattern-startsWith',
    params: [
      { take: 100 },
      {
        filter: { originalFileName: { startsWith: DummyValue.STRING } },
      },
      scopeExample,
    ],
  },
  {
    name: 'string-similarity-ocr',
    params: [{ take: 100 }, { filter: { ocr: { matches: DummyValue.STRING } } }, scopeExample],
  },
  {
    name: 'ids-any',
    params: [{ take: 100 }, { filter: { albumIds: { any: [DummyValue.UUID] } } }, scopeExample],
  },
  {
    name: 'ids-all',
    params: [
      { take: 100 },
      {
        filter: { personIds: { all: [DummyValue.UUID, DummyValue.UUID_1] } },
      },
      scopeExample,
    ],
  },
  {
    name: 'ids-all-single',
    params: [{ take: 100 }, { filter: { albumIds: { all: [DummyValue.UUID] } } }, scopeExample],
  },
  {
    name: 'ids-none',
    params: [{ take: 100 }, { filter: { tagIds: { none: [DummyValue.UUID] } } }, scopeExample],
  },
  {
    name: 'ids-tags-all',
    params: [
      { take: 100 },
      {
        filter: { tagIds: { all: [DummyValue.UUID, DummyValue.UUID_1] } },
      },
      scopeExample,
    ],
  },
  {
    name: 'has-albums-false',
    params: [{ take: 100 }, { filter: { hasAlbums: { eq: false } } }, scopeExample],
  },
  {
    name: 'is-encoded',
    params: [{ take: 100 }, { filter: { isEncoded: { eq: true } } }, scopeExample],
  },
  {
    name: 'number-range',
    params: [
      { take: 100 },
      {
        filter: { fileSizeInBytes: { gte: 100, lte: 1000 } },
      },
      scopeExample,
    ],
  },
  {
    name: 'date-eq',
    params: [{ take: 100 }, { filter: { takenAt: { eq: DummyValue.DATE } } }, scopeExample],
  },
  {
    name: 'date-range',
    params: [
      { take: 100 },
      {
        filter: { takenAt: { gte: DummyValue.DATE, lt: DummyValue.DATE } },
      },
      scopeExample,
    ],
  },
  {
    name: 'order-fileSize-noExif',
    params: [
      { take: 100 },
      {
        order: { field: SearchOrderField.FileSizeInBytes, direction: AssetOrder.Desc },
        withExif: false,
      },
      scopeExample,
    ],
  },
  {
    name: 'order-rating-withExif',
    params: [
      { take: 100 },
      {
        order: { field: SearchOrderField.Rating, direction: AssetOrder.Asc },
        withExif: true,
      },
      scopeExample,
    ],
  },
  {
    name: 'or-branches',
    params: [
      { take: 100 },
      {
        filter: {
          or: [{ isFavorite: { eq: true } }, { personIds: { any: [DummyValue.UUID] } }],
        },
      },
      scopeExample,
    ],
  },
  {
    name: 'or-with-top-level',
    params: [
      { take: 100 },
      {
        filter: {
          takenAt: { gte: DummyValue.DATE, lt: DummyValue.DATE },
          or: [{ isFavorite: { eq: true } }, { albumIds: { any: [DummyValue.UUID] } }],
        },
      },
      scopeExample,
    ],
  },
  {
    name: 'cursor-offset',
    params: [{ take: 100, skip: 100 }, { filter: { isFavorite: { eq: true } } }, scopeExample],
  },
];

export const searchRandomV3Examples: GenerateSqlQueries[] = [
  { name: 'baseline', params: [100, {}, scopeExample] },
  {
    name: 'with-filter',
    params: [100, { filter: { isFavorite: { eq: true } } }, scopeExample],
  },
];

export const searchSmartV3Examples: GenerateSqlQueries[] = [
  {
    name: 'baseline',
    params: [{ take: 100 }, { embedding: DummyValue.VECTOR }, scopeExample],
  },
  {
    name: 'with-filter',
    params: [
      { take: 100 },
      {
        embedding: DummyValue.VECTOR,
        filter: { takenAt: { gte: DummyValue.DATE, lt: DummyValue.DATE } },
      },
      scopeExample,
    ],
  },
  {
    name: 'cursor-offset',
    params: [{ take: 100, skip: 100 }, { embedding: DummyValue.VECTOR }, scopeExample],
  },
];

export const searchStatisticsV3Examples: GenerateSqlQueries[] = [
  { name: 'baseline', params: [{}, scopeExample] },
  {
    name: 'with-filter',
    params: [
      {
        filter: {
          takenAt: { gte: DummyValue.DATE, lt: DummyValue.DATE },
          fileSizeInBytes: { gte: 100 },
        },
      },
      scopeExample,
    ],
  },
  {
    name: 'with-or',
    params: [
      {
        filter: {
          or: [{ isFavorite: { eq: true } }, { hasAlbums: { eq: false } }],
        },
      },
      scopeExample,
    ],
  },
];

export type ReindexVectorIndexOptions = { indexName: string; lists?: number };

type VectorIndexQueryOptions = { table: string; vectorExtension: VectorExtension } & ReindexVectorIndexOptions;

export function vectorIndexQuery({ vectorExtension, table, indexName, lists }: VectorIndexQueryOptions): string {
  switch (vectorExtension) {
    case DatabaseExtension.VectorChord: {
      return `
        CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} USING vchordrq (embedding vector_cosine_ops) WITH (options = $$
        residual_quantization = false
        [build.internal]
        lists = [${lists ?? 1}]
        spherical_centroids = true
        build_threads = 4
        sampling_factor = 1024
        $$)`;
    }
    case DatabaseExtension.Vector: {
      return `
        CREATE INDEX IF NOT EXISTS ${indexName} ON ${table}
        USING hnsw (embedding vector_cosine_ops)
        WITH (ef_construction = 300, m = 16)`;
    }
    default: {
      throw new Error(`Unsupported vector extension: '${vectorExtension}'`);
    }
  }
}

export const updateLockedColumns = <T extends Record<string, unknown> & { lockedProperties?: LockableProperty[] }>(
  exif: T,
) => {
  exif.lockedProperties = lockableProperties.filter((property) => Object.hasOwn(exif, property));
  return exif;
};
