import { groupBy } from './group-by';

describe('groupBy', () => {
  it('buckets rows by key, preserving order within each bucket', () => {
    const rows = [
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
      { id: 'a', n: 3 },
    ];
    const grouped = groupBy(rows, (r) => r.id);
    expect(grouped.get('a')).toEqual([rows[0], rows[2]]);
    expect(grouped.get('b')).toEqual([rows[1]]);
  });

  it('maps each row with valueFn before bucketing', () => {
    const rows = [
      { id: 'a', n: 1 },
      { id: 'a', n: 2 },
    ];
    const grouped = groupBy(
      rows,
      (r) => r.id,
      (r) => r.n,
    );
    expect(grouped.get('a')).toEqual([1, 2]);
  });

  it('returns an empty map for no rows', () => {
    expect(groupBy([], (r: { id: string }) => r.id).size).toBe(0);
  });
});
