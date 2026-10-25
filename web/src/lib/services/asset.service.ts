import {
  AssetColorLabel,
  AssetFlag,
  AssetJobName,
  AssetMediaSize,
  AssetTypeEnum,
  AssetVisibility,
  bulkTagAssets,
  getAssetInfo,
  removeAssetFromAlbum,
  runAssetJobs,
  updateAsset,
  updateAssets,
  type AlbumResponseDto,
  type AssetJobsDto,
  type AssetResponseDto,
} from '@immich/sdk';
import { modalManager, toastManager, type ActionItem } from '@immich/ui';
import {
  mdiAccountCircleOutline,
  mdiAlertOutline,
  mdiCogRefreshOutline,
  mdiCompare,
  mdiContentCopy,
  mdiDatabaseRefreshOutline,
  mdiDownload,
  mdiDownloadBox,
  mdiFaceRecognition,
  mdiHeadSyncOutline,
  mdiHeart,
  mdiHeartOutline,
  mdiImageRefreshOutline,
  mdiImageRemoveOutline,
  mdiImageSearch,
  mdiInformationOutline,
  mdiMagnifyMinusOutline,
  mdiMagnifyPlusOutline,
  mdiMotionPauseOutline,
  mdiMotionPlayOutline,
  mdiPlus,
  mdiPresentationPlay,
  mdiShareVariantOutline,
  mdiTagMultipleOutline,
  mdiTagPlusOutline,
  mdiTune,
} from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';
import { goto } from '$app/navigation';
import type { ShortcutOptions } from '$lib/actions/shortcut';
import { ProjectionType } from '$lib/constants';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import AssetAddToAlbumModal from '$lib/modals/AssetAddToAlbumModal.svelte';
import AssetTagModal from '$lib/modals/AssetTagModal.svelte';
import ProfileImageCropperModal from '$lib/modals/ProfileImageCropperModal.svelte';
import SharedLinkCreateModal from '$lib/modals/SharedLinkCreateModal.svelte';
import { Route } from '$lib/route';
import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
import { getAssetMediaUrl, getSharedLink, sleep } from '$lib/utils';
import { downloadUrl } from '$lib/utils';
import { colorLabelShortcut } from '$lib/utils/color-label';
import { clearFlagShortcut, flagShortcut, nextFlag } from '$lib/utils/flag';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export const getAssetBulkActions = ($t: MessageFormatter, album?: AlbumResponseDto) => {
  const assetIds = assetMultiSelectManager.assets.map((asset) => asset.id);
  const ownedAssets = assetMultiSelectManager.ownedAssets;
  const isAlbumOwner = album?.albumUsers[0].user.id === authManager.user.id;

  const onAction = async (name: AssetJobName) => {
    await handleRunAssetJob({ name, assetIds: ownedAssets.map(({ id }) => id) });
    assetMultiSelectManager.clear();
  };

  const AddToAlbum: ActionItem = {
    title: $t('add_to_album'),
    icon: mdiPlus,
    shortcuts: [{ key: 'l' }],
    onAction: () => modalManager.show(AssetAddToAlbumModal, { assetIds }),
  };

  const CreateSharedLink: ActionItem = {
    title: $t('share'),
    icon: mdiShareVariantOutline,
    onAction: () => modalManager.show(SharedLinkCreateModal, { assetIds }),
  };

  const RemoveFromAlbum: ActionItem = {
    title: $t('remove_from_album'),
    icon: mdiImageRemoveOutline,
    shortcuts: [{ key: 'l', shift: true }],
    $if: () => !!album && (isAlbumOwner || assetMultiSelectManager.isAllUserOwned),
    onAction: () => handleBulkRemoveAssetsFromAlbum(assetIds, album!),
  };

  const Tag: ActionItem = {
    title: $t('tag'),
    icon: mdiTagMultipleOutline,
    $if: () => authManager.preferences.tags.enabled && assetMultiSelectManager.isAllUserOwned,
    onAction: async () => {
      if (await modalManager.show(AssetTagModal, { assetIds })) {
        assetMultiSelectManager.clear();
      }
    },
    shortcuts: { key: 't' },
  };

  const RefreshFacesJob: ActionItem = {
    title: $t('refresh_faces'),
    icon: mdiHeadSyncOutline,
    onAction: () => onAction(AssetJobName.RefreshFaces),
  };

  const RefreshMetadataJob: ActionItem = {
    title: $t('refresh_metadata'),
    icon: mdiDatabaseRefreshOutline,
    onAction: () => onAction(AssetJobName.RefreshMetadata),
  };

  const RegenerateThumbnailJob: ActionItem = {
    title: $t('refresh_thumbnails'),
    icon: mdiImageRefreshOutline,
    onAction: () => onAction(AssetJobName.RegenerateThumbnail),
  };

  const TranscodeVideoJob: ActionItem = {
    title: $t('refresh_encoded_videos'),
    icon: mdiCogRefreshOutline,
    onAction: () => onAction(AssetJobName.TranscodeVideo),
    $if: () => ownedAssets.every((asset) => asset.isVideo),
  };

  return {
    AddToAlbum,
    CreateSharedLink,
    RemoveFromAlbum,
    Tag,
    RefreshFacesJob,
    RefreshMetadataJob,
    RegenerateThumbnailJob,
    TranscodeVideoJob,
  };
};

