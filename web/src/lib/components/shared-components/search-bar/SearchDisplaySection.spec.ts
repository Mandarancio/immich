import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import SearchDisplaySection from '$lib/components/shared-components/search-bar/SearchDisplaySection.svelte';
import { searchManager } from '$lib/managers/search-manager.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

describe('SearchDisplaySection component', () => {
  const button = (name: string) => screen.getByRole('button', { name });

  beforeEach(() => {
    localStorage.clear();
    searchManager.reset();
  });

  it('renders the liked buttons next to favorites', () => {
    render(SearchDisplaySection);

    expect(button('favorites')).toBeTruthy();
    expect(button('search_filter_liked')).toBeTruthy();
    expect(button('search_filter_liked_by_me')).toBeTruthy();
  });

  it('toggles isLiked and isLikedByMe independently', async () => {
    const user = userEvent.setup();
    render(SearchDisplaySection);

    await user.click(button('search_filter_liked'));
    expect(searchManager.filter.display.isLiked).toBe(true);
    expect(searchManager.filter.display.isLikedByMe).toBe(false);

    await user.click(button('search_filter_liked_by_me'));
    expect(searchManager.filter.display.isLiked).toBe(true);
    expect(searchManager.filter.display.isLikedByMe).toBe(true);

    await user.click(button('search_filter_liked'));
    expect(searchManager.filter.display.isLiked).toBe(false);
    expect(searchManager.filter.display.isLikedByMe).toBe(true);
  });

  it('toggles off a filter restored from a query', async () => {
    const user = userEvent.setup();
    searchManager.setQuery({ isLikedByMe: true });
    render(SearchDisplaySection);

    await user.click(button('search_filter_liked_by_me'));
    expect(searchManager.filter.display.isLikedByMe).toBe(false);
  });
});
