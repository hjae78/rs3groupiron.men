/**
 * The i-th of `count` timestamps, evenly spread across the window ending at
 * `endAt`, jittered within its own slice via `h` so a seeded timeline looks
 * organic instead of metronomic.
 */
export function spreadTimestamp(
  i: number,
  count: number,
  windowMs: number,
  endAt: Date,
  h: number,
): Date {
  const slice = 1 / count;
  const agoFraction = Math.min(
    1,
    (count - 1 - i) * slice + ((h % 1000) / 1000) * slice,
  );
  return new Date(endAt.getTime() - Math.floor(agoFraction * windowMs));
}
