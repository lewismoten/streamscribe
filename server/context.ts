import path from 'node:path';
import { openDatabase } from './db.ts';
import { scanLibrary, sources, type Source } from './scan.ts';

// What the routes share: the library database, how sources map to /files/<source>/ addresses, and the library scan
// (one at a time).
export const db = openDatabase();
export const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
export const sourceBySlug = (slug: string): Source | undefined =>
  sources().find((source) => slugify(source.key) === slug);
export const encodePath = (relative: string) => relative.split(path.sep).map(encodeURIComponent).join('/');
export const filesUrl = (source: Source, relative: string) => `/files/${slugify(source.key)}/${encodePath(relative)}`;

let scanning: Promise<unknown> | null = null;
export function scan() {
  scanning ??= scanLibrary(db)
    .catch((error) => console.error(`Scan failed: ${error.message}`))
    .finally(() => {
      scanning = null;
    });
  return scanning;
}
