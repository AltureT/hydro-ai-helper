import { parsePaginationParams, parseDateRangeParams, buildFilters } from '../../lib/queryHelpers';
import { QUERY_DEFAULTS } from '../../constants/limits';

describe('parsePaginationParams', () => {
  it('should return defaults when no args', () => {
    const result = parsePaginationParams();
    expect(result).toEqual({ page: 1, limit: QUERY_DEFAULTS.DEFAULT_PAGE_LIMIT });
  });

  it('should parse custom page and limit', () => {
    expect(parsePaginationParams('3', '20')).toEqual({ page: 3, limit: 20 });
  });

  it('should clamp page to minimum 1 for zero', () => {
    expect(parsePaginationParams('0', '10').page).toBe(1);
  });

  it('should clamp page to minimum 1 for negative', () => {
    expect(parsePaginationParams('-5', '10').page).toBe(1);
  });

  it('should clamp limit to maxLimit', () => {
    expect(parsePaginationParams('1', '200').limit).toBe(QUERY_DEFAULTS.MAX_PAGINATION_LIMIT);
  });

  it('should fallback to default limit for zero (falsy)', () => {
    expect(parsePaginationParams('1', '0').limit).toBe(QUERY_DEFAULTS.DEFAULT_PAGE_LIMIT);
  });

  it('should clamp limit to minimum 1 for negative', () => {
    expect(parsePaginationParams('1', '-5').limit).toBe(1);
  });

  it('should handle NaN page gracefully', () => {
    expect(parsePaginationParams('abc', '10').page).toBe(1);
  });

  it('should handle NaN limit gracefully', () => {
    expect(parsePaginationParams('1', 'abc').limit).toBe(QUERY_DEFAULTS.DEFAULT_PAGE_LIMIT);
  });

  it('should accept custom maxLimit', () => {
    expect(parsePaginationParams('1', '50', 30).limit).toBe(30);
  });
});

describe('parseDateRangeParams', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return empty object when no dates', () => {
    expect(parseDateRangeParams()).toEqual({});
  });

  it('should parse start date only', () => {
    const result = parseDateRangeParams('2025-01-01');
    expect(result.startDate).toEqual(new Date('2025-01-01'));
    expect(result.endDate).toBeUndefined();
  });

  it('should parse end date only', () => {
    const result = parseDateRangeParams(undefined, '2025-12-31');
    expect(result.startDate).toBeUndefined();
    expect(result.endDate).toEqual(new Date('2025-12-31'));
  });

  it('should parse both dates', () => {
    const result = parseDateRangeParams('2025-01-01', '2025-12-31');
    expect(result.startDate).toEqual(new Date('2025-01-01'));
    expect(result.endDate).toEqual(new Date('2025-12-31'));
  });

  it('should ignore invalid start date (NaN)', () => {
    const result = parseDateRangeParams('not-a-date');
    expect(result.startDate).toBeUndefined();
  });

  it('should ignore invalid end date (NaN)', () => {
    const result = parseDateRangeParams(undefined, 'not-a-date');
    expect(result.endDate).toBeUndefined();
  });

  it('should parse ISO 8601 datetime format', () => {
    const result = parseDateRangeParams('2025-06-15T10:30:00Z');
    expect(result.startDate).toEqual(new Date('2025-06-15T10:30:00Z'));
  });
});

describe('buildFilters', () => {
  it('should include allowed fields with values', () => {
    const result = buildFilters(
      { name: 'test', age: 25, extra: 'ignored' },
      ['name', 'age'],
    );
    expect(result).toEqual({ name: 'test', age: 25 });
  });

  it('should exclude fields not in allowedFields', () => {
    const result = buildFilters(
      { name: 'test', secret: 'hidden' },
      ['name'],
    );
    expect(result).toEqual({ name: 'test' });
    expect(result).not.toHaveProperty('secret');
  });

  it('should skip undefined values', () => {
    const result = buildFilters({ name: undefined, age: 25 }, ['name', 'age']);
    expect(result).toEqual({ age: 25 });
  });

  it('should skip null values', () => {
    const result = buildFilters({ name: null, age: 25 }, ['name', 'age']);
    expect(result).toEqual({ age: 25 });
  });

  it('should skip empty string values', () => {
    const result = buildFilters({ name: '', age: 25 }, ['name', 'age']);
    expect(result).toEqual({ age: 25 });
  });

  it('should return empty when all values are empty', () => {
    const result = buildFilters({ name: '', age: null }, ['name', 'age']);
    expect(result).toEqual({});
  });

  it('should include zero as valid value', () => {
    const result = buildFilters({ count: 0 }, ['count']);
    expect(result).toEqual({ count: 0 });
  });

  it('should include false as valid value', () => {
    const result = buildFilters({ active: false }, ['active']);
    expect(result).toEqual({ active: false });
  });
});
