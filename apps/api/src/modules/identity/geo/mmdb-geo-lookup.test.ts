import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { MmdbGeoLookup } from './mmdb-geo-lookup.js';

const DIR = 'D:/TManage/geo';
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.mmdb')) : [];
const pathOf = (kind: string) => files.filter((f) => f.includes(kind)).map((f) => join(DIR, f))[0];

it('R12 mmdb: none, logged once, for a missing path and for a garbage file', () => {
  const garbage = join(mkdtempSync(join(tmpdir(), 'geo-')), 'bad.mmdb');
  writeFileSync(garbage, 'not a maxmind database');
  for (const path of ['Z:/no/such.mmdb', garbage]) {
    const log = vi.fn();
    const geo = new MmdbGeoLookup(path, undefined, log);
    expect([geo.available, geo.lookup('8.8.8.8'), log.mock.calls.length]).toEqual([false, null, 1]);
  }
});

// Only where the DB-IP Lite files were downloaded (outside git): skipped on CI and elsewhere.
it.skipIf(!pathOf('city'))('R12 mmdb: the local DB-IP file places 8.8.8.8 in the US', () => {
  const geo = new MmdbGeoLookup(pathOf('city'), pathOf('asn'));
  expect([geo.lookup('8.8.8.8')?.countryCode, geo.lookup('not-an-ip')]).toEqual(['US', null]);
});
