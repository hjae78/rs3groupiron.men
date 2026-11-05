import { paginateAll } from './paginate';

type Row = { id: string };

function pagesOf(rows: Row[], pageSize: number) {
  return async (cursor: string | undefined) => {
    const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
    return rows.slice(start, start + pageSize);
  };
}

describe('paginateAll', () => {
  it('walks every page until a short page ends the table', async () => {
    const rows: Row[] = [{ id: '1' }, { id: '2' }, { id: '3' }];
    const seen: string[] = [];
    const total = await paginateAll(2, 100, pagesOf(rows, 2), (row) =>
      seen.push(row.id),
    );
    expect(seen).toEqual(['1', '2', '3']);
    expect(total).toBe(3);
  });

  it('stops once maxRows is reached, even mid-page', async () => {
    const rows: Row[] = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }];
    const seen: string[] = [];
    const total = await paginateAll(2, 2, pagesOf(rows, 2), (row) =>
      seen.push(row.id),
    );
    expect(seen).toEqual(['1', '2']);
    expect(total).toBe(2);
  });

  it('returns 0 for an empty table', async () => {
    const total = await paginateAll(5, 100, pagesOf([], 5), () => {});
    expect(total).toBe(0);
  });
});
