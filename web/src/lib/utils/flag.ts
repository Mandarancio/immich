import { AssetFlag } from '@immich/sdk';

export const flagValues = [AssetFlag.Pick, AssetFlag.Reject] as const;

export const flagShortcut = { [AssetFlag.Pick]: 'k', [AssetFlag.Reject]: 'r' } as const;
export const clearFlagShortcut = 'u';

/** Toggle semantics: if every target already has the flag it is cleared, otherwise it is set. */
export const nextFlag = (assets: Array<{ flag?: AssetFlag | null }>, flag: AssetFlag) =>
  assets.length > 0 && assets.every((asset) => asset.flag === flag) ? null : flag;
