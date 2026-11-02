import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TABLES } from './schema.js';

/**
 * 56-28 — the doc half of priv-053, without a database: every name in `TABLES` has a row in
 * `docs/security/data-inventory.md`, and every row names a table in `TABLES`. Rows are the lines
 * `| \`table\` | …`; the "Planned tables" list uses another shape on purpose and is not counted.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const INVENTORY = resolve(HERE, '../../../../../docs/security/data-inventory.md');

function inventoryTables(markdown: string): string[] {
  const rows: string[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const match = /^\| `([a-z0-9_]+)`\s*\|/u.exec(line);
    if (match?.[1]) rows.push(match[1]);
  }
  return rows;
}

describe('56-28 data inventory covers TABLES', () => {
  it('lists every table once and nothing else', () => {
    const listed = inventoryTables(readFileSync(INVENTORY, 'utf8'));
    const tables = Object.keys(TABLES);
    expect({
      missing: tables.filter((t) => !listed.includes(t)).sort(),
      unknown: listed.filter((t) => !tables.includes(t)).sort(),
      doubled: listed.filter((t, i) => listed.indexOf(t) !== i),
    }).toEqual({ missing: [], unknown: [], doubled: [] });
  });
});
