import type { AssetColorLabel, AssetFlag } from '@immich/sdk';

export type TimelineFilter = {
  isFavorite?: boolean;
  rating?: number;
  unrated?: boolean;
  colorLabels?: Array<AssetColorLabel | 'none'>;
  flags?: Array<AssetFlag | 'none'>;
};

export class TimelineFilterManager {
  isFavorite = $state(false);
  rating = $state<number | undefined>();
  unrated = $state(false);
  colorLabels = $state<Array<AssetColorLabel | 'none'>>([]);
  flags = $state<Array<AssetFlag | 'none'>>([]);

  get active() {
    return (
      this.isFavorite ||
      this.rating !== undefined ||
      this.unrated ||
      this.colorLabels.length > 0 ||
      this.flags.length > 0
    );
  }

  get query(): TimelineFilter {
    const query: TimelineFilter = {};
    if (this.isFavorite) {
      query.isFavorite = true;
    }
    if (this.rating !== undefined) {
      query.rating = this.rating;
    }
    if (this.unrated) {
      query.unrated = true;
    }
    if (this.colorLabels.length > 0) {
      query.colorLabels = [...this.colorLabels];
    }
    if (this.flags.length > 0) {
      query.flags = [...this.flags];
    }
    return query;
  }

  toggleColor(label: AssetColorLabel | 'none') {
    this.colorLabels = this.colorLabels.includes(label)
      ? this.colorLabels.filter((item) => item !== label)
      : [...this.colorLabels, label];
  }

  toggleFlag(flag: AssetFlag | 'none') {
    this.flags = this.flags.includes(flag) ? this.flags.filter((item) => item !== flag) : [...this.flags, flag];
  }

  setRating(rating?: number) {
    this.rating = rating;
  }

  clear() {
    this.isFavorite = false;
    this.rating = undefined;
    this.unrated = false;
    this.colorLabels = [];
    this.flags = [];
  }
}
