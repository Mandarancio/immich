import { AssetColorLabel, updateAssets } from '@immich/sdk';
import { fireEvent } from '@testing-library/svelte';
import { shortcuts } from '$lib/actions/shortcut';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { getBulkUserStateShortcuts, nextColorLabel } from '$lib/services/asset.service';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  updateAssets: vi.fn(),
}));

describe('nextColorLabel', () => {
  it('sets the label when some assets lack it', () => {
    const assets = [{ colorLabel: AssetColorLabel.Red }, { colorLabel: null }];
    expect(nextColorLabel(assets, AssetColorLabel.Red)).toBe(AssetColorLabel.Red);
  });

  it('clears the label when every asset already has it', () => {
    const assets = [{ colorLabel: AssetColorLabel.Red }, { colorLabel: AssetColorLabel.Red }];
    expect(nextColorLabel(assets, AssetColorLabel.Red)).toBeNull();
  });
});

describe('getBulkUserStateShortcuts', () => {
  const first = timelineAssetFactory.build({ rating: null, colorLabel: null });
  const second = timelineAssetFactory.build({ rating: 1, colorLabel: null });
  let node: HTMLElement;
  let destroy: (() => void) | undefined;
  const onRated = vi.fn();
  const onLabeled = vi.fn();
  const onDone = vi.fn();

  const bind = () => {
    destroy?.();
    const action = shortcuts(
      node,
      getBulkUserStateShortcuts({ getAssets: () => [first, second], onRated, onLabeled, onDone }),
    );
    destroy = () => action?.destroy?.();
  };

  const press = async (key: string, init: KeyboardEventInit = {}) => {
    await fireEvent.keyDown(node, { key, ...init });
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(updateAssets).mockReset();
    vi.mocked(updateAssets).mockResolvedValue(undefined as never);
    onRated.mockReset();
    onLabeled.mockReset();
    onDone.mockReset();
    authManager.setUser(userAdminFactory.build({ id: 'viewer' }));
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: true } }));
    first.rating = null;
    first.colorLabel = null;
    second.rating = 1;
    second.colorLabel = null;
    node = document.createElement('div');
    document.body.append(node);
  });

  afterEach(() => {
    destroy?.();
    destroy = undefined;
    node.remove();
  });

  it('rates the targets with 3', async () => {
    bind();
    await press('3');

    await vi.waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({ assetBulkUpdateDto: { ids: [first.id, second.id], rating: 3 } }),
    );
    await vi.waitFor(() => expect(onRated).toHaveBeenCalledWith([first.id, second.id], 3));
    expect(first.rating).toBe(3);
    expect(onDone).toHaveBeenCalled();
  });

  it('clears the rating with 0', async () => {
    bind();
    await press('0');

    await vi.waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({ assetBulkUpdateDto: { ids: [first.id, second.id], rating: null } }),
    );
    expect(second.rating).toBeNull();
  });

  it('sets red with 6 when not all targets are red', async () => {
    first.colorLabel = AssetColorLabel.Red;
    bind();
    await press('6');

    await vi.waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({
        assetBulkUpdateDto: { ids: [first.id, second.id], colorLabel: AssetColorLabel.Red },
      }),
    );
    await vi.waitFor(() => expect(onLabeled).toHaveBeenCalledWith([first.id, second.id], AssetColorLabel.Red));
  });

  it('clears red with 6 when every target is already red', async () => {
    first.colorLabel = AssetColorLabel.Red;
    second.colorLabel = AssetColorLabel.Red;
    bind();
    await press('6');

    await vi.waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({
        assetBulkUpdateDto: { ids: [first.id, second.id], colorLabel: null },
      }),
    );
    expect(first.colorLabel).toBeNull();
  });

  it.each([
    ['7', AssetColorLabel.Yellow],
    ['8', AssetColorLabel.Green],
    ['9', AssetColorLabel.Blue],
  ])('maps %s to %s', async (key, colorLabel) => {
    bind();
    await press(key);

    await vi.waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({ assetBulkUpdateDto: { ids: [first.id, second.id], colorLabel } }),
    );
  });

  it('ignores events with modifiers', async () => {
    bind();
    await press('3', { ctrlKey: true });
    await press('6', { shiftKey: true });
    await press('7', { metaKey: true });

    expect(updateAssets).not.toHaveBeenCalled();
  });

  it('ignores events from focused inputs', async () => {
    bind();
    const input = document.createElement('input');
    input.type = 'text';
    node.append(input);
    await fireEvent.keyDown(input, { key: '3' });
    await fireEvent.keyDown(input, { key: '6' });

    expect(updateAssets).not.toHaveBeenCalled();
  });

  it('ignores rating keys when ratings are disabled but keeps color keys', async () => {
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: false } }));
    bind();
    await press('3');
    await press('0');
    expect(updateAssets).not.toHaveBeenCalled();

    await press('6');
    await vi.waitFor(() => expect(updateAssets).toHaveBeenCalledTimes(1));
  });

  it('registers nothing in a shared-link context', () => {
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
    expect(getBulkUserStateShortcuts({ getAssets: () => [first], onDone })).toEqual([]);
  });

  it('does nothing without targets', async () => {
    destroy?.();
    const action = shortcuts(node, getBulkUserStateShortcuts({ getAssets: () => [] }));
    destroy = () => action?.destroy?.();
    await press('3');
    await press('6');

    expect(updateAssets).not.toHaveBeenCalled();
  });
});
