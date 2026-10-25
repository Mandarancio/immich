import type { AssetColorLabel } from '@immich/sdk';

export type TimelineFilter = {
  isFavorite?: boolean;
  rating?: number;
  unrated?: boolean;
  colorLabels?: Array<AssetColorLabel | 'none'>;
};

export class TimelineFilterManager {
  isFavorite = $state(false);
  rating = $state<number | undefined>();
  unrated = $state(false);
  colorLabels = $state<Array<AssetColorLabel | 'none'>>([]);

  get active() {
    return this.isFavorite || this.rating !== undefined || this.unrated || this.colorLabels.length > 0;
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
    return query;
  }

  toggleColor(label: AssetColorLabel | 'none') {
    this.colorLabels = this.colorLabels.includes(label)
      ? this.colorLabels.filter((item) => item !== label)
      : [...this.colorLabels, label];
  }

  setRating(rating?: number) {
    this.rating = rating;
  }

  clear() {
    this.isFavorite = false;
    this.rating = undefined;
    this.unrated = false;
    this.colorLabels = [];
  }
}
