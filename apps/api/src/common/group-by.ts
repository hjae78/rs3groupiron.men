/** Buckets rows by a derived key, optionally mapping each row before it's pushed. */
export function groupBy<T, K, V = T>(
  rows: T[],
  keyFn: (row: T) => K,
  valueFn?: (row: T) => V,
): Map<K, V[]> {
  const map = new Map<K, V[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const value = (valueFn ? valueFn(row) : row) as V;
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }
  return map;
}
