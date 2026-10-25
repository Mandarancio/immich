import { AssetColorLabel, AssetFlag } from '@immich/sdk';
import { get } from 'svelte/store';
import {
  COMPARE_MAX,
  compareGrid,
  compareManager,
  MAX_CONCURRENT_ORIGINALS,
} from '$lib/managers/compare-manager.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { handleBulkRate, handleBulkSetColorLabel, handleBulkSetFlag } from '$lib/services/asset.service';
import { compareRejectBehavior } from '$lib/stores/preferences.store';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';

vi.mock('$lib/services/asset.service', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/services/asset.service')>();
  return {
    ...original,
    handleBulkSetFlag: vi.fn(),
    handleBulkRate: vi.fn(),
    handleBulkSetColorLabel: vi.fn(),
  };
});

const build = (count: number) => timelineAssetFactory.buildList(count);
const ids = (assets: TimelineAsset[]) => assets.map(({ id }) => id);

describe('compareGrid', () => {
  it.each([
    [1, 1, 1],
    [2, 2, 1],
    [3, 3, 1],
    [4, 2, 2],
    [5, 3, 2],
    [6, 3, 2],
  ])('lays out %i photos as %i x %i', (count, columns, rows) => {
    expect(compareGrid(count)).toEqual({ columns, rows });
  });
});