export const getAssetActions = (
  $t: MessageFormatter,
  asset: AssetResponseDto & { stackPrimaryAssetId?: string },
  album?: AlbumResponseDto,
) => {
  const sharedLink = getSharedLink();
  const authUser = authManager.authenticated ? authManager.user : undefined;
  const isOwner = !!(authUser && authUser.id === asset.ownerId);
  // any logged-in user who can see the asset may favorite it; shared link guests may not
  const canFavorite = !!authUser && (isOwner || !sharedLink);
  // rating and color labels follow the same rule as favorites (per-user state)
  const canRate = canFavorite && !authManager.isSharedLink;
  const isAlbumOwner = !!(authUser && authUser.id === album?.albumUsers[0].user.id);
  const smartSearchEnabled = featureFlagsManager.value.smartSearch;

  const Share: ActionItem = {
    title: $t('share'),
    icon: mdiShareVariantOutline,
    $if: () => !!(authUser && !asset.isTrashed && asset.visibility !== AssetVisibility.Locked),
    onAction: () => modalManager.show(SharedLinkCreateModal, { assetIds: [asset.id] }),
  };

  const Download: ActionItem = {
    title: $t('download'),
    icon: mdiDownload,
    shortcuts: { key: 'd', shift: true },
    $if: () => !!authUser,
    onAction: () => handleDownloadAsset(asset, { edited: true }),
  };

  const DownloadOriginal: ActionItem = {
    title: $t('download_original'),
    icon: mdiDownloadBox,
    $if: () => !!authUser && asset.isEdited,
    onAction: () => handleDownloadAsset(asset, { edited: false }),
  };

  const SharedLinkDownload: ActionItem = {
    ...Download,
    $if: () => isOwner || !!sharedLink?.allowDownload,
  };

  const PlayMotionPhoto: ActionItem = {
    title: $t('play_motion_photo'),
    icon: mdiMotionPlayOutline,
    $if: () => !!asset.livePhotoVideoId && !assetViewerManager.isPlayingMotionPhoto,
    onAction: () => {
      assetViewerManager.isPlayingMotionPhoto = true;
    },
  };

  const StopMotionPhoto: ActionItem = {
    title: $t('stop_motion_photo'),
    icon: mdiMotionPauseOutline,
    $if: () => !!asset.livePhotoVideoId && assetViewerManager.isPlayingMotionPhoto,
    onAction: () => {
      assetViewerManager.isPlayingMotionPhoto = false;
    },
  };

  const PlaySlideshow: ActionItem = {
    title: $t('slideshow'),
    icon: mdiPresentationPlay,
    $if: () => asset.visibility !== AssetVisibility.Locked,
    onAction: () => slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow),
  };

  const Favorite: ActionItem = {
    title: $t('to_favorite'),
    icon: mdiHeartOutline,
    $if: () => canFavorite && !asset.isFavorite,
    onAction: () => handleFavorite(asset),
    shortcuts: [{ key: 'f' }],
  };

  const Unfavorite: ActionItem = {
    title: $t('unfavorite'),
    icon: mdiHeart,
    $if: () => canFavorite && asset.isFavorite,
    onAction: () => handleUnfavorite(asset),
    shortcuts: [{ key: 'f' }],
  };

  const Rate: ActionItem = {
    title: $t('rate_asset'),
    description: $t('rate_asset_description'),
    $if: () => canRate && authManager.preferences.ratings.enabled,
    onAction: ({ event }) => handleRate(asset, event instanceof KeyboardEvent ? Number(event.key) : NaN),
    shortcuts: [0, 1, 2, 3, 4, 5].map((key) => ({ key: String(key) })),
  };

  const SetColorLabel: ActionItem = {
    title: $t('set_color_label'),
    description: $t('set_color_label_description'),
    $if: () => canRate,
    onAction: ({ event }) => {
      const label = event instanceof KeyboardEvent ? colorLabelForKey(event.key) : undefined;
      return label ? handleSetColorLabel(asset, nextColorLabel([asset], label)) : undefined;
    },
    shortcuts: Object.values(colorLabelShortcut).map((key) => ({ key })),
  };

  const SetFlag: ActionItem = {
    title: $t('set_flag'),
    description: $t('set_flag_description'),
    $if: () => canRate,
    onAction: ({ event }) => {
      const key = event instanceof KeyboardEvent ? event.key : undefined;
      if (key === flagShortcut[AssetFlag.Pick]) {
        return handleSetFlag(asset, nextFlag([asset], AssetFlag.Pick));
      }
      if (key === flagShortcut[AssetFlag.Reject]) {
        return handleSetFlag(asset, nextFlag([asset], AssetFlag.Reject));
      }
      if (key === clearFlagShortcut) {
        return handleSetFlag(asset, null);
      }
    },
    shortcuts: [flagShortcut[AssetFlag.Pick], flagShortcut[AssetFlag.Reject], clearFlagShortcut].map((key) => ({
      key,
    })),
  };

  const AddToAlbum: ActionItem = {
    title: $t('add_to_album'),
    icon: mdiPlus,
    shortcuts: [{ key: 'l' }],
    $if: () => asset.visibility !== AssetVisibility.Locked && !asset.isTrashed,
    onAction: () => modalManager.show(AssetAddToAlbumModal, { assetIds: [asset.id] }),
  };

  const RemoveFromAlbum: ActionItem = {
    title: $t('remove_from_album'),
    icon: mdiImageRemoveOutline,
    shortcuts: [{ key: 'l', shift: true }],
    $if: () => !!album && (isOwner || isAlbumOwner),
    onAction: () => handleRemoveAssetsFromAlbum([asset.id], album!),
  };

  const Offline: ActionItem = {
    title: $t('asset_offline'),
    icon: mdiAlertOutline,
    color: 'danger',
    $if: () => !!asset.isOffline,
    onAction: () => assetViewerManager.toggleDetailPanel(),
  };

  const ZoomIn: ActionItem = {
    title: $t('zoom_image'),
    icon: mdiMagnifyPlusOutline,
    $if: () => assetViewerManager.canZoomIn(),
    onAction: () => assetViewerManager.emit('Zoom'),
  };

  const ZoomOut: ActionItem = {
    title: $t('zoom_image'),
    icon: mdiMagnifyMinusOutline,
    $if: () => assetViewerManager.canZoomOut(),
    onAction: () => assetViewerManager.emit('Zoom'),
  };

  const Copy: ActionItem = {
    title: $t('copy_image'),
    icon: mdiContentCopy,
    $if: () => assetViewerManager.canCopyImage(),
    onAction: () => assetViewerManager.emit('Copy'),
  };

  const Info: ActionItem = {
    title: $t('info'),
    icon: mdiInformationOutline,
    $if: () => asset.hasMetadata,
    onAction: () => assetViewerManager.toggleDetailPanel(),
    shortcuts: { key: 'i' },
  };

  const Tag: ActionItem = {
    title: $t('add_tag'),
    icon: mdiTagPlusOutline,
    $if: () => authManager.authenticated && authManager.preferences.tags.enabled,
    onAction: () => modalManager.show(AssetTagModal, { assetIds: [asset.id] }),
    shortcuts: { key: 't' },
  };

  const TagPeople: ActionItem = {
    title: $t('tag_people'),
    icon: mdiFaceRecognition,
    $if: () => isOwner && asset.type === AssetTypeEnum.Image && !asset.isTrashed,
    onAction: () => assetViewerManager.toggleFaceEditMode(),
    shortcuts: { key: 'p' },
  };

  const Edit: ActionItem = {
    title: $t('editor'),
    icon: mdiTune,
    $if: () =>
      !sharedLink &&
      isOwner &&
      asset.type === AssetTypeEnum.Image &&
      !asset.livePhotoVideoId &&
      asset.exifInfo?.projectionType !== ProjectionType.EQUIRECTANGULAR &&
      !asset.originalPath.toLowerCase().endsWith('.insp') &&
      !asset.originalPath.toLowerCase().endsWith('.gif') &&
      !asset.originalPath.toLowerCase().endsWith('.svg'),
    onAction: () => assetViewerManager.openEditor(),
    shortcuts: [{ key: 'e' }],
  };

  const SetProfilePicture: ActionItem = {
    title: $t('set_as_profile_picture'),
    icon: mdiAccountCircleOutline,
    $if: () => asset.type === AssetTypeEnum.Image && asset.visibility !== AssetVisibility.Locked,
    onAction: () => modalManager.show(ProfileImageCropperModal, { asset }),
  };

  const ViewInTimeline: ActionItem = {
    title: $t('view_in_timeline'),
    icon: mdiImageSearch,
    $if: () => isOwner && asset.visibility !== AssetVisibility.Locked && !asset.isArchived && !asset.isTrashed,
    onAction: () => goto(Route.photos({ at: asset.stackPrimaryAssetId ?? asset.id })),
  };

  const ViewSimilar: ActionItem = {
    title: $t('view_similar_photos'),
    icon: mdiCompare,
    $if: () =>
      asset.visibility !== AssetVisibility.Locked && !asset.isArchived && !asset.isTrashed && smartSearchEnabled,
    onAction: () => goto(Route.search({ queryAssetId: asset.stackPrimaryAssetId ?? asset.id })),
  };

  const RefreshFacesJob: ActionItem = {
    title: $t('refresh_faces'),
    icon: mdiHeadSyncOutline,
    onAction: () => handleRunAssetJob({ name: AssetJobName.RefreshFaces, assetIds: [asset.id] }),
  };

  const RefreshMetadataJob: ActionItem = {
    title: $t('refresh_metadata'),
    icon: mdiDatabaseRefreshOutline,
    onAction: () => handleRunAssetJob({ name: AssetJobName.RefreshMetadata, assetIds: [asset.id] }),
  };

  const RegenerateThumbnailJob: ActionItem = {
    title: $t('refresh_thumbnails'),
    icon: mdiImageRefreshOutline,
    onAction: () => handleRunAssetJob({ name: AssetJobName.RegenerateThumbnail, assetIds: [asset.id] }),
  };

  const TranscodeVideoJob: ActionItem = {
    title: $t('refresh_encoded_videos'),
    icon: mdiCogRefreshOutline,
    onAction: () => handleRunAssetJob({ name: AssetJobName.TranscodeVideo, assetIds: [asset.id] }),
    $if: () => asset.type === AssetTypeEnum.Video,
  };

  return {
    Share,
    Download,
    DownloadOriginal,
    SharedLinkDownload,
    Offline,
    Info,
    Favorite,
    Unfavorite,
    Rate,
    SetColorLabel,
    SetFlag,
    PlayMotionPhoto,
    StopMotionPhoto,
    PlaySlideshow,
    AddToAlbum,
    RemoveFromAlbum,
    ZoomIn,
    ZoomOut,
    Copy,
    Tag,
    TagPeople,
    Edit,
    SetProfilePicture,
    ViewInTimeline,
    ViewSimilar,
    RefreshFacesJob,
    RefreshMetadataJob,
    RegenerateThumbnailJob,
    TranscodeVideoJob,
  };
};

