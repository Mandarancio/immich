import { AssetColorLabel, AssetFlag, getAssetInfo } from '@immich/sdk';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { getResizeObserverMock } from '$lib/__mocks__/resize-observer.mock';
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
  let resizeObserver: ReturnType<typeof getResizeObserverMock>;

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
    resizeObserver = getResizeObserverMock();
    vi.stubGlobal('ResizeObserver', resizeObserver);
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
    expect(screen.getByTestId('compare-slot-focus-ring')).toBeDefined();
    unmount();

    render(CompareSlot, { asset, focused: false });
    expect(screen.queryByTestId('compare-slot-focus-ring')).toBeNull();
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

  describe('resizing', () => {
    it('re-reports the natural zoom when the slot is resized and stops observing on destroy', () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());
      const setNaturalZoom = vi.spyOn(compareManager, 'setNaturalZoom');

      const { unmount } = render(CompareSlot, { asset, focused: true });
      const image = screen.getByTestId('compare-slot-image') as HTMLImageElement;
      Object.defineProperties(image, {
        naturalWidth: { value: 4000 },
        naturalHeight: { value: 3000 },
        clientWidth: { value: 2000 },
        clientHeight: { value: 1500 },
      });

      expect(resizeObserver).toHaveBeenCalledTimes(1);
      const observer = resizeObserver.mock.results[0].value;
      expect(observer.observe).toHaveBeenCalledWith(image.parentElement);
      const callback = resizeObserver.mock.calls[0] as unknown as [() => void];
      callback[0]();

      expect(setNaturalZoom).toHaveBeenCalledWith(asset.id, 2);

      unmount();
      expect(observer.disconnect).toHaveBeenCalled();
    });
  });

  describe('magnifier', () => {
    const setup = async () => {
      const asset = timelineAssetFactory.build();
      compareManager.open([asset, timelineAssetFactory.build()]);
      vi.mocked(getAssetInfo).mockResolvedValue(info());
      render(CompareSlot, { asset, focused: true });
      const image = screen.getByTestId('compare-slot-image') as HTMLImageElement;
      Object.defineProperties(image, {
        naturalWidth: { value: 4000 },
        naturalHeight: { value: 3000 },
      });
      // a 400x300 picture at (100, 50), the slot itself sits at the origin in jsdom
      image.getBoundingClientRect = () => new DOMRect(100, 50, 400, 300);
      await fireEvent.load(image);
      return { asset, image, container: image.parentElement! };
    };

    const move = async (target: Element, clientX: number, clientY: number) => {
      await fireEvent(target, new MouseEvent('pointermove', { clientX, clientY, bubbles: true }));
    };

    it('shows no lens while disabled or without a point', async () => {
      const { asset } = await setup();
      expect(screen.queryByTestId('compare-slot-lens')).toBeNull();

      compareManager.setMagnifierPoint(asset.id, 0.5, 0.5);
      await tick();
      expect(screen.queryByTestId('compare-slot-lens')).toBeNull();

      compareManager.toggleMagnifier();
      compareManager.clearMagnifierPoint(asset.id);
      await tick();
      expect(screen.queryByTestId('compare-slot-lens')).toBeNull();
    });

    it('renders the lens at the shared relative position, magnified', async () => {
      const { image } = await setup();
      compareManager.toggleMagnifier();
      // set by another slot
      compareManager.setMagnifierPoint('other', 0.25, 0.5);
      await tick();

      const lens = await screen.findByTestId('compare-slot-lens');
      // center: x = 100 + 0.25 * 400, y = 50 + 0.5 * 300
      expect(lens.style.left).toBe('120px');
      expect(lens.style.top).toBe('120px');
      expect(lens.style.width).toBe('160px');
      expect(lens.style.height).toBe('160px');
      expect(lens.style.backgroundSize).toBe('1600px 1200px');
      expect(lens.style.backgroundPosition).toBe('-320px -520px');
      expect(lens.style.backgroundImage).toContain(image.getAttribute('src'));
      expect(lens.style.backgroundRepeat).toBe('no-repeat');
      expect(lens.className).toContain('pointer-events-none');
      expect(lens.className).toContain('rounded-full');

      compareManager.setMagnifierLevel(8);
      await tick();
      expect(lens.style.backgroundSize).toBe('3200px 2400px');
      expect(lens.style.backgroundPosition).toBe('-720px -1120px');
    });

    it('follows the zoom of the slot', async () => {
      await setup();
      compareManager.toggleMagnifier();
      compareManager.setMagnifierPoint('other', 0.5, 0.5);
      await tick();
      const lens = await screen.findByTestId('compare-slot-lens');
      expect(lens.style.left).toBe('220px');

      const screenImage = screen.getByTestId('compare-slot-image') as HTMLImageElement;
      screenImage.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
      compareManager.reportZoom('other', zoomed({ currentZoom: 2 }));
      await tick();

      expect(lens.style.left).toBe('320px');
      expect(lens.style.backgroundSize).toBe('3200px 2400px');
    });

    it('uses the picture rect, not the letterboxed element', async () => {
      const { image } = await setup();
      // wide element 400x300 with a 4:3 picture is exact; make the element wider than the picture
      image.getBoundingClientRect = () => new DOMRect(0, 0, 800, 300);
      compareManager.toggleMagnifier();
      compareManager.setMagnifierPoint('other', 0, 0);
      await tick();

      const lens = await screen.findByTestId('compare-slot-lens');
      // picture is 400x300, centered: starts at x = 200
      expect(lens.style.left).toBe('120px');
      expect(lens.style.top).toBe('-80px');
    });

    it('sets the point on pointermove over the picture and clears it outside', async () => {
      const { asset, container } = await setup();
      compareManager.toggleMagnifier();
      await tick();
      expect(container.className).toContain('cursor-crosshair');

      await move(container, 300, 200);
      expect(compareManager.magnifierPoint).toEqual({ sourceId: asset.id, u: 0.5, v: 0.5 });

      await move(container, 50, 200);
      expect(compareManager.magnifierPoint).toBeUndefined();
    });

    it('does not touch the point of another slot when outside the picture', async () => {
      const { container } = await setup();
      compareManager.toggleMagnifier();
      compareManager.setMagnifierPoint('other', 0.1, 0.1);

      await move(container, 50, 200);

      expect(compareManager.magnifierPoint?.sourceId).toBe('other');
    });

    it('clears the point on pointerleave', async () => {
      const { asset, container } = await setup();
      compareManager.toggleMagnifier();
      compareManager.setMagnifierPoint(asset.id, 0.5, 0.5);

      await fireEvent(container, new MouseEvent('pointerleave'));

      expect(compareManager.magnifierPoint).toBeUndefined();
    });

    it('ignores the pointer while disabled', async () => {
      const { container } = await setup();
      expect(container.className).not.toContain('cursor-crosshair');

      await move(container, 300, 200);

      expect(compareManager.magnifierPoint).toBeUndefined();
    });

    it('does not prevent default or stop propagation of pointer events', async () => {
      const { container } = await setup();
      compareManager.toggleMagnifier();
      const event = new MouseEvent('pointermove', { clientX: 300, clientY: 200, bubbles: true, cancelable: true });
      const stop = vi.spyOn(event, 'stopPropagation');

      container.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(stop).not.toHaveBeenCalled();
    });
  });
});