describe('CompareManager', () => {
  const onUpdated = vi.fn();

  beforeEach(() => {
    compareManager.close();
    compareRejectBehavior.set('remove');
    onUpdated.mockReset();

    vi.mocked(handleBulkSetFlag).mockReset();
    vi.mocked(handleBulkRate).mockReset();
    vi.mocked(handleBulkSetColorLabel).mockReset();

    // mimic the real helpers: apply locally and notify, resolve to the ids
    vi.mocked(handleBulkSetFlag).mockImplementation((assets, flag, callback) => {
      for (const asset of assets) {
        asset.flag = flag;
      }
      callback?.(ids(assets), flag);
      return Promise.resolve(ids(assets));
    });
    vi.mocked(handleBulkRate).mockImplementation((assets, rating, callback) => {
      for (const asset of assets) {
        asset.rating = rating;
      }
      callback?.(ids(assets), rating);
      return Promise.resolve(ids(assets));
    });
    vi.mocked(handleBulkSetColorLabel).mockImplementation((assets, label, callback) => {
      for (const asset of assets) {
        asset.colorLabel = label;
      }
      callback?.(ids(assets), label);
      return Promise.resolve(ids(assets));
    });
  });

  afterAll(() => compareManager.close());

  describe('open', () => {
    it('refuses fewer than two or more than six assets', () => {
      expect(compareManager.open(build(1))).toBe(false);
      expect(compareManager.open(build(COMPARE_MAX + 1))).toBe(false);
      expect(compareManager.isOpen).toBe(false);
    });

    it.each([2, 3, 4, 5, 6])('accepts %i assets', (count) => {
      const assets = build(count);
      expect(compareManager.open(assets)).toBe(true);
      expect(compareManager.isOpen).toBe(true);
      expect(compareManager.remaining).toBe(count);
      expect(compareManager.focusedId).toBe(assets[0].id);
      expect(compareManager.focused?.id).toBe(assets[0].id);
    });

    it('resets the zoom and removed assets of a previous session', () => {
      const assets = build(3);
      compareManager.open(assets);
      compareManager.reportZoom(assets[0].id, { ...compareManager.zoomState, currentZoom: 3 });
      compareManager.remove(assets[1].id);

      compareManager.open(build(2));
      expect(compareManager.zoomState.currentZoom).toBe(1);
      expect(compareManager.zoomSource).toBeUndefined();
      expect(compareManager.removedIds).toEqual([]);
    });
  });

  describe('close', () => {
    it('resets everything without notifying the timeline', () => {
      compareManager.open(build(3), onUpdated);
      compareManager.close();
      expect(compareManager.isOpen).toBe(false);
      expect(compareManager.assets).toEqual([]);
      expect(compareManager.focusedId).toBeUndefined();
      expect(onUpdated).not.toHaveBeenCalled();
    });
  });

  describe('focus', () => {
    it('wraps around when moving next and previous', () => {
      const assets = build(3);
      compareManager.open(assets);

      compareManager.focusPrevious();
      expect(compareManager.focusedId).toBe(assets[2].id);
      compareManager.focusNext();
      expect(compareManager.focusedId).toBe(assets[0].id);
      compareManager.focusNext();
      expect(compareManager.focusedId).toBe(assets[1].id);
    });

    it('focuses a given visible asset', () => {
      const assets = build(3);
      compareManager.open(assets);
      compareManager.focus(assets[2].id);
      expect(compareManager.focusedId).toBe(assets[2].id);
    });

    it('does nothing when nothing is open', () => {
      compareManager.focusNext();
      compareManager.focusPrevious();
      expect(compareManager.focusedId).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('re-tiles the grid', () => {
      compareManager.open(build(5));
      expect(compareManager.grid).toEqual({ columns: 3, rows: 2 });
      compareManager.remove();
      expect(compareManager.remaining).toBe(4);
      expect(compareManager.grid).toEqual({ columns: 2, rows: 2 });
    });

    it('moves focus to the following asset, or the previous one at the end', () => {
      const assets = build(3);
      compareManager.open(assets);

      compareManager.remove(assets[0].id);
      expect(compareManager.focusedId).toBe(assets[1].id);

      compareManager.focus(assets[2].id);
      compareManager.remove();
      expect(compareManager.focusedId).toBe(assets[1].id);
      expect(ids(compareManager.visible)).toEqual([assets[1].id]);
    });

    it('keeps focus when removing an unfocused asset', () => {
      const assets = build(3);
      compareManager.open(assets);
      compareManager.remove(assets[2].id);
      expect(compareManager.focusedId).toBe(assets[0].id);
      expect(compareManager.removedIds).toEqual([assets[2].id]);
    });

    it('closes when the last visible asset is removed', () => {
      const assets = build(2);
      compareManager.open(assets);
      compareManager.remove();
      expect(compareManager.isOpen).toBe(true);
      compareManager.remove();
      expect(compareManager.isOpen).toBe(false);
    });
  });

  describe('setFlag', () => {
    it('forwards a successful change to the timeline', async () => {
      const assets = build(2);
      compareManager.open(assets, onUpdated);
      await compareManager.setFlag(AssetFlag.Pick);
      const [targets, flag] = vi.mocked(handleBulkSetFlag).mock.calls[0];
      expect(ids(targets)).toEqual([assets[0].id]);
      expect(flag).toBe(AssetFlag.Pick);
      expect(onUpdated).toHaveBeenCalledWith([assets[0].id], { flag: AssetFlag.Pick });
      expect(compareManager.focused?.flag).toBe(AssetFlag.Pick);
    });

    it('changes nothing when the server rejects the update', async () => {
      const assets = build(2);
      compareManager.open(assets, onUpdated);
      vi.mocked(handleBulkSetFlag).mockResolvedValue(undefined);

      await compareManager.setFlag(AssetFlag.Reject);

      expect(onUpdated).not.toHaveBeenCalled();
      expect(compareManager.focused?.flag).toBeNull();
      expect(compareManager.remaining).toBe(2);
      expect(compareManager.focusedId).toBe(assets[0].id);
    });

    it('removes a rejected asset by default', async () => {
      const assets = build(3);
      compareManager.open(assets, onUpdated);
      await compareManager.setFlag(AssetFlag.Reject);
      expect(onUpdated).toHaveBeenCalledWith([assets[0].id], { flag: AssetFlag.Reject });
      expect(ids(compareManager.visible)).toEqual([assets[1].id, assets[2].id]);
      expect(compareManager.focusedId).toBe(assets[1].id);
    });

    it('keeps a rejected asset and focuses the next non-rejected one when dimming', async () => {
      compareRejectBehavior.set('dim');
      const assets = build(4);
      assets[1].flag = AssetFlag.Reject;
      compareManager.open(assets);

      await compareManager.setFlag(AssetFlag.Reject);

      expect(compareManager.remaining).toBe(4);
      expect(compareManager.focusedId).toBe(assets[2].id);
      expect(get(compareRejectBehavior)).toBe('dim');
    });

    it('leaves focus in place when everything else is rejected while dimming', async () => {
      compareRejectBehavior.set('dim');
      const assets = build(2);
      assets[1].flag = AssetFlag.Reject;
      compareManager.open(assets);

      await compareManager.setFlag(AssetFlag.Reject);

      expect(compareManager.remaining).toBe(2);
      expect(compareManager.focusedId).toBe(assets[0].id);
    });

    it('does not remove on pick or clear', async () => {
      const assets = build(2);
      compareManager.open(assets);
      await compareManager.setFlag(AssetFlag.Pick);
      await compareManager.setFlag(null);
      expect(compareManager.remaining).toBe(2);
    });
  });

  describe('toggleFlag', () => {
    it('sets the flag, then clears it when already set', async () => {
      const assets = build(2);
      compareManager.open(assets, onUpdated);

      await compareManager.toggleFlag(AssetFlag.Pick);
      expect(onUpdated).toHaveBeenLastCalledWith([assets[0].id], { flag: AssetFlag.Pick });

      await compareManager.toggleFlag(AssetFlag.Pick);
      expect(onUpdated).toHaveBeenLastCalledWith([assets[0].id], { flag: null });
    });

    it('removes the asset when toggling reject on', async () => {
      compareManager.open(build(3));
      await compareManager.toggleFlag(AssetFlag.Reject);
      expect(compareManager.remaining).toBe(2);
    });
  });

  describe('rate', () => {
    it('forwards the rating, and null to clear it', async () => {
      const assets = build(2);
      compareManager.open(assets, onUpdated);

      await compareManager.rate(4);
      const [targets, rating] = vi.mocked(handleBulkRate).mock.calls[0];
      expect(ids(targets)).toEqual([assets[0].id]);
      expect(rating).toBe(4);
      expect(onUpdated).toHaveBeenLastCalledWith([assets[0].id], { rating: 4 });

      await compareManager.rate(null);
      expect(onUpdated).toHaveBeenLastCalledWith([assets[0].id], { rating: null });
    });

    it('changes nothing on failure', async () => {
      const assets = build(2);
      compareManager.open(assets, onUpdated);
      vi.mocked(handleBulkRate).mockResolvedValue(undefined);
      await compareManager.rate(3);
      expect(onUpdated).not.toHaveBeenCalled();
      expect(compareManager.focused?.rating).toBeNull();
    });
  });

  describe('toggleColor', () => {
    it('sets the label, then clears it when already set', async () => {
      const assets = build(2);
      compareManager.open(assets, onUpdated);

      await compareManager.toggleColor(AssetColorLabel.Red);
      expect(onUpdated).toHaveBeenLastCalledWith([assets[0].id], { colorLabel: AssetColorLabel.Red });

      await compareManager.toggleColor(AssetColorLabel.Red);
      expect(onUpdated).toHaveBeenLastCalledWith([assets[0].id], { colorLabel: null });
    });
  });

  describe('writes in flight while the session changes', () => {
    // a helper mock that only applies and notifies once `finish` is called
    const defer = <T>(mock: { mockImplementationOnce: (fn: (...args: never[]) => Promise<string[]>) => unknown }) => {
      let finish!: () => void;
      mock.mockImplementationOnce(
        ((assets: TimelineAsset[], value: T, callback?: (ids: string[], value: T) => void) =>
          new Promise<string[]>((resolve) => {
            finish = () => {
              callback?.(ids(assets), value);
              resolve(ids(assets));
            };
          })) as never,
      );
      return () => finish();
    };

    const mutations = [
      {
        name: 'setFlag',
        mock: () => vi.mocked(handleBulkSetFlag),
        run: () => compareManager.setFlag(AssetFlag.Pick),
        update: { flag: AssetFlag.Pick },
      },
      {
        name: 'rate',
        mock: () => vi.mocked(handleBulkRate),
        run: () => compareManager.rate(4),
        update: { rating: 4 },
      },
      {
        name: 'toggleColor',
        mock: () => vi.mocked(handleBulkSetColorLabel),
        run: () => compareManager.toggleColor(AssetColorLabel.Red),
        update: { colorLabel: AssetColorLabel.Red },
      },
    ];

    it.each(mutations)('$name still notifies the original callback after close()', async ({ mock, run, update }) => {
      const assets = build(2);
      compareManager.open(assets, onUpdated);
      const finish = defer(mock() as never);

      const pending = run();
      compareManager.close();
      finish();
      await pending;

      expect(onUpdated).toHaveBeenCalledTimes(1);
      expect(onUpdated).toHaveBeenCalledWith([assets[0].id], update);
    });

    it.each(mutations)('$name does not leak into a newly opened session', async ({ mock, run, update }) => {
      const assets = build(2);
      const otherUpdated = vi.fn();
      compareManager.open(assets, onUpdated);
      const finish = defer(mock() as never);

      const pending = run();
      compareManager.close();
      compareManager.open(build(2), otherUpdated);
      finish();
      await pending;

      expect(onUpdated).toHaveBeenCalledWith([assets[0].id], update);
      expect(otherUpdated).not.toHaveBeenCalled();
    });
  });

  describe('zoom', () => {
    it('only loads originals while zoomed in', () => {
      const assets = build(5);
      compareManager.open(assets);
      expect(compareManager.originalIds).toEqual([]);

      compareManager.focus(assets[3].id);
      compareManager.reportZoom(assets[3].id, { ...compareManager.zoomState, currentZoom: 2 });

      expect(compareManager.originalIds).toHaveLength(MAX_CONCURRENT_ORIGINALS);
      expect(compareManager.originalIds[0]).toBe(assets[3].id);
    });

    it('stores the reported state and its source', () => {
      const assets = build(2);
      compareManager.open(assets);
      const state = { ...compareManager.zoomState, currentZoom: 2.5, currentPositionX: 10 };
      compareManager.reportZoom(assets[1].id, state);
      expect(compareManager.zoomState).toEqual(state);
      expect(compareManager.zoomSource).toBe(assets[1].id);
    });

    it('alternates between fit and the natural zoom of the focused slot', () => {
      const assets = build(2);
      compareManager.open(assets);
      compareManager.setNaturalZoom(assets[0].id, 3);

      compareManager.toggleActualSize();
      expect(compareManager.zoomState.currentZoom).toBe(3);
      compareManager.toggleActualSize();
      expect(compareManager.zoomState.currentZoom).toBe(1);
    });

    it('falls back to 2x when the natural zoom is unknown', () => {
      compareManager.open(build(2));
      compareManager.toggleActualSize();
      expect(compareManager.zoomState.currentZoom).toBe(2);
    });
  });
});
