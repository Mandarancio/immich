import { AssetFlag } from '@immich/sdk';
import { clearFlagShortcut, flagShortcut, flagValues, nextFlag } from '$lib/utils/flag';

describe('nextFlag', () => {
  it('clears the flag when every asset already has it', () => {
    expect(nextFlag([{ flag: AssetFlag.Pick }, { flag: AssetFlag.Pick }], AssetFlag.Pick)).toBeNull();
  });

  it('sets the flag when assets are mixed', () => {
    expect(nextFlag([{ flag: AssetFlag.Pick }, { flag: null }], AssetFlag.Pick)).toBe(AssetFlag.Pick);
    expect(nextFlag([{ flag: AssetFlag.Reject }, { flag: AssetFlag.Pick }], AssetFlag.Pick)).toBe(AssetFlag.Pick);
  });

  it('sets the flag for an empty selection', () => {
    expect(nextFlag([], AssetFlag.Reject)).toBe(AssetFlag.Reject);
  });

  it('exposes values and shortcuts', () => {
    expect(flagValues).toEqual([AssetFlag.Pick, AssetFlag.Reject]);
    expect(flagShortcut).toEqual({ pick: 'k', reject: 'r' });
    expect(clearFlagShortcut).toBe('u');
  });
});
