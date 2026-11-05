import { spreadTimestamp } from './spread-timestamp';

describe('spreadTimestamp', () => {
  const endAt = new Date('2026-01-01T00:00:00.000Z');
  const windowMs = 10 * 24 * 60 * 60 * 1000;

  it('places the most recent index (count-1) within one slice of endAt', () => {
    const at = spreadTimestamp(4, 5, windowMs, endAt, 0);
    expect(endAt.getTime() - at.getTime()).toBeLessThan(windowMs / 5);
  });

  it('places the oldest index (0) near the start of the window', () => {
    const at = spreadTimestamp(0, 5, windowMs, endAt, 0);
    const ago = endAt.getTime() - at.getTime();
    expect(ago).toBeGreaterThan((windowMs * 4) / 5 - 1);
    expect(ago).toBeLessThanOrEqual(windowMs);
  });

  it('never produces a timestamp after endAt', () => {
    const at = spreadTimestamp(4, 5, windowMs, endAt, 999);
    expect(at.getTime()).toBeLessThanOrEqual(endAt.getTime());
  });

  it('is deterministic for the same inputs', () => {
    const a = spreadTimestamp(2, 7, windowMs, endAt, 123);
    const b = spreadTimestamp(2, 7, windowMs, endAt, 123);
    expect(a.getTime()).toBe(b.getTime());
  });
});