export const handleDownloadAsset = async (asset: AssetResponseDto, { edited }: { edited: boolean }) => {
  const $t = await getFormatter();

  const assets = [
    {
      filename: asset.originalFileName,
      id: asset.id,
      cacheKey: asset.thumbhash,
    },
  ];

  const isAndroidMotionVideo = (asset: AssetResponseDto) => {
    return asset.originalPath.includes('encoded-video');
  };

  if (asset.livePhotoVideoId) {
    const motionAsset = await getAssetInfo({ ...authManager.params, id: asset.livePhotoVideoId });
    if (
      !isAndroidMotionVideo(motionAsset) ||
      (authManager.authenticated && authManager.preferences.download.includeEmbeddedVideos)
    ) {
      const motionFilename = motionAsset.originalFileName;
      const lastDotIndex = motionFilename.lastIndexOf('.');
      const motionDownloadFilename =
        lastDotIndex > 0
          ? `${motionFilename.slice(0, lastDotIndex)}-motion${motionFilename.slice(lastDotIndex)}`
          : `${motionFilename}-motion`;
      assets.push({
        filename: motionDownloadFilename,
        id: asset.livePhotoVideoId,
        cacheKey: motionAsset.thumbhash,
      });
    }
  }

  for (const [i, { filename, id, cacheKey }] of assets.entries()) {
    if (i !== 0) {
      // play nice with Safari
      await sleep(500);
    }

    try {
      toastManager.primary($t('downloading_asset_filename', { values: { filename } }));
      downloadUrl(getAssetMediaUrl({ id, size: AssetMediaSize.Original, edited, cacheKey }), filename);
    } catch (error) {
      handleError(error, $t('errors.error_downloading', { values: { filename } }));
    }
  }
};

