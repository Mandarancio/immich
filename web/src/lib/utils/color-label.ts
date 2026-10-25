import { AssetColorLabel } from '@immich/sdk';

export const colorLabels = [
  AssetColorLabel.Red,
  AssetColorLabel.Yellow,
  AssetColorLabel.Green,
  AssetColorLabel.Blue,
  AssetColorLabel.Purple,
] as const;

export const colorLabelClass: Record<AssetColorLabel, string> = {
  [AssetColorLabel.Red]: 'bg-red-500',
  [AssetColorLabel.Yellow]: 'bg-yellow-500',
  [AssetColorLabel.Green]: 'bg-green-500',
  [AssetColorLabel.Blue]: 'bg-blue-500',
  [AssetColorLabel.Purple]: 'bg-purple-500',
};

export const colorLabelShortcut: Partial<Record<AssetColorLabel, string>> = {
  [AssetColorLabel.Red]: '6',
  [AssetColorLabel.Yellow]: '7',
  [AssetColorLabel.Green]: '8',
  [AssetColorLabel.Blue]: '9',
};
