import { AssetFlag, type AssetColorLabel } from '@immich/sdk';
import type { ZoomImageWheelState } from '@zoom-image/core';
import { get } from 'svelte/store';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import {
  handleBulkRate,
  handleBulkSetColorLabel,
  handleBulkSetFlag,
  nextColorLabel,
} from '$lib/services/asset.service';
import { compareRejectBehavior } from '$lib/stores/preferences.store';
import { nextFlag } from '$lib/utils/flag';

export const COMPARE_MIN = 2;
export const COMPARE_MAX = 6;
export const MAX_CONCURRENT_ORIGINALS = 3;

/** Zoom used by `toggleActualSize` when the natural zoom of the focused slot is not known (yet). */
const FALLBACK_ACTUAL_SIZE_ZOOM = 2;

export type CompareUpdate = Partial<Pick<TimelineAsset, 'flag' | 'rating' | 'colorLabel'>>;

/** Grid for n visible photos: 1 full, 2 side by side, 3 in a row, 4 as 2x2, 5-6 as 3x2. */
export const compareGrid = (count: number): { columns: number; rows: number } => {
  if (count <= 1) {
    return { columns: 1, rows: 1 };
  }
  if (count === 2) {
    return { columns: 2, rows: 1 };
  }
  if (count === 3) {
    return { columns: 3, rows: 1 };
  }
  if (count === 4) {
    return { columns: 2, rows: 2 };
  }
  return { columns: 3, rows: 2 };
};

const createDefaultZoomState = (): ZoomImageWheelState => ({
  currentRotation: 0,
  currentZoom: 1,
  enable: true,
  currentPositionX: 0,
  currentPositionY: 0,
});

class CompareManager {
  isOpen = $state(false);
  assets = $state<TimelineAsset[]>([]);
  removedIds = $state<string[]>([]);
  focusedId = $state<string | undefined>();
  zoomState = $state<ZoomImageWheelState>(createDefaultZoomState());
  zoomSource = $state<string | undefined>();
  #naturalZoom: Record<string, number> = {};
  #onUpdated?: (ids: string[], update: CompareUpdate) => void;

  get visible(): TimelineAsset[] {
    return this.assets.filter(({ id }) => !this.removedIds.includes(id));
  }

  get grid() {
    return compareGrid(this.visible.length);
  }

  get focused(): TimelineAsset | undefined {
    return this.visible.find(({ id }) => id === this.focusedId);
  }

  get remaining() {
    return this.visible.length;
  }

  /** Assets whose original should be loaded: none unless zoomed in, the focused one first. */
  get originalIds(): string[] {
    if (this.zoomState.currentZoom <= 1) {
      return [];
    }
    const ids = this.visible.map(({ id }) => id);
    const focusedId = this.focusedId;
    const ordered = focusedId && ids.includes(focusedId) ? [focusedId, ...ids.filter((id) => id !== focusedId)] : ids;
    return ordered.slice(0, MAX_CONCURRENT_ORIGINALS);
  }

  /** Returns `false` (and does nothing) when the number of assets is outside the supported range. */
  open(assets: TimelineAsset[], onUpdated?: (ids: string[], update: CompareUpdate) => void): boolean {
    if (assets.length < COMPARE_MIN || assets.length > COMPARE_MAX) {
      return false;
    }
    this.assets = [...assets];
    this.removedIds = [];
    this.focusedId = assets[0].id;
    this.#resetZoom();
    this.#naturalZoom = {};
    this.#onUpdated = onUpdated;
    this.isOpen = true;
    return true;
  }

  close() {
    this.isOpen = false;
    this.assets = [];
    this.removedIds = [];
    this.focusedId = undefined;
    this.#resetZoom();
    this.#naturalZoom = {};
    this.#onUpdated = undefined;
  }

  focusNext() {
    this.#moveFocus(1);
  }

  focusPrevious() {
    this.#moveFocus(-1);
  }

  focus(id: string) {
    if (this.visible.some((asset) => asset.id === id)) {
      this.focusedId = id;
    }
  }

  remove(id: string | undefined = this.focusedId) {
    if (!id) {
      return;
    }
    const visible = this.visible;
    const index = visible.findIndex((asset) => asset.id === id);
    if (index === -1) {
      return;
    }

    this.removedIds = [...this.removedIds, id];
    const remaining = this.visible;
    if (remaining.length === 0) {
      this.close();
      return;
    }
    if (this.focusedId === id) {
      this.focusedId = remaining[Math.min(index, remaining.length - 1)].id;
    }
  }

  reportZoom(sourceId: string, state: ZoomImageWheelState) {
    this.zoomState = state;
    this.zoomSource = sourceId;
  }

  toggleActualSize() {
    const zoomedIn = this.zoomState.currentZoom !== 1;
    const natural = this.focusedId ? this.#naturalZoom[this.focusedId] : undefined;
    const target = zoomedIn ? 1 : natural && natural > 1 ? natural : FALLBACK_ACTUAL_SIZE_ZOOM;
    // no source: every slot follows
    this.zoomState = { ...this.zoomState, currentZoom: target, currentPositionX: 0, currentPositionY: 0 };
    this.zoomSource = undefined;
  }

  setNaturalZoom(id: string, zoom: number) {
    this.#naturalZoom[id] = zoom;
  }

  async setFlag(flag: AssetFlag | null) {
    const asset = this.focused;
    if (!asset) {
      return;
    }

    // captured now: close() or a new open() may run while the write is in flight
    const onUpdated = this.#onUpdated;
    const ids = await handleBulkSetFlag([asset], flag, (ids, flag) => onUpdated?.(ids, { flag }));
    if (!ids || flag !== AssetFlag.Reject || !this.isOpen) {
      return;
    }

    if (get(compareRejectBehavior) === 'remove') {
      this.remove(asset.id);
    } else if (this.focusedId === asset.id) {
      this.#focusNextNonRejected();
    }
  }

  async toggleFlag(flag: AssetFlag) {
    const asset = this.focused;
    if (asset) {
      await this.setFlag(nextFlag([asset], flag));
    }
  }

  async rate(rating: number | null) {
    const asset = this.focused;
    if (asset) {
      const onUpdated = this.#onUpdated;
      await handleBulkRate([asset], rating, (ids, rating) => onUpdated?.(ids, { rating }));
    }
  }

  async toggleColor(label: AssetColorLabel) {
    const asset = this.focused;
    if (asset) {
      const onUpdated = this.#onUpdated;
      await handleBulkSetColorLabel([asset], nextColorLabel([asset], label), (ids, colorLabel) =>
        onUpdated?.(ids, { colorLabel }),
      );
    }
  }

  #resetZoom() {
    this.zoomState = createDefaultZoomState();
    this.zoomSource = undefined;
  }

  #moveFocus(step: 1 | -1) {
    const visible = this.visible;
    if (visible.length === 0) {
      return;
    }
    const index = visible.findIndex(({ id }) => id === this.focusedId);
    const next = index === -1 ? 0 : (index + step + visible.length) % visible.length;
    this.focusedId = visible[next].id;
  }

  #focusNextNonRejected() {
    const visible = this.visible;
    const index = visible.findIndex(({ id }) => id === this.focusedId);
    for (let offset = 1; offset < visible.length; offset++) {
      const candidate = visible[(index + offset) % visible.length];
      if (candidate.flag !== AssetFlag.Reject) {
        this.focusedId = candidate.id;
        return;
      }
    }
  }
}

export const compareManager = new CompareManager();
