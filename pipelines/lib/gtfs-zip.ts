// Streaming access to CSV files inside a GTFS zip, without extracting to disk.

import yauzl from 'yauzl';
import { parse } from 'csv-parse';
import type { Readable } from 'node:stream';

export type Row = Record<string, string>;

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip!))),
  );
}

async function openEntry(path: string, name: string): Promise<{ zip: yauzl.ZipFile; stream: Readable } | null> {
  const zip = await openZip(path);
  return new Promise((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName !== name) return zip.readEntry();
      zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve({ zip, stream: stream! })));
    });
    zip.on('end', () => {
      zip.close();
      resolve(null);
    });
    zip.on('error', reject);
    zip.readEntry();
  });
}

/** Iterate rows of a CSV file in the zip. Yields nothing if the file is absent. */
export async function* readCsv(zipPath: string, name: string): AsyncGenerator<Row> {
  const opened = await openEntry(zipPath, name);
  if (!opened) return;
  const parser = opened.stream.pipe(
    parse({ columns: true, bom: true, trim: true, skip_empty_lines: true, relax_column_count: true }),
  );
  try {
    for await (const row of parser) yield row as Row;
  } finally {
    opened.zip.close();
  }
}

export async function readCsvAll(zipPath: string, name: string): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const r of readCsv(zipPath, name)) rows.push(r);
  return rows;
}

export async function listEntries(zipPath: string): Promise<string[]> {
  const zip = await openZip(zipPath);
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    zip.on('entry', (e: yauzl.Entry) => {
      names.push(e.fileName);
      zip.readEntry();
    });
    zip.on('end', () => {
      zip.close();
      resolve(names);
    });
    zip.on('error', reject);
    zip.readEntry();
  });
}
