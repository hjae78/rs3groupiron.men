import { deterministicHash } from './hash';

describe('deterministicHash', () => {
  it('is deterministic for the same input', () => {
    expect(deterministicHash('abc123')).toBe(deterministicHash('abc123'));
  });

  it('differs for different input', () => {
    expect(deterministicHash('abc123')).not.toBe(deterministicHash('abc124'));
  });

  it('returns a non-negative integer', () => {
    const h = deterministicHash('some group name');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
  });

  it('handles the empty string', () => {
    expect(deterministicHash('')).toBe(0);
  });
});
