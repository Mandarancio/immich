import { AssetColorLabel, AssetFlag, getAssetInfo } from '@immich/sdk';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import CompareSlot from '$lib/components/compare/CompareSlot.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { compareManager } from '$lib/managers/compare-manager.svelte';
import { compareRejectBehavior } from '$lib/stores/preferences.store';
import { assetFactory, timelineAssetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

type ZoomState = {
  currentRotation: number;
  currentZoom: number;
  enable: boolean;
  currentPositionX: number;
  currentPositionY: number;
};

const zoom = vi.hoisted(() => {
  const instances: Array<{
    options: { initialState?: Partial<ZoomState> };
    state: ZoomState;
    listener?: (event: { state: ZoomState }) => void;
    setState: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
    getState: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  }> = [];
  return { instances };
});

vi.mock('@zoom-image/core', () => ({
  createZoomImageWheel: vi.fn((_container: HTMLElement, options: { initialState?: Partial<ZoomState> } = {}) => {
    const instance = {
      options,
      state: {
        currentRotation: 0,
        currentZoom: 1,
        enable: true,
        currentPositionX: 0,
        currentPositionY: 0,
        ...options.initialState,
      },
      listener: undefined as ((event: { state: ZoomState }) => void) | undefined,
      setState: vi.fn(),
      cleanup: vi.fn(),
      getState: vi.fn(() => instance.state),
      subscribe: vi.fn((listener: (event: { state: ZoomState }) => void) => {
        instance.listener = listener;
        return () => {};
      }),
    };
    zoom.instances.push(instance);
    return instance;
  }),
}));

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAssetInfo: vi.fn(),
}));

const zoomed = (overrides: Partial<ZoomState> = {}): ZoomState => ({
  currentRotation: 0,
  currentZoom: 3,
  enable: true,
  currentPositionX: -40,
  currentPositionY: -20,
  ...overrides,
});

