import { AssetColorLabel } from '@immich/sdk';
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
  });
});
