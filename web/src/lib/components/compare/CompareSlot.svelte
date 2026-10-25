<script lang="ts">
  import { compareManager } from '$lib/managers/compare-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { compareRejectBehavior, locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { isWebCompatibleImage } from '$lib/utils/asset-utils';
  import { colorLabelClass } from '$lib/utils/color-label';
  import { fromISODateTimeUTC } from '$lib/utils/timeline-util';
  import { AssetFlag, AssetMediaSize, getAssetInfo, type AssetResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiClose, mdiFlag, mdiStar } from '@mdi/js';
  import { createZoomImageWheel, type ZoomImageWheelState } from '@zoom-image/core';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: TimelineAsset;
    focused: boolean;
  };

  const { asset, focused }: Props = $props();

  type Lens = { x: number; y: number; width: number; height: number; u: number; v: number };

  const LENS_SIZE = 160;
  const MAX_ZOOM = 10;
  const ZOOM_EPSILON = 0.001;
  const POSITION_EPSILON = 0.5;

  let info = $state<AssetResponseDto>();
  let originalLoaded = $state(false);
  let container = $state<HTMLElement>();
  let imageElement = $state<HTMLImageElement>();
  let rootElement = $state<HTMLElement>();
  // set once the image has loaded, the aspect ratio is needed to locate the picture inside the element
  let naturalSize = $state<{ width: number; height: number }>();
  let lens = $state<Lens>();

  let zoomInstance: ReturnType<typeof createZoomImageWheel> | undefined;
  let unsubscribeZoom: (() => void) | undefined;
  // true while a foreign state is applied, so the notifications it causes are not reported back
  let applying = false;

  const previewUrl = $derived(
    getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash }),
  );
  const originalUrl = $derived(
    getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Original, cacheKey: asset.thumbhash }),
  );
  const webCompatible = $derived(info ? isWebCompatibleImage(info) : undefined);
  const wantsOriginal = $derived(webCompatible === true && compareManager.originalIds.includes(asset.id));
  const src = $derived(originalLoaded ? originalUrl : previewUrl);

  const showRating = $derived(
    !authManager.isSharedLink &&
      authManager.authenticated &&
      authManager.preferences.ratings.enabled &&
      (asset.rating ?? 0) > 0,
  );
  const dimmed = $derived(asset.flag === AssetFlag.Reject && $compareRejectBehavior === 'dim');
  const exif = $derived(info?.exifInfo);
  const capturedAt = $derived(
    info?.localDateTime
      ? fromISODateTimeUTC(info.localDateTime).toLocaleString(
          { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' },
          { locale: $locale },
        )
      : undefined,
  );

  onMount(() => {
    let cancelled = false;
    getAssetInfo({ id: asset.id })
      .then((result) => {
        if (!cancelled) {
          info = result;
        }
      })
      .catch((error) => console.error(`[CompareSlot] failed to load asset info ${error}`, error));
    return () => {
      cancelled = true;
    };
  });

  // preload the original, so the swap has no blank frame
  $effect(() => {
    if (!wantsOriginal || originalLoaded) {
      return;
    }
    const preload = new Image();
    const onLoad = () => (originalLoaded = true);
    preload.addEventListener('load', onLoad);
    preload.src = originalUrl;
    return () => {
      preload.removeEventListener('load', onLoad);
      if (!originalLoaded) {
        // not needed (anymore): stop downloading
        preload.src = '';
      }
    };
  });

  const destroyZoom = () => {
    unsubscribeZoom?.();
    zoomInstance?.cleanup();
    unsubscribeZoom = undefined;
    zoomInstance = undefined;
  };

  const createZoom = (initialState: ZoomImageWheelState) => {
    destroyZoom();
    if (!container) {
      return;
    }
    const instance = createZoomImageWheel(container, { maxZoom: MAX_ZOOM, initialState });
    unsubscribeZoom = instance.subscribe(({ state }) => {
      if (!applying) {
        compareManager.reportZoom(asset.id, state);
      }
    });
    zoomInstance = instance;
  };

  const differs = (current: ZoomImageWheelState, next: ZoomImageWheelState) => ({
    zoom: Math.abs(current.currentZoom - next.currentZoom) > ZOOM_EPSILON,
    pan:
      Math.abs(current.currentPositionX - next.currentPositionX) > POSITION_EPSILON ||
      Math.abs(current.currentPositionY - next.currentPositionY) > POSITION_EPSILON,
  });

  const applyZoom = (next: ZoomImageWheelState, source: string | undefined) => {
    if (!zoomInstance || source === asset.id) {
      return;
    }

    let change = differs(zoomInstance.getState(), next);
    if (change.zoom) {
      applying = true;
      try {
        // zoom-image zooms around the center of the slot
        zoomInstance.setState({ currentZoom: next.currentZoom });
      } finally {
        applying = false;
      }
      change = differs(zoomInstance.getState(), next);
    }

    // `setState` cannot move the image, so a pan made in another slot is applied by re-creating the instance
    // with the shared state. `source === undefined` is a programmatic zoom (`z`), which keeps the centered zoom.
    if (change.pan && source !== undefined) {
      createZoom({ ...next });
    }
  };

  onMount(() => {
    createZoom({ ...compareManager.zoomState });
    return destroyZoom;
  });

  $effect(() => {
    const next = $state.snapshot(compareManager.zoomState);
    const source = compareManager.zoomSource;
    untrack(() => applyZoom(next, source));
  });

  const reportNaturalZoom = () => {
    const image = imageElement;
    if (!image || !image.naturalWidth || !image.clientWidth || !image.clientHeight) {
      return;
    }
    // the picture is letterboxed inside the (contained) element
    const renderedWidth = Math.min(image.clientWidth, (image.clientHeight * image.naturalWidth) / image.naturalHeight);
    compareManager.setNaturalZoom(asset.id, image.naturalWidth / renderedWidth);
  };

  const onImageLoad = () => {
    const image = imageElement;
    if (image?.naturalWidth && image.naturalHeight) {
      naturalSize = { width: image.naturalWidth, height: image.naturalHeight };
    }
    reportNaturalZoom();
  };

  /** The picture (not the letterboxed element) in viewport coordinates, including the zoom transform. */
  const getPictureRect = () => {
    const image = imageElement;
    if (!image?.naturalWidth || !image.naturalHeight) {
      return;
    }
    const box = image.getBoundingClientRect();
    if (!box.width || !box.height) {
      return;
    }
    const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!compareManager.magnifierEnabled) {
      return;
    }
    const rect = getPictureRect();
    if (!rect) {
      compareManager.clearMagnifierPoint(asset.id);
      return;
    }
    const u = (event.clientX - rect.left) / rect.width;
    const v = (event.clientY - rect.top) / rect.height;
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
      compareManager.setMagnifierPoint(asset.id, u, v);
    } else {
      compareManager.clearMagnifierPoint(asset.id);
    }
  };

  const onPointerLeave = () => compareManager.clearMagnifierPoint(asset.id);

  // keep the lens on the same relative image position, following the zoom and pan of the slot
  $effect(() => {
    const enabled = compareManager.magnifierEnabled;
    const point = compareManager.magnifierPoint;
    // re-run when the zoom or pan changes, or the image is swapped
    void compareManager.zoomState;
    void src;
    void compareManager.magnifierLevel;
    void naturalSize;
    untrack(() => {
      const root = rootElement;
      const rect = enabled && point ? getPictureRect() : undefined;
      if (!root || !rect || !point) {
        lens = undefined;
        return;
      }
      const rootBox = root.getBoundingClientRect();
      lens = {
        x: rect.left - rootBox.left + point.u * rect.width,
        y: rect.top - rootBox.top + point.v * rect.height,
        width: rect.width,
        height: rect.height,
        u: point.u,
        v: point.v,
      };
    });
  });

  const lensStyle = $derived.by(() => {
    if (!lens) {
      return;
    }
    const level = compareManager.magnifierLevel;
    const half = LENS_SIZE / 2;
    return [
      `left: ${lens.x - half}px`,
      `top: ${lens.y - half}px`,
      `width: ${LENS_SIZE}px`,
      `height: ${LENS_SIZE}px`,
      `background-image: url("${src}")`,
      'background-repeat: no-repeat',
      'background-origin: border-box',
      `background-size: ${lens.width * level}px ${lens.height * level}px`,
      `background-position: ${half - lens.u * lens.width * level}px ${half - lens.v * lens.height * level}px`,
    ].join('; ');
  });

  // the slot size changes with the grid (e.g. focus mode), which changes the natural zoom
  onMount(() => {
    if (!container) {
      return;
    }
    const observer = new ResizeObserver(() => reportNaturalZoom());
    observer.observe(container);
    return () => observer.disconnect();
  });

  onDestroy(() => compareManager.clearMagnifierPoint(asset.id));
