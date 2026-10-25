import { goto } from '$app/navigation';
import { searchManager } from '$lib/managers/search-manager.svelte';
import { Route } from '$lib/route';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

describe('SearchManager', () => {
  beforeEach(() => {
    localStorage.clear();
    searchManager.reset();
  });

  it('defaults to smart search', () => {
    expect(searchManager.filter.queryType).toBe('smart');
  });

  it('remembers the selected query type', () => {
    searchManager.setQueryType('metadata');
    expect(searchManager.filter.queryType).toBe('metadata');

    searchManager.reset();
    expect(searchManager.filter.queryType).toBe('metadata');
  });

  it('overrides a previously stored query type', () => {
    localStorage.setItem('searchQueryType', 'metadata');
    searchManager.reset();

    searchManager.setQueryType('smart');
    searchManager.reset();
    expect(searchManager.filter.queryType).toBe('smart');
  });

  it('ignores an invalid stored query type', () => {
    localStorage.setItem('searchQueryType', 'invalid');
    searchManager.reset();
    expect(searchManager.filter.queryType).toBe('smart');
  });

  it('restores album ids from a query', () => {
    searchManager.setQuery({ albumIds: ['album-1', 'album-2'] });
    expect([...searchManager.filter.albumIds]).toEqual(['album-1', 'album-2']);
  });

  it('starts with no album filter', () => {
    expect(searchManager.filter.albumIds.size).toBe(0);
  });

  it('submits album ids only when some are selected', async () => {
    await searchManager.submit();
    expect(goto).toHaveBeenLastCalledWith(Route.search({}));

    searchManager.filter.albumIds.add('album-1');
    await searchManager.submit();
    expect(goto).toHaveBeenLastCalledWith(Route.search({ albumIds: ['album-1'] }));
  });
});
