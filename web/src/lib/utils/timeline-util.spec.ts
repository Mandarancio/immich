import { AssetColorLabel, AssetFlag } from '@immich/sdk';
import { DateTime } from 'luxon';
import { locale } from '$lib/stores/preferences.store';
import { parseUtcDate } from '$lib/utils/date-time';
import { formatGroupTitle, toISOYearMonthUTC, toTimelineAsset } from '$lib/utils/timeline-util';
import { assetFactory } from '@test-data/factories/asset-factory';

describe('formatGroupTitle', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    process.env.TZ = 'UTC';
  });

  beforeEach(() => {
    vi.setSystemTime(new Date('2024-07-27T12:00:00Z'));
  });

  afterAll(() => {
    vi.useRealTimers();
    delete process.env.TZ;
  });

  it('formats today', () => {
    const date = parseUtcDate('2024-07-27T01:00:00Z');
    locale.set('en');
    expect(formatGroupTitle(date)).toBe('today');
    locale.set('es');
    expect(formatGroupTitle(date)).toBe('hoy');
  });

  it('formats yesterday', () => {
    const date = parseUtcDate('2024-07-26T23:59:59Z');
    locale.set('en');
    expect(formatGroupTitle(date)).toBe('yesterday');
    locale.set('fr');
    expect(formatGroupTitle(date)).toBe('hier');
  });

  it('formats yesterday across month boundaries', () => {
    vi.setSystemTime(new Date('2024-05-01T12:00:00Z'));
    const date = parseUtcDate('2024-04-30T23:59:59Z');
    locale.set('en');
    expect(formatGroupTitle(date)).toBe('yesterday');
  });

  it('formats last week', () => {
    const date = parseUtcDate('2024-07-21T00:00:00Z');
    locale.set('en');
    expect(formatGroupTitle(date)).toBe('Sunday');
    locale.set('ar-SA');
    expect(formatGroupTitle(date)).toBe('الأحد');
  });

  it('formats date 7 days ago', () => {
    const date = parseUtcDate('2024-07-20T00:00:00Z');
    locale.set('en');
    expect(formatGroupTitle(date)).toBe('Sat, Jul 20');
    locale.set('de');
    expect(formatGroupTitle(date)).toBe('Sa., 20. Juli');
  });

  it('formats date this year', () => {
    const date = parseUtcDate('2020-01-01T00:00:00Z');
    locale.set('en');
    expect(formatGroupTitle(date)).toBe('Wed, Jan 1, 2020');
    locale.set('ja');
    expect(formatGroupTitle(date)).toBe('2020年1月1日(水)');
  });

  it('formats future date', () => {
    const tomorrow = parseUtcDate('2024-07-28T00:00:00Z');
    locale.set('en');
    expect(formatGroupTitle(tomorrow)).toBe('Sun, Jul 28');

    const nextMonth = parseUtcDate('2024-08-28T00:00:00Z');
    locale.set('en');
    expect(formatGroupTitle(nextMonth)).toBe('Wed, Aug 28');

    const nextYear = parseUtcDate('2025-01-10T12:00:00Z');
    locale.set('en');
    expect(formatGroupTitle(nextYear)).toBe('Fri, Jan 10, 2025');
  });

  it('returns "Invalid DateTime" when date is invalid', () => {
    const date = DateTime.invalid('test');
    locale.set('en');
    expect(formatGroupTitle(date)).toBe('Invalid DateTime');
    locale.set('es');
    expect(formatGroupTitle(date)).toBe('Invalid DateTime');
  });
});

describe('toISOYearMonthUTC', () => {
  it('should prefix year with 0s', () => {
    expect(toISOYearMonthUTC({ year: 28, month: 1 })).toBe('0028-01-01T00:00:00.000Z');
  });

  it('should prefix month with 0s', () => {
    expect(toISOYearMonthUTC({ year: 2025, month: 1 })).toBe('2025-01-01T00:00:00.000Z');
  });
});

describe('toTimelineAsset', () => {
  it('maps rating from exifInfo and colorLabel', () => {
    const asset = assetFactory.build({ exifInfo: { rating: 4 }, colorLabel: AssetColorLabel.Red });
    expect(toTimelineAsset(asset)).toMatchObject({ rating: 4, colorLabel: AssetColorLabel.Red });
  });

  it('maps a missing rating and colorLabel to null', () => {
    const asset = assetFactory.build({ exifInfo: {}, colorLabel: undefined });
    expect(toTimelineAsset(asset)).toMatchObject({ rating: null, colorLabel: null });
    expect(toTimelineAsset(assetFactory.build({ exifInfo: undefined }))).toMatchObject({
      rating: null,
      colorLabel: null,
    });
  });

  it('maps flag, defaulting a missing flag to null', () => {
    expect(toTimelineAsset(assetFactory.build({ flag: AssetFlag.Pick }))).toMatchObject({ flag: AssetFlag.Pick });
    expect(toTimelineAsset(assetFactory.build({ flag: undefined }))).toMatchObject({ flag: null });
    expect(toTimelineAsset(assetFactory.build({ flag: null }))).toMatchObject({ flag: null });
  });
});
