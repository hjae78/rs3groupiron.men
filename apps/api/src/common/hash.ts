/** Deterministic string hash (DJB2-style), used to seed reproducible demo/synthetic data. */
export function deterministicHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
