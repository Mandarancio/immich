import { screen } from '@testing-library/svelte';
import DetailPanel from '$lib/components/asset-viewer/DetailPanel.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

describe('DetailPanel color label picker', () => {
  beforeEach(() => {
    authManager.setUser(userAdminFactory.build({ id: 'viewer' }));
    authManager.setPreferences(preferencesFactory.build());
  });

  afterEach(() => {
    authManager.reset();
  });

  it('is shown for a logged-in user who does not own the asset', () => {
    const asset = assetFactory.build({ ownerId: 'someone-else' });
    renderWithTooltips(DetailPanel, { asset });

    expect(screen.queryByRole('group', { name: 'color_label' })).not.toBeNull();
  });

  it('is shown for the owner', () => {
    const asset = assetFactory.build({ ownerId: 'viewer' });
    renderWithTooltips(DetailPanel, { asset });

    expect(screen.queryByRole('group', { name: 'color_label' })).not.toBeNull();
  });

  it('is hidden on a shared link', () => {
    const spy = vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
    try {
      const asset = assetFactory.build({ ownerId: 'someone-else' });
      renderWithTooltips(DetailPanel, { asset });

      expect(screen.queryByRole('group', { name: 'color_label' })).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
