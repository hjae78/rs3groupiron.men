import { clickDownload } from './download';

export type Cell = string | number | Date;

export type Table = {
  filename: string;
  sheet: string;
  headers: string[];
  rows: Cell[][];
};

function csvCell(value: Cell): string {
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function downloadCsv(table: Table) {
  const lines = [table.headers, ...table.rows].map((row) => row.map(csvCell).join(','));
  const blob = new Blob([`﻿${lines.join('\r\n')}\r\n`], {
    type: 'text/csv;charset=utf-8',
  });
  const href = URL.createObjectURL(blob);
  clickDownload(href, `${table.filename}.csv`);
  URL.revokeObjectURL(href);
}

/** Pretty-printed so the file is readable, not just machine-parsable. */
export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], {
    type: 'application/json;charset=utf-8',
  });
  const href = URL.createObjectURL(blob);
  clickDownload(href, `${filename}.json`);
  URL.revokeObjectURL(href);
}

/** `["Group", "rare-drops", "24h"]` -> `group-rare-drops-24h`. */
function slugFilename(parts: string[]): string {
  return parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}

/**
 * The CSV/JSON half of a panel's export menu: slug the filename, then either
 * dump the rows as JSON or flatten them to a CSV table. `rows` keeps its keys
 * for JSON; `toCsvRow` picks and orders the columns for CSV.
 */
export function exportRows<T>(
  format: 'csv' | 'json',
  opts: {
    filenameParts: string[];
    sheet: string;
    headers: string[];
    rows: T[];
    toCsvRow: (row: T) => Cell[];
  },
) {
  const filename = slugFilename(opts.filenameParts);

  if (format === 'json') {
    downloadJson(filename, opts.rows);
    return;
  }
  downloadCsv({
    filename,
    sheet: opts.sheet,
    headers: opts.headers,
    rows: opts.rows.map(opts.toCsvRow),
  });
}

function sheetName(name: string) {
  return name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet1';
}

export async function downloadXlsx(table: Table) {
  const XLSX = await import('xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([table.headers, ...table.rows], {
    cellDates: true,
  });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName(table.sheet));
  XLSX.writeFile(book, `${table.filename}.xlsx`, { compression: true });
}
