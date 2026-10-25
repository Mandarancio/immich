import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import SearchAlbumsSection from '$lib/components/shared-components/search-bar/SearchAlbumsSection.svelte';
import { searchManager } from '$lib/managers/search-manager.svelte';
import { albumFactory } from '@test-data/factories/album-factory';

describe('SearchAlbumsSection component', () => {
  const holiday = albumFactory.build({ id: 'album-1', albumName: 'Holiday' });
  const family = albumFactory.build({ id: 'album-2', albumName: 'Family' });

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    searchManager.setQuery({ albumIds: ['album-1', 'album-2'] });
  });

  afterEach(() => {
    searchManager.reset();
  });

  it('shows a chip for each selected album', async () => {
    render(SearchAlbumsSection, {
      props: { title: undefined, parentPromise: Promise.resolve([holiday, family]) },
    });

    // @ts-expect-error pending a type fix: https://github.com/testing-library/jest-dom/pull/742/changes
    expect(await screen.findByRole('button', { name: 'Holiday' })).toBeInTheDocument();
    // @ts-expect-error pending a type fix: https://github.com/testing-library/jest-dom/pull/742/changes
    expect(screen.getByRole('button', { name: 'Family' })).toBeInTheDocument();
  });

  it('removes the album when its chip is clicked', async () => {
    const user = userEvent.setup();
    render(SearchAlbumsSection, {
      props: { title: undefined, parentPromise: Promise.resolve([holiday, family]) },
    });

    await user.click(await screen.findByRole('button', { name: 'Holiday' }));

    // @ts-expect-error pending a type fix: https://github.com/testing-library/jest-dom/pull/742/changes
    expect(screen.queryByRole('button', { name: 'Holiday' })).not.toBeInTheDocument();
    expect([...searchManager.filter.albumIds]).toEqual(['album-2']);
  });

  // removing the focused chip would otherwise drop focus to the body, which the
  // search bar treats as focus leaving the search panel
  it('keeps focus inside the section when a chip is removed', async () => {
    const user = userEvent.setup();
    const { container } = render(SearchAlbumsSection, {
      props: { title: undefined, parentPromise: Promise.resolve([holiday, family]) },
    });

    await user.click(await screen.findByRole('button', { name: 'Holiday' }));

    expect(document.activeElement).not.toBe(document.body);
    expect(container.contains(document.activeElement)).toBe(true);
  });
});
