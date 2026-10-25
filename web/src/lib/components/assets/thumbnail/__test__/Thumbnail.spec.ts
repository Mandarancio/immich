import { AssetColorLabel, AssetFlag, AssetVisibility } from '@immich/sdk';
import { render } from '@testing-library/svelte';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import Thumbnail from '$lib/components/assets/thumbnail/Thumbnail.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { getTabbable } from '$lib/utils/focus-util';
import { assetFactory, timelineAssetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('$lib/utils/navigation', () => ({
  currentUrlReplaceAssetId: vi.fn(),
  isSharedLinkRoute: vi.fn().mockReturnValue(false),
}));

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    enumerable: true,
    value: vi.fn().mockImplementation(function (query) {
      return {
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(), // deprecated
        removeListener: vi.fn(), // deprecated
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
});

describe('Thumbnail component', () => {
  beforeAll(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
  });

  it('should only contain a single tabbable element (the container)', () => {
    const asset = assetFactory.build({ originalPath: 'image.jpg', originalMimeType: 'image/jpeg' });
    const { baseElement } = render(Thumbnail, {
      asset,
      selected: true,
    });

    const container = baseElement.querySelector('[data-thumbnail-focus-container]');
    expect(container).not.toBeNull();
    expect(container!.getAttribute('tabindex')).toBe('0');

    // Guarding against inserting extra tabbable elements in future in <Thumbnail/>
    const tabbables = getTabbable(container!);
    expect(tabbables.length).toBe(0);
  });

  it('shows thumbhash while image is loading', () => {
    const asset = assetFactory.build({ originalPath: 'image.jpg', originalMimeType: 'image/jpeg' });
    const sut = render(Thumbnail, {
      asset,
      selected: true,
    });

    const thumbhash = sut.getByTestId('thumbhash');
    expect(thumbhash).not.toBeFalsy();
  });

  describe('per-user state badges', () => {
    beforeEach(() => {
      authManager.setUser(userAdminFactory.build());
      authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: true } }));
    });

    it('shows a color dot with the color class when a color label is set', () => {
      const asset = timelineAssetFactory.build({ colorLabel: AssetColorLabel.Red, isFavorite: false });
      const { getByTestId } = render(Thumbnail, { asset });

      const dot = getByTestId('thumbnail-color-label');
      expect(dot.classList.contains('bg-red-500')).toBe(true);
      expect(dot.getAttribute('aria-label')).toBe('color_label_red');
    });

    it('does not show a color dot without a color label', () => {
      const asset = timelineAssetFactory.build({ colorLabel: null });
      const { queryByTestId } = render(Thumbnail, { asset });

      expect(queryByTestId('thumbnail-color-label')).toBeNull();
    });

    it('shows a star badge with the rating when ratings are enabled', () => {
      const asset = timelineAssetFactory.build({ rating: 4 });
      const { getByTestId } = render(Thumbnail, { asset });

      const badge = getByTestId('thumbnail-rating');
      expect(badge.textContent?.trim()).toBe('4');
      expect(badge.getAttribute('aria-label')).toBe('rating_count');
    });

    it('hides the star badge when ratings are disabled', () => {
      authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: false } }));
      const asset = timelineAssetFactory.build({ rating: 4 });
      const { queryByTestId } = render(Thumbnail, { asset });

      expect(queryByTestId('thumbnail-rating')).toBeNull();
    });

    it('hides the star badge for unrated and rejected assets', () => {
      const unrated = render(Thumbnail, { asset: timelineAssetFactory.build({ rating: null }) });
      expect(unrated.queryByTestId('thumbnail-rating')).toBeNull();
      unrated.unmount();

      const rejected = render(Thumbnail, { asset: timelineAssetFactory.build({ rating: -1 }) });
      expect(rejected.queryByTestId('thumbnail-rating')).toBeNull();
    });

    it('hides the color dot on a shared link', () => {
      const sharedLinkSpy = vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
      try {
        const asset = timelineAssetFactory.build({ colorLabel: AssetColorLabel.Red, rating: 4 });
        const { queryByTestId } = render(Thumbnail, { asset });

        expect(queryByTestId('thumbnail-color-label')).toBeNull();
        expect(queryByTestId('thumbnail-rating')).toBeNull();
      } finally {
        sharedLinkSpy.mockRestore();
      }
    });

    describe('flag badges', () => {
      it('shows the pick badge for a picked asset', () => {
        const asset = timelineAssetFactory.build({ flag: AssetFlag.Pick });
        const { getByTestId, queryByTestId } = render(Thumbnail, { asset });

        expect(getByTestId('thumbnail-flag-pick').getAttribute('aria-label')).toBe('flag_picked');
        expect(queryByTestId('thumbnail-flag-reject')).toBeNull();
      });

      it('shows the reject badge and dims the image for a rejected asset', () => {
        const asset = timelineAssetFactory.build({ flag: AssetFlag.Reject });
        const { baseElement, getByTestId, queryByTestId } = render(Thumbnail, { asset });

        expect(getByTestId('thumbnail-flag-reject').getAttribute('aria-label')).toBe('flag_rejected');
        expect(queryByTestId('thumbnail-flag-pick')).toBeNull();
        expect(baseElement.querySelector('img')?.classList.contains('opacity-40')).toBe(true);
        // the badge itself is not dimmed
        expect(getByTestId('thumbnail-flag-reject').closest('.opacity-40')).toBeNull();
      });

      it('does not dim the image of a picked or unflagged asset', () => {
        const picked = render(Thumbnail, { asset: timelineAssetFactory.build({ flag: AssetFlag.Pick }) });
        expect(picked.baseElement.querySelector('img')?.classList.contains('opacity-40')).toBe(false);
        picked.unmount();

        const none = render(Thumbnail, { asset: timelineAssetFactory.build({ flag: null }) });
        expect(none.baseElement.querySelector('img')?.classList.contains('opacity-40')).toBe(false);
      });

      it('shows nothing without a flag', () => {
        const asset = timelineAssetFactory.build({ flag: null });
        const { queryByTestId } = render(Thumbnail, { asset });

        expect(queryByTestId('thumbnail-flag-pick')).toBeNull();
        expect(queryByTestId('thumbnail-flag-reject')).toBeNull();
      });

      it('shows nothing on a shared link', () => {
        const sharedLinkSpy = vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
        try {
          const asset = timelineAssetFactory.build({ flag: AssetFlag.Reject });
          const { baseElement, queryByTestId } = render(Thumbnail, { asset });

          expect(queryByTestId('thumbnail-flag-pick')).toBeNull();
          expect(queryByTestId('thumbnail-flag-reject')).toBeNull();
          expect(baseElement.querySelector('img')?.classList.contains('opacity-40')).toBe(false);
        } finally {
          sharedLinkSpy.mockRestore();
        }
      });

      it('takes a fourth slot above heart, state row and archive without moving them', () => {
        const bottomClass = (element: Element | null | undefined) =>
          [...(element?.classList ?? [])].find((name) => name.startsWith('bottom-'));
        const asset = timelineAssetFactory.build({
          colorLabel: AssetColorLabel.Green,
          isFavorite: true,
          flag: AssetFlag.Pick,
          visibility: AssetVisibility.Archive,
        });
        const { baseElement, getByTestId } = render(Thumbnail, { asset, showArchiveIcon: true });

        const heart = baseElement.querySelector('[data-icon-favorite]')?.parentElement;
        const row = getByTestId('thumbnail-state-row');
        const flag = getByTestId('thumbnail-flag-pick');
        const archive = baseElement.querySelector('[data-icon-archive]')?.parentElement;
        expect([heart, row, flag, archive].map((element) => bottomClass(element))).toEqual([
          'bottom-2',
          'bottom-10',
          'bottom-18',
          'bottom-26',
        ]);
      });

      it('sits at the bottom when it is the only overlay', () => {
        const asset = timelineAssetFactory.build({ flag: AssetFlag.Pick, isFavorite: false, colorLabel: null });
        const { getByTestId } = render(Thumbnail, { asset });

        expect(getByTestId('thumbnail-flag-pick').classList.contains('bottom-2')).toBe(true);
      });
    });

    describe('bottom-left overlay stacking', () => {
      const bottomClass = (element: Element | null | undefined) =>
        [...(element?.classList ?? [])].find((name) => name.startsWith('bottom-'));

      it('stacks the archive icon above the color dot for an archived, non-favorite asset', () => {
        const asset = timelineAssetFactory.build({
          colorLabel: AssetColorLabel.Blue,
          isFavorite: false,
          visibility: AssetVisibility.Archive,
        });
        const { baseElement, getByTestId } = render(Thumbnail, { asset, showArchiveIcon: true });

        const row = getByTestId('thumbnail-state-row');
        const archive = baseElement.querySelector('[data-icon-archive]')?.parentElement;
        expect(archive).toBeTruthy();
        expect(bottomClass(row)).toBe('bottom-2');
        expect(bottomClass(archive)).toBe('bottom-10');
      });

      it('gives heart, color row and archive icon distinct offsets when all are present', () => {
        const asset = timelineAssetFactory.build({
          colorLabel: AssetColorLabel.Green,
          isFavorite: true,
          visibility: AssetVisibility.Archive,
        });
        const { baseElement, getByTestId } = render(Thumbnail, { asset, showArchiveIcon: true });

        const heart = baseElement.querySelector('[data-icon-favorite]')?.parentElement;
        const row = getByTestId('thumbnail-state-row');
        const archive = baseElement.querySelector('[data-icon-archive]')?.parentElement;
        const offsets = [bottomClass(heart), bottomClass(row), bottomClass(archive)];
        expect(offsets).toEqual(['bottom-2', 'bottom-10', 'bottom-18']);
        expect(new Set(offsets).size).toBe(3);
      });

      it('keeps the archive icon at the bottom when there is nothing else to stack', () => {
        const asset = timelineAssetFactory.build({
          colorLabel: null,
          rating: null,
          isFavorite: false,
          visibility: AssetVisibility.Archive,
        });
        const { baseElement } = render(Thumbnail, { asset, showArchiveIcon: true });

        expect(bottomClass(baseElement.querySelector('[data-icon-archive]')?.parentElement)).toBe('bottom-2');
      });
    });
  });
});