const handleFavorite = async (asset: AssetResponseDto) => {
  const $t = await getFormatter();

  try {
    const response = await updateAsset({ id: asset.id, updateAssetDto: { isFavorite: true } });
    toastManager.primary($t('added_to_favorites'));
    eventManager.emit('AssetUpdate', response);
  } catch (error) {
    handleError(error, $t('errors.unable_to_add_remove_favorites', { values: { favorite: asset.isFavorite } }));
  }
};

const handleUnfavorite = async (asset: AssetResponseDto) => {
  const $t = await getFormatter();

  try {
    const response = await updateAsset({ id: asset.id, updateAssetDto: { isFavorite: false } });
    toastManager.primary($t('removed_from_favorites'));
    eventManager.emit('AssetUpdate', response);
  } catch (error) {
    handleError(error, $t('errors.unable_to_add_remove_favorites', { values: { favorite: asset.isFavorite } }));
  }
};

export const handleRate = async (asset: AssetResponseDto, rating: number) => {
  // per-user state is never written from a shared link view, even by a logged-in owner
  if (authManager.isSharedLink) {
    return;
  }

  const $t = await getFormatter();

  if (Number.isNaN(rating)) {
    toastManager.info($t('rate_asset_description'));
    return;
  }

  // the UI only offers 0-5; reject (-1) is not available from here, and never for non-owners
  if (rating < 0) {
    return;
  }

  const newRating = rating === 0 ? null : rating;
  if (asset.exifInfo && asset.exifInfo.rating === newRating) {
    return;
  }

  try {
    const response = await updateAsset({ id: asset.id, updateAssetDto: { rating: newRating } });
    eventManager.emit('AssetUpdate', response);
  } catch (error) {
    handleError(error, $t('errors.unable_to_set_rating'));
  }
};