describe('CompareSlot', () => {
  const images: Array<{ src: string; load: () => void }> = [];

  const info = (overrides: Record<string, unknown> = {}) =>
    assetFactory.build({
      originalMimeType: 'image/jpeg',
      localDateTime: '2024-05-06T10:11:12.000Z',
      exifInfo: { fNumber: 2.8, exposureTime: '1/250', iso: 400, focalLength: 50 },
      ...overrides,
    });

  beforeEach(() => {
    compareManager.close();
    zoom.instances.length = 0;
    images.length = 0;
    compareRejectBehavior.set('remove');
    authManager.setUser(userAdminFactory.build({ id: 'viewer' }));
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: true } }));
    vi.mocked(getAssetInfo).mockReset();
    vi.stubGlobal(
      'Image',
      class FakeImage {
        #listeners = new Set<() => void>();
        #src = '';
        addEventListener(_type: string, listener: () => void) {
          this.#listeners.add(listener);
        }
        removeEventListener(_type: string, listener: () => void) {
          this.#listeners.delete(listener);
        }
        load() {
          for (const listener of this.#listeners) {
            listener();
          }
        }
        get src() {
          return this.#src;
        }
        set src(value: string) {
          this.#src = value;
          images.push(this);
        }
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    authManager.reset();
    compareManager.close();
  });

  it('shows the preview first and clicking focuses the slot', async () => {
    const asset = timelineAssetFactory.build();
    const other = timelineAssetFactory.build();
    compareManager.open([other, asset]);
    vi.mocked(getAssetInfo).mockResolvedValue(info());

    render(CompareSlot, { asset, focused: false });

    const image = screen.getByTestId('compare-slot-image') as HTMLImageElement;
    expect(image.src).toContain(`/assets/${asset.id}/thumbnail`);
    expect(image.src).toContain('size=preview');
    expect(getAssetInfo).toHaveBeenCalledWith({ id: asset.id });

    await fireEvent.click(screen.getByTestId('compare-slot'));
    expect(compareManager.focusedId).toBe(asset.id);
  });

  it('outlines the focused slot only', () => {
    const asset = timelineAssetFactory.build();
    vi.mocked(getAssetInfo).mockResolvedValue(info());

    const { unmount } = render(CompareSlot, { asset, focused: true });
    expect(screen.getByTestId('compare-slot-focus-ring')).toBeInTheDocument();
    unmount();

    render(CompareSlot, { asset, focused: false });
    expect(screen.queryByTestId('compare-slot-focus-ring')).not.toBeInTheDocument();
  });

  describe('original', () => {
    const zoomIn = () => compareManager.reportZoom('other', zoomed());

    it('swaps to the original once it has loaded when the shared zoom wants it and the type is web compatible', async () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());
      render(CompareSlot, { asset, focused: true });
      const image = screen.getByTestId('compare-slot-image') as HTMLImageElement;

      expect(images).toHaveLength(0);

      zoomIn();
      await waitFor(() => expect(images).toHaveLength(1));
      expect(images[0].src).toContain(`/assets/${asset.id}/original`);
      // still the preview until the original has been fetched
      expect(image.src).toContain('thumbnail');

      images[0].load();
      await waitFor(() => expect(image.src).toContain(`/assets/${asset.id}/original`));
    });

    it('does not load the original when the view is not zoomed', async () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());
      render(CompareSlot, { asset, focused: true });

      await tick();
      await waitFor(() => expect(getAssetInfo).toHaveBeenCalled());
      await tick();

      expect(images).toHaveLength(0);
    });

    it('does not load the original when the asset is outside of the original budget', async () => {
      const assets = timelineAssetFactory.buildList(5);
      compareManager.open(assets);
      vi.mocked(getAssetInfo).mockResolvedValue(info());
      compareManager.reportZoom('other', zoomed());
      expect(compareManager.originalIds).not.toContain(assets[4].id);

      render(CompareSlot, { asset: assets[4], focused: false });
      await waitFor(() => expect(getAssetInfo).toHaveBeenCalled());
      await tick();

      expect(images).toHaveLength(0);
    });

    it('keeps the preview and shows a hint for a RAW original', async () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info({ originalMimeType: 'image/x-adobe-dng' }));
      compareManager.reportZoom('other', zoomed());

      render(CompareSlot, { asset, focused: true });

      expect(await screen.findByText('compare_preview_only')).toBeDefined();
      expect(images).toHaveLength(0);
      expect((screen.getByTestId('compare-slot-image') as HTMLImageElement).src).toContain('thumbnail');
    });

    it('does not show the hint for a web compatible original', async () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());

      render(CompareSlot, { asset, focused: true });

      await screen.findByTestId('compare-slot-exif');
      expect(screen.queryByText('compare_preview_only')).toBeNull();
    });
  });

  describe('synced zoom', () => {
    it('creates a zoom instance seeded with the shared state and cleans it up', () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());

      const { unmount } = render(CompareSlot, { asset, focused: true });

      expect(zoom.instances).toHaveLength(1);
      expect(zoom.instances[0].options).toMatchObject({
        maxZoom: 10,
        initialState: compareManager.zoomState,
      });

      unmount();
      expect(zoom.instances[0].cleanup).toHaveBeenCalled();
    });

    it('reports its own zoom changes to the manager', () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());
      render(CompareSlot, { asset, focused: true });

      const state = zoomed();
      zoom.instances[0].listener?.({ state });

      expect(compareManager.zoomState).toEqual(state);
      expect(compareManager.zoomSource).toBe(asset.id);
    });

    it('applies a zoom state coming from another slot', async () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());
      render(CompareSlot, { asset, focused: true });

      compareManager.reportZoom('other', zoomed());
      await tick();

      expect(zoom.instances[0].setState).toHaveBeenCalledWith(expect.objectContaining({ currentZoom: 3 }));
    });

    it('ignores the state it reported itself (no feedback loop)', async () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());
      render(CompareSlot, { asset, focused: true });

      compareManager.reportZoom(asset.id, zoomed());
      await tick();

      expect(zoom.instances[0].setState).not.toHaveBeenCalled();
      expect(zoom.instances).toHaveLength(1);
    });

    it('does not re-apply a state the instance already has', async () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());
      render(CompareSlot, { asset, focused: true });
      zoom.instances[0].state = zoomed();

      compareManager.reportZoom('other', zoomed());
      await tick();

      expect(zoom.instances[0].setState).not.toHaveBeenCalled();
      expect(zoom.instances).toHaveLength(1);
    });

    it('does not report back the changes caused by applying a foreign state', async () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());
      render(CompareSlot, { asset, focused: true });
      // the library notifies synchronously from setState
      zoom.instances[0].setState.mockImplementation(() => {
        zoom.instances[0].listener?.({ state: zoomed({ currentPositionX: -99, currentPositionY: -99 }) });
      });

      const foreign = zoomed();
      compareManager.reportZoom('other', foreign);
      await tick();

      expect(compareManager.zoomState).toEqual(foreign);
      expect(compareManager.zoomSource).toBe('other');
    });

    it('applies the pan of another slot, which setState alone cannot do', async () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());
      render(CompareSlot, { asset, focused: true });
      // zoom already matches, only the pan differs
      zoom.instances[0].state = zoomed({ currentPositionX: 0, currentPositionY: 0 });

      compareManager.reportZoom('other', zoomed({ currentPositionX: -40, currentPositionY: -20 }));
      await tick();

      const latest = zoom.instances.at(-1)!;
      expect(zoom.instances.length).toBeGreaterThan(1);
      expect(latest.options.initialState).toMatchObject({
        currentZoom: 3,
        currentPositionX: -40,
        currentPositionY: -20,
      });
      expect(zoom.instances[0].cleanup).toHaveBeenCalled();
    });

    it('reports the natural zoom after the image loaded', async () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());
      const setNaturalZoom = vi.spyOn(compareManager, 'setNaturalZoom');
      render(CompareSlot, { asset, focused: true });
      const image = screen.getByTestId('compare-slot-image') as HTMLImageElement;
      Object.defineProperties(image, {
        naturalWidth: { value: 4000 },
        naturalHeight: { value: 3000 },
        clientWidth: { value: 1000 },
        clientHeight: { value: 750 },
      });

      await fireEvent.load(image);

      expect(setNaturalZoom).toHaveBeenCalledWith(asset.id, 4);
    });
  });

  describe('details', () => {
    it('renders exposure info and the capture time', async () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());

      render(CompareSlot, { asset, focused: true });

      const exif = await screen.findByTestId('compare-slot-exif');
      expect(exif.textContent).toContain('ƒ/2.8');
      expect(exif.textContent).toContain('1/250');
      expect(exif.textContent).toContain('ISO 400');
      expect(exif.textContent).toContain('50 mm');
      expect(exif.textContent).toContain('2024');
    });

    it('survives a failing asset info request', async () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockRejectedValue(new Error('nope'));

      render(CompareSlot, { asset, focused: true });
      await waitFor(() => expect(getAssetInfo).toHaveBeenCalled());

      expect(screen.getByTestId('compare-slot-image')).toBeDefined();
      expect(screen.queryByTestId('compare-slot-exif')).toBeNull();
    });

    it('renders flag, color and rating in the header', () => {
      const asset = timelineAssetFactory.build({ flag: AssetFlag.Pick, colorLabel: AssetColorLabel.Green, rating: 4 });
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());

      render(CompareSlot, { asset, focused: true });

      expect(screen.getByTestId('compare-slot-flag-pick')).toBeDefined();
      expect(screen.getByTestId('compare-slot-color').className).toContain('bg-green-500');
      expect(screen.getByTestId('compare-slot-rating').textContent).toContain('4');
    });

    it('hides the rating when ratings are disabled and omits empty state', () => {
      authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: false } }));
      const asset = timelineAssetFactory.build({ flag: null, colorLabel: null, rating: 4 });
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());

      render(CompareSlot, { asset, focused: true });

      expect(screen.queryByTestId('compare-slot-rating')).toBeNull();
      expect(screen.queryByTestId('compare-slot-color')).toBeNull();
      expect(screen.queryByTestId('compare-slot-flag-pick')).toBeNull();
      expect(screen.queryByTestId('compare-slot-flag-reject')).toBeNull();
    });
  });

  describe('rejected photos', () => {
    it('dims a rejected photo in dim mode', () => {
      compareRejectBehavior.set('dim');
      const asset = timelineAssetFactory.build({ flag: AssetFlag.Reject });
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());

      render(CompareSlot, { asset, focused: false });

      expect(screen.getByTestId('compare-slot').className).toContain('opacity-40');
    });

    it('does not dim in remove mode or for other flags', () => {
      const asset = timelineAssetFactory.build({ flag: AssetFlag.Reject });
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());

      const { unmount } = render(CompareSlot, { asset, focused: false });
      expect(screen.getByTestId('compare-slot').className).not.toContain('opacity-40');
      unmount();

      compareRejectBehavior.set('dim');
      render(CompareSlot, { asset: { ...asset, flag: AssetFlag.Pick }, focused: false });
      expect(screen.getByTestId('compare-slot').className).not.toContain('opacity-40');
    });
  });
});
