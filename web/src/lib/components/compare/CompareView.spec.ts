import { AssetColorLabel, AssetFlag, getAssetInfo } from '@immich/sdk';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Mock } from 'vitest';
import TestWrapper from '$lib/components/TestWrapper.svelte';
import CompareView from '$lib/components/compare/CompareView.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { compareManager } from '$lib/managers/compare-manager.svelte';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('@zoom-image/core', () => ({
  createZoomImageWheel: vi.fn(() => ({
    cleanup: vi.fn(),
    setState: vi.fn(),
    getState: vi.fn(() => ({
      currentRotation: 0,
      currentZoom: 1,
      enable: true,
      currentPositionX: 0,
      currentPositionY: 0,
    })),
    subscribe: vi.fn(() => () => {}),
  })),
}));

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAssetInfo: vi.fn(),
}));

const mount = () => render(TestWrapper, { component: CompareView, componentProps: {} });

const press = async (key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  await tick();
  return event;
};

describe('CompareView', () => {
  beforeEach(() => {
    compareManager.close();
    authManager.setUser(userAdminFactory.build({ id: 'viewer' }));
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: true } }));
    vi.mocked(getAssetInfo).mockResolvedValue(undefined as never);
    vi.spyOn(compareManager, 'toggleFlag').mockResolvedValue();
    vi.spyOn(compareManager, 'setFlag').mockResolvedValue();
    vi.spyOn(compareManager, 'rate').mockResolvedValue();
    vi.spyOn(compareManager, 'toggleColor').mockResolvedValue();
  });

  afterEach(() => {
    cleanup();
    compareManager.close();
    authManager.reset();
    vi.restoreAllMocks();
    document.body.style.overflow = '';
  });

  it('renders nothing while closed', () => {
    mount();

    expect(screen.queryByTestId('compare-view')).toBeNull();
  });

  it('shows up when the manager opens', async () => {
    mount();

    compareManager.open(timelineAssetFactory.buildList(2));
    await tick();

    expect(screen.getByTestId('compare-view')).toBeDefined();
    expect(screen.getByTestId('compare-view').className).toContain('z-1100');
  });

  describe('layout', () => {
    it.each([
      [2, 'repeat(2, 1fr)', 'repeat(1, 1fr)'],
      [3, 'repeat(3, 1fr)', 'repeat(1, 1fr)'],
      [4, 'repeat(2, 1fr)', 'repeat(2, 1fr)'],
      [5, 'repeat(3, 1fr)', 'repeat(2, 1fr)'],
      [6, 'repeat(3, 1fr)', 'repeat(2, 1fr)'],
    ])('renders %i slots in a %s by %s grid', (count, columns, rows) => {
      compareManager.open(timelineAssetFactory.buildList(count));
      mount();

      expect(screen.getAllByTestId('compare-slot')).toHaveLength(count);
      const grid = screen.getByTestId('compare-grid');
      expect(grid.style.gridTemplateColumns).toBe(columns);
      expect(grid.style.gridTemplateRows).toBe(rows);
    });

    it('re-tiles when a photo is removed', async () => {
      compareManager.open(timelineAssetFactory.buildList(3));
      mount();

      compareManager.remove();
      await tick();

      expect(screen.getAllByTestId('compare-slot')).toHaveLength(2);
      expect(screen.getByTestId('compare-grid').style.gridTemplateColumns).toBe('repeat(2, 1fr)');
    });

    it('shows the remaining count and the hint bar', () => {
      compareManager.open(timelineAssetFactory.buildList(4));
      mount();

      expect(screen.getByText('compare_photos')).toBeDefined();
      expect(screen.getByTestId('compare-remaining').textContent).toContain('4');
      expect(screen.getByTestId('compare-hints')).toBeDefined();
    });

    it('shows the one-left banner only when a single photo remains', async () => {
      compareManager.open(timelineAssetFactory.buildList(2));
      mount();
      expect(screen.queryByText('compare_one_left')).toBeNull();

      compareManager.remove();
      await tick();

      expect(screen.getByText('compare_one_left')).toBeDefined();
    });

    it('closes from the exit button', async () => {
      compareManager.open(timelineAssetFactory.buildList(2));
      mount();

      await fireEvent.click(screen.getByRole('button', { name: 'compare_exit' }));

      expect(compareManager.isOpen).toBe(false);
      expect(screen.queryByTestId('compare-view')).toBeNull();
    });
  });

  describe('keyboard', () => {
    beforeEach(() => {
      compareManager.open(timelineAssetFactory.buildList(3));
      mount();
    });

    it.each([
      ['ArrowRight', 'focusNext'],
      ['ArrowDown', 'focusNext'],
      ['ArrowLeft', 'focusPrevious'],
      ['ArrowUp', 'focusPrevious'],
      ['Backspace', 'remove'],
      ['z', 'toggleActualSize'],
      ['Escape', 'close'],
    ] as const)('%s calls %s', async (key, method) => {
      const spy = vi.spyOn(compareManager, method);

      const event = await press(key);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it('k toggles pick, r toggles reject and u clears the flag', async () => {
      await press('k');
      expect(compareManager.toggleFlag).toHaveBeenLastCalledWith(AssetFlag.Pick);

      await press('r');
      expect(compareManager.toggleFlag).toHaveBeenLastCalledWith(AssetFlag.Reject);

      const event = await press('u');
      expect(compareManager.setFlag).toHaveBeenCalledWith(null);
      expect(event.defaultPrevented).toBe(true);
    });

    it.each([1, 2, 3, 4, 5])('%i rates the focused photo', async (rating) => {
      const event = await press(String(rating));

      expect(compareManager.rate).toHaveBeenCalledWith(rating);
      expect(event.defaultPrevented).toBe(true);
    });

    it('0 clears the rating', async () => {
      await press('0');

      expect(compareManager.rate).toHaveBeenCalledWith(null);
    });

    it.each([
      ['6', AssetColorLabel.Red],
      ['7', AssetColorLabel.Yellow],
      ['8', AssetColorLabel.Green],
      ['9', AssetColorLabel.Blue],
    ])('%s toggles the %s color', async (key, label) => {
      await press(key);

      expect(compareManager.toggleColor).toHaveBeenCalledWith(label);
    });

    it('ignores rating keys when ratings are disabled but still swallows them', async () => {
      authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: false } }));
      const underneath = vi.fn<(event: KeyboardEvent) => void>();
      document.addEventListener('keydown', underneath);

      await press('3');
      document.removeEventListener('keydown', underneath);

      expect(compareManager.rate).not.toHaveBeenCalled();
      expect(underneath).not.toHaveBeenCalled();
    });

    describe('auto-repeat', () => {
      it.each([
        ['k', 'toggleFlag', AssetFlag.Pick],
        ['r', 'toggleFlag', AssetFlag.Reject],
        ['u', 'setFlag', null],
        ['3', 'rate', 3],
        ['7', 'toggleColor', AssetColorLabel.Yellow],
        ['Backspace', 'remove'],
        ['z', 'toggleActualSize'],
      ] as const)('%s ignores repeats but handles the first press', async (key, method, ...args) => {
        const spy = vi.spyOn(compareManager, method as 'toggleFlag');

        const repeated = await press(key, { repeat: true });
        expect(spy).not.toHaveBeenCalled();
        expect(repeated.defaultPrevented).toBe(true);

        const first = await press(key, { repeat: false });
        expect(spy).toHaveBeenCalledTimes(1);
        if (args.length > 0) {
          expect(spy).toHaveBeenCalledWith(...(args as [AssetFlag]));
        }
        expect(first.defaultPrevented).toBe(true);
      });

      it.each(['ArrowRight', 'ArrowDown'])('%s keeps moving focus while held', async (key) => {
        const spy = vi.spyOn(compareManager, 'focusNext');

        await press(key, { repeat: true });

        expect(spy).toHaveBeenCalledTimes(1);
      });

      it.each(['ArrowLeft', 'ArrowUp'])('%s keeps moving focus backwards while held', async (key) => {
        const spy = vi.spyOn(compareManager, 'focusPrevious');

        await press(key, { repeat: true });

        expect(spy).toHaveBeenCalledTimes(1);
      });

      it('does not preventDefault repeats of unhandled keys', async () => {
        const event = await press('x', { repeat: true });

        expect(event.defaultPrevented).toBe(false);
      });
    });

    it('does not handle shortcuts with modifiers', async () => {
      await press('k', { ctrlKey: true });
      await press('z', { metaKey: true });

      expect(compareManager.toggleFlag).not.toHaveBeenCalled();
    });
  });

  describe('keyboard isolation', () => {
    let underneath: Mock<(event: KeyboardEvent) => void>;

    beforeEach(() => {
      underneath = vi.fn<(event: KeyboardEvent) => void>();
      document.addEventListener('keydown', underneath);
      compareManager.open(timelineAssetFactory.buildList(2));
    });

    afterEach(() => {
      document.removeEventListener('keydown', underneath);
    });

    it('does not let handled keys reach handlers beneath the overlay', async () => {
      mount();

      await press('k');
      await press('ArrowRight');
      await press('Escape');

      expect(underneath).not.toHaveBeenCalled();
    });

    it('does not let unhandled keys such as x or p reach handlers beneath the overlay', async () => {
      mount();

      const x = await press('x');
      const p = await press('p');
      const selectAll = await press('a', { ctrlKey: true });

      expect(underneath).not.toHaveBeenCalled();
      // browser behavior stays available
      expect(x.defaultPrevented).toBe(false);
      expect(p.defaultPrevented).toBe(false);
      expect(selectAll.defaultPrevented).toBe(false);
    });

    it('lets keys through once closed', async () => {
      mount();
      compareManager.close();
      await tick();

      await press('x');

      expect(underneath).toHaveBeenCalledTimes(1);
    });
  });

  describe('focus and scrolling', () => {
    it('moves focus into the overlay and restores it on close', async () => {
      const trigger = document.createElement('button');
      document.body.append(trigger);
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      mount();
      compareManager.open(timelineAssetFactory.buildList(2));
      await tick();
      await tick();

      expect(document.activeElement).toBe(screen.getByTestId('compare-view'));
      expect(screen.getByTestId('compare-view').getAttribute('tabindex')).toBe('-1');

      compareManager.close();
      await tick();

      expect(document.activeElement).toBe(trigger);
      trigger.remove();
    });

    it('keeps Tab inside the overlay', async () => {
      compareManager.open(timelineAssetFactory.buildList(2));
      mount();
      await tick();
      const exit = screen.getByRole('button', { name: 'compare_exit' });
      exit.focus();

      const event = await press('Tab');

      expect(event.defaultPrevented).toBe(true);
      expect(screen.getByTestId('compare-view').contains(document.activeElement)).toBe(true);
    });

    it('locks the body scroll while open', async () => {
      mount();
      expect(document.body.style.overflow).toBe('');

      compareManager.open(timelineAssetFactory.buildList(2));
      await tick();
      expect(document.body.style.overflow).toBe('hidden');

      compareManager.close();
      await tick();
      expect(document.body.style.overflow).toBe('');
    });
  });
});