export const handleSetColorLabel = async (asset: AssetResponseDto, colorLabel: AssetColorLabel | null) => {
  if (authManager.isSharedLink) {
    return;
  }

  const $t = await getFormatter();

  try {
    const response = await updateAsset({ id: asset.id, updateAssetDto: { colorLabel } });
    eventManager.emit('AssetUpdate', response);
  } catch (error) {
    handleError(error, $t('errors.cant_apply_changes'));
  }
};

export const handleSetFlag = async (asset: AssetResponseDto, flag: AssetFlag | null) => {
  if (authManager.isSharedLink) {
    return;
  }

  const $t = await getFormatter();

  try {
    const response = await updateAsset({ id: asset.id, updateAssetDto: { flag } });
    eventManager.emit('AssetUpdate', response);
  } catch (error) {
    handleError(error, $t('errors.cant_apply_changes'));
  }
};

type UserStateUpdate = { rating: number | null } | { colorLabel: AssetColorLabel | null } | { flag: AssetFlag | null };

/** Sends a per-user state change for many assets and mirrors it onto the local asset objects. */
const bulkUpdateUserState = async (
  assets: TimelineAsset[],
  update: UserStateUpdate,
  apply: (asset: TimelineAsset) => void,
  messages: {
    success: 'rating_updated_count' | 'color_label_updated_count' | 'flag_updated_count';
    error: 'errors.unable_to_set_rating' | 'errors.cant_apply_changes';
  },
) => {
  // per-user state is never written from a shared link view, even by a logged-in owner
  if (authManager.isSharedLink || assets.length === 0) {
    return false;
  }

  const $t = await getFormatter();
  const ids = assets.map(({ id }) => id);

  try {
    await updateAssets({ assetBulkUpdateDto: { ids, ...update } });
    for (const asset of assets) {
      apply(asset);
    }
    toastManager.primary($t(messages.success, { values: { count: ids.length } }));
    return true;
  } catch (error) {
    handleError(error, $t(messages.error));
    return false;
  }
};

