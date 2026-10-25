import { TimeBucketDto } from 'src/dtos/time-bucket.dto.js';

const parse = (query: Record<string, unknown>) => TimeBucketDto.schema.safeParse(query);

describe(TimeBucketDto.name, () => {
  describe('rating', () => {
    it('should coerce a query string value to a number', () => {
      const result = parse({ rating: '3' });
      expect(result.success).toBe(true);
      expect(result.data?.rating).toBe(3);
    });

    it.each(['0', '6', '2.5', 'abc'])('should reject %s', (rating) => {
      expect(parse({ rating }).success).toBe(false);
    });
  });

  describe('unrated', () => {
    it('should parse true and false strings', () => {
      expect(parse({ unrated: 'true' }).data?.unrated).toBe(true);
      expect(parse({ unrated: 'false' }).data?.unrated).toBe(false);
    });
  });

  describe('colorLabels', () => {
    it('should split a comma-separated string', () => {
      expect(parse({ colorLabels: 'red,none' }).data?.colorLabels).toEqual(['red', 'none']);
    });

    it('should accept a single value', () => {
      expect(parse({ colorLabels: 'red' }).data?.colorLabels).toEqual(['red']);
    });

    it('should accept an array', () => {
      expect(parse({ colorLabels: ['red', 'none'] }).data?.colorLabels).toEqual(['red', 'none']);
    });

    it('should reject an unknown label', () => {
      expect(parse({ colorLabels: 'pink' }).success).toBe(false);
    });
  });

  describe('flags', () => {
    it('should split a comma-separated string', () => {
      expect(parse({ flags: 'pick,none' }).data?.flags).toEqual(['pick', 'none']);
    });

    it('should accept a single value', () => {
      expect(parse({ flags: 'reject' }).data?.flags).toEqual(['reject']);
    });

    it('should accept an array', () => {
      expect(parse({ flags: ['pick', 'reject'] }).data?.flags).toEqual(['pick', 'reject']);
    });

    it('should reject an unknown flag', () => {
      expect(parse({ flags: 'maybe' }).success).toBe(false);
    });

    it('should leave flags undefined when omitted', () => {
      const result = parse({});
      expect(result.success).toBe(true);
      expect(result.data?.flags).toBeUndefined();
    });
  });
});