</script>

<!-- keyboard handling is done by the compare view -->
<div
  bind:this={rootElement}
  data-testid="compare-slot"
  role="presentation"
  class={['relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-black transition-opacity', dimmed && 'opacity-40']}
  onclick={() => compareManager.focus(asset.id)}
>
  {#if focused}
    <div
      data-testid="compare-slot-focus-ring"
      class="pointer-events-none absolute inset-0 z-10 border-2 border-primary"
    ></div>
  {/if}

  <div
    bind:this={container}
    role="presentation"
    class={['min-h-0 flex-1', compareManager.magnifierEnabled && 'cursor-crosshair']}
    onpointermove={onPointerMove}
    onpointerleave={onPointerLeave}
  >
    <img
      bind:this={imageElement}
      data-testid="compare-slot-image"
      {src}
      alt=""
      class="size-full object-contain select-none"
      draggable="false"
      onload={onImageLoad}
    />
  </div>

  {#if lensStyle}
    <div
      data-testid="compare-slot-lens"
      class="pointer-events-none absolute z-10 rounded-full border-2 border-white/80 shadow-lg"
      style={lensStyle}
    ></div>
  {/if}

  <div
    class="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 bg-linear-to-b from-black/70 to-transparent p-2 text-white"
  >
    {#if !authManager.isSharedLink && asset.flag}
      <span
        data-testid="compare-slot-flag-{asset.flag}"
        role="img"
        aria-label={$t(asset.flag === AssetFlag.Pick ? 'flag_picked' : 'flag_rejected')}
        class={[
          'flex size-6 items-center justify-center rounded-full text-white',
          asset.flag === AssetFlag.Pick ? 'bg-green-600' : 'bg-red-600',
        ]}
      >
        <Icon icon={asset.flag === AssetFlag.Pick ? mdiFlag : mdiClose} size="16" aria-hidden />
      </span>
    {/if}
    {#if !authManager.isSharedLink && asset.colorLabel}
      <span
        data-testid="compare-slot-color"
        role="img"
        aria-label={$t(`color_label_${asset.colorLabel}`)}
        class={['size-3.5 rounded-full ring-1 ring-white/80', colorLabelClass[asset.colorLabel]]}
      ></span>
    {/if}
    {#if showRating}
      <span
        data-testid="compare-slot-rating"
        role="img"
        aria-label={$t('rating_count', { values: { count: asset.rating } })}
        class="text-white-shadow flex items-center text-sm font-medium"
      >
        <Icon icon={mdiStar} size="16" aria-hidden />
        {asset.rating}
      </span>
    {/if}
  </div>

  {#if exif || webCompatible === false}
    <div
      data-testid="compare-slot-exif"
      class="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-x-3 gap-y-1 bg-linear-to-t from-black/70 to-transparent p-2 text-xs text-white"
    >
      {#if exif?.fNumber}
        <span>ƒ/{exif.fNumber.toLocaleString($locale)}</span>
      {/if}
      {#if exif?.exposureTime}
        <span>{exif.exposureTime} s</span>
      {/if}
      {#if exif?.iso}
        <span>ISO {exif.iso}</span>
      {/if}
      {#if exif?.focalLength}
        <span>{exif.focalLength.toLocaleString($locale)} mm</span>
      {/if}
      {#if capturedAt}
        <span class="text-white/70">{capturedAt}</span>
      {/if}
      {#if webCompatible === false}
        <span class="rounded-sm bg-white/20 px-1.5 py-0.5">{$t('compare_preview_only')}</span>
      {/if}
    </div>
  {/if}
</div>
