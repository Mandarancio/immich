import { MetadataSearchDto, SmartSearchDto } from 'src/dtos/search.dto.js';
import { AssetColorLabel } from 'src/enum.js';

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