/** `null` clears the rating. Resolves to the updated ids, or `undefined` if nothing was changed. */
export const handleBulkRate = async (
  assets: TimelineAsset[],
  rating: number | null,
  onRated?: (ids: string[], rating: number | null) => void,
) => {
  const updated = await bulkUpdateUserState(assets, { rating }, (asset) => (asset.rating = rating), {
    success: 'rating_updated_count',
    error: 'errors.unable_to_set_rating',
  });
  if (!updated) {
    return;
  }

  const ids = assets.map(({ id }) => id);
  onRated?.(ids, rating);
  return ids;
};

/** `null` clears the label. Resolves to the updated ids, or `undefined` if nothing was changed. */
export const handleBulkSetColorLabel = async (
  assets: TimelineAsset[],
  colorLabel: AssetColorLabel | null,
  onLabeled?: (ids: string[], label: AssetColorLabel | null) => void,
) => {
  const updated = await bulkUpdateUserState(assets, { colorLabel }, (asset) => (asset.colorLabel = colorLabel), {
    success: 'color_label_updated_count',
    error: 'errors.cant_apply_changes',
  });
  if (!updated) {
    return;
  }

  const ids = assets.map(({ id }) => id);
  onLabeled?.(ids, colorLabel);
  return ids;
};

/** `null` clears the flag. Resolves to the updated ids, or `undefined` if nothing was changed. */
export const handleBulkSetFlag = async (
  assets: TimelineAsset[],
  flag: AssetFlag | null,
  onFlagged?: (ids: string[], flag: AssetFlag | null) => void,
) => {
  const updated = await bulkUpdateUserState(assets, { flag }, (asset) => (asset.flag = flag), {
    success: 'flag_updated_count',
    error: 'errors.cant_apply_changes',
  });
  if (!updated) {
    return;
  }

  const ids = assets.map(({ id }) => id);
  onFlagged?.(ids, flag);
  return ids;
};

/** Toggle semantics: if every target already has the label it is cleared, otherwise it is set. */
export const nextColorLabel = (assets: Array<{ colorLabel?: AssetColorLabel | null }>, label: AssetColorLabel) =>
  assets.length > 0 && assets.every((asset) => asset.colorLabel === label) ? null : label;

const colorLabelForKey = (key: string) =>
  (Object.entries(colorLabelShortcut) as Array<[AssetColorLabel, string]>).find(([, value]) => value === key)?.[0];

type BulkUserStateShortcutOptions = {
  getAssets: () => TimelineAsset[];
  onRated?: (ids: string[], rating: number | null) => void;
  onLabeled?: (ids: string[], label: AssetColorLabel | null) => void;
  onFlagged?: (ids: string[], flag: AssetFlag | null) => void;
  /** called after a successful update, e.g. to clear the selection */
  onDone?: () => void;
};

/**
 * Keyboard shortcuts for the multi-select context: `0`-`5` rate (`0` clears), `6`-`9` toggle a color label and
 * `k`/`r`/`u` pick, reject and clear the flag. Nothing is registered in a shared-link context, and rating keys are skipped when ratings are disabled.
 */
