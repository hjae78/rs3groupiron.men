/**
 * Walks a cursor-paginated table end to end, calling `onRow` for each row.
 * Stops on a short page (end of table) or once `maxRows` is reached, whichever
 * comes first — the latter exists so a pathological table can't make one
 * caller read forever.
 */
export async function paginateAll<T extends { id: string }>(
  pageSize: number,
  maxRows: number,
  queryPage: (cursor: string | undefined) => Promise<T[]>,
  onRow: (row: T) => void,
): Promise<number> {
  let cursor: string | undefined;
  let rows = 0;
  for (;;) {
    const page = await queryPage(cursor);
    if (!page.length) break;
    for (const row of page) onRow(row);
    rows += page.length;
    cursor = page[page.length - 1]!.id;
    if (page.length < pageSize || rows >= maxRows) break;
  }
  return rows;
}
