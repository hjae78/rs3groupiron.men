import { stripBearer } from './bearer-token';

describe('stripBearer', () => {
  it('strips a Bearer prefix, case-insensitively', () => {
    expect(stripBearer('Bearer abc123')).toBe('abc123');
    expect(stripBearer('bearer abc123')).toBe('abc123');
  });

  it('passes through a bare token unchanged', () => {
    expect(stripBearer('abc123')).toBe('abc123');
  });

  it('trims surrounding whitespace', () => {
    expect(stripBearer('  abc123  ')).toBe('abc123');
    expect(stripBearer('Bearer   abc123  ')).toBe('abc123');
  });

  it('returns empty for an empty input', () => {
    expect(stripBearer('')).toBe('');
  });
});