export const getBulkUserStateShortcuts = ({
  getAssets,
  onRated,
  onLabeled,
  onFlagged,
  onDone,
}: BulkUserStateShortcutOptions): ShortcutOptions[] => {
  if (authManager.isSharedLink || !authManager.authenticated) {
    return [];
  }

  const options: ShortcutOptions[] = [];

  if (authManager.preferences.ratings.enabled) {
    for (const key of [0, 1, 2, 3, 4, 5]) {
      options.push({
        shortcut: { key: String(key) },
        onShortcut: async () => {
          if (await handleBulkRate(getAssets(), key === 0 ? null : key, onRated)) {
            onDone?.();
          }
        },
      });
    }
  }

  for (const [label, key] of Object.entries(colorLabelShortcut) as Array<[AssetColorLabel, string]>) {
    options.push({
      shortcut: { key },
      onShortcut: async () => {
        const assets = getAssets();
        if (await handleBulkSetColorLabel(assets, nextColorLabel(assets, label), onLabeled)) {
          onDone?.();
        }
      },
    });
  }

  for (const flag of [AssetFlag.Pick, AssetFlag.Reject]) {
    options.push({
      shortcut: { key: flagShortcut[flag] },
      onShortcut: async () => {
        const assets = getAssets();
        if (await handleBulkSetFlag(assets, nextFlag(assets, flag), onFlagged)) {
          onDone?.();
        }
      },
    });
  }

  options.push({
    shortcut: { key: clearFlagShortcut },
    onShortcut: async () => {
      if (await handleBulkSetFlag(getAssets(), null, onFlagged)) {
        onDone?.();
      }
    },
  });

  return options;
};

export const handleTagAssets = async (assetIds: string[], tagIds: string[]) => {
  const $t = await getFormatter();

  try {
    const response = await bulkTagAssets({ tagBulkAssetsDto: { assetIds, tagIds } });
    toastManager.primary($t('tagged_assets', { values: { count: response.count } }));
    eventManager.emit('AssetsTag', assetIds);
    return true;
  } catch (error) {
    handleError(error, $t('errors.failed_to_tag_assets'));
    return false;
  }
};

const handleBulkRemoveAssetsFromAlbum = async (assetIds: string[], album: AlbumResponseDto) => {
  const $t = await getFormatter();

  const isConfirmed = await modalManager.showDialog({
    prompt: $t('remove_assets_album_confirmation', { values: { count: assetIds.length } }),
  });

  if (!isConfirmed) {
    return;
  }

  await handleRemoveAssetsFromAlbum(assetIds, album);
  assetMultiSelectManager.clear();
};

const handleRemoveAssetsFromAlbum = async (assetIds: string[], album: AlbumResponseDto) => {
  const $t = await getFormatter();

  try {
    const results = await removeAssetFromAlbum({
      id: album.id,
      bulkIdsDto: { ids: assetIds },
    });

    const count = results.filter(({ success }) => success).length;

    toastManager.primary($t('assets_removed_count', { values: { count } }));
    eventManager.emit('AlbumRemoveAssets', { assetIds, albumIds: [album.id] });
  } catch (error) {
    handleError(error, $t('errors.error_removing_assets_from_album'));
  }
};

const getAssetJobMessage = ($t: MessageFormatter, job: AssetJobName) => {
  const messages: Record<AssetJobName, string> = {
    [AssetJobName.RefreshFaces]: $t('refreshing_faces'),
    [AssetJobName.RefreshMetadata]: $t('refreshing_metadata'),
    [AssetJobName.RegenerateThumbnail]: $t('regenerating_thumbnails'),
    [AssetJobName.TranscodeVideo]: $t('refreshing_encoded_video'),
  };

  return messages[job];
};

const handleRunAssetJob = async (dto: AssetJobsDto) => {
  const $t = await getFormatter();

  try {
    await runAssetJobs({ assetJobsDto: dto });
    toastManager.primary(getAssetJobMessage($t, dto.name));
  } catch (error) {
    handleError(error, $t('errors.unable_to_submit_job'));
  }
};
