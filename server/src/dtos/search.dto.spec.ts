import { MetadataSearchDto, SmartSearchDto } from 'src/dtos/search.dto.js';
import { AssetColorLabel, AssetFlag } from 'src/enum.js';

const flat = (colorLabels: unknown) => MetadataSearchDto.schema.safeParse({ colorLabels });
const nested = (colorLabels: unknown) => MetadataSearchDto.schema.safeParse({ filter: { colorLabels } });

describe('search colorLabels', () => {
  it('should accept colors and none in the flat dto', () => {
    const result = flat([AssetColorLabel.Red, 'none']);
    expect(result.success).toBe(true);
    expect(result.data?.colorLabels).toEqual(['red', 'none']);
  });

  it('should reject an unknown color in the flat dto', () => {
    expect(flat(['pink']).success).toBe(false);
  });

  it('should accept colors and none in the filter branch', () => {
    expect(nested([AssetColorLabel.Blue, 'none']).success).toBe(true);
    expect(
      MetadataSearchDto.schema.safeParse({ filter: { or: [{ colorLabels: [AssetColorLabel.Green] }] } }).success,
    ).toBe(true);
  });

  it('should reject an unknown color in the filter branch', () => {
    expect(nested(['pink']).success).toBe(false);
  });

  it('should not combine the flat field with the filter', () => {
    expect(MetadataSearchDto.schema.safeParse({ colorLabels: ['red'], filter: { city: { eq: 'Oslo' } } }).success).toBe(
      false,
    );
  });

  it('should be accepted by smart search', () => {
    expect(SmartSearchDto.schema.safeParse({ query: 'x', colorLabels: ['red'] }).success).toBe(true);
  });
});

const flatFlags = (flags: unknown) => MetadataSearchDto.schema.safeParse({ flags });
const nestedFlags = (flags: unknown) => MetadataSearchDto.schema.safeParse({ filter: { flags } });

describe('search flags', () => {
  it('should accept flags and none in the flat dto', () => {
    const result = flatFlags([AssetFlag.Pick, AssetFlag.Reject, 'none']);
    expect(result.success).toBe(true);
    expect(result.data?.flags).toEqual(['pick', 'reject', 'none']);
  });

  it('should reject an unknown flag in the flat dto', () => {
    expect(flatFlags(['maybe']).success).toBe(false);
  });

  it('should accept flags and none in the filter branch', () => {
    expect(nestedFlags([AssetFlag.Pick, 'none']).success).toBe(true);
    expect(MetadataSearchDto.schema.safeParse({ filter: { or: [{ flags: [AssetFlag.Reject] }] } }).success).toBe(true);
  });

  it('should reject an unknown flag in the filter branch', () => {
    expect(nestedFlags(['maybe']).success).toBe(false);
  });

  it('should not combine the flat field with the filter', () => {
    expect(MetadataSearchDto.schema.safeParse({ flags: ['pick'], filter: { city: { eq: 'Oslo' } } }).success).toBe(
      false,
    );
    expect(
      MetadataSearchDto.schema.safeParse({ flags: ['pick'], filter: { or: [{ city: { eq: 'Oslo' } }] } }).success,
    ).toBe(false);
  });

  it('should be accepted by smart search', () => {
    expect(SmartSearchDto.schema.safeParse({ query: 'x', flags: ['pick'] }).success).toBe(true);
  });
});
