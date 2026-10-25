import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import Timeline from '$lib/components/timeline/Timeline.svelte';
import { AssetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import type { TimelineManagerOptions } from '$lib/managers/timeline-manager/types';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

// the Vite HMR client is not available in the test environment
vi.mock('$lib/elements/HotModuleReload.svelte', () => ({ default: () => {} }));

describe('Timeline component filter handling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getTimeBuckets.mockResolvedValue([]);
    authManager.setUser(userAdminFactory.build());
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: true } }));
  });

  afterEach(() => {
    authManager.reset();
  });

  it('reloads exactly once, without the filter, when the options change while a filter is active', async () => {
    const user = userEvent.setup();
    const props = $state<{
      enableRouting: boolean;
      assetInteraction: AssetMultiSelectManager;
      showFilterBar: boolean;
      options: TimelineManagerOptions;
    }>({
      enableRouting: false,
      assetInteraction: new AssetMultiSelectManager(),
      showFilterBar: true,
      options: { albumId: 'album-1' },
    });
    render(Timeline, { props });

    await waitFor(() => expect(sdkMock.getTimeBuckets).toHaveBeenCalledOnce());
    await user.click(screen.getByTestId('filter-star-3'));
    await waitFor(() => expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(2));
    expect(sdkMock.getTimeBuckets).toHaveBeenLastCalledWith(expect.objectContaining({ albumId: 'album-1', rating: 3 }));

    sdkMock.getTimeBuckets.mockClear();
    props.options = { albumId: 'album-2' };
    await waitFor(() =>
      expect(sdkMock.getTimeBuckets).toHaveBeenCalledWith(expect.objectContaining({ albumId: 'album-2' })),
    );
    // let any further (wasted) reload settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sdkMock.getTimeBuckets).toHaveBeenCalledOnce();
    expect(sdkMock.getTimeBuckets).toHaveBeenCalledWith(expect.objectContaining({ albumId: 'album-2' }));
    const params = sdkMock.getTimeBuckets.mock.calls[0][0];
    expect(params).toEqual(expect.objectContaining({ albumId: 'album-2' }));
    expect(params.rating).toBeUndefined();
  });
});
