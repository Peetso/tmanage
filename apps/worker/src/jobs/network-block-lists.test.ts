import { Readable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { IpRangeSet, parseIpRange } from '@tmanage/domain';
import type { IpRange } from '@tmanage/domain';
import {
  BLOCK_LIST_SOURCES,
  mergeRanges,
  parsePx1Line,
  refreshNetworkBlockLists,
  safeError,
} from './network-block-lists.js';
import type { BlockListFetch, NetworkBlockListStore } from './network-block-lists.js';
import { zipEntryLines } from './zip-entry-lines.js';

const NOW = new Date('2026-11-22T12:00:00.000Z');

function body(text: string | Buffer): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from([Buffer.from(text)])) as ReadableStream<Uint8Array>;
}

/** A ZIP of local entries only (what the reader needs), APPNOTE §4.3.7. */
function zip(entries: readonly { name: string; data: string; deflate: boolean }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const raw = Buffer.from(entry.data);
    const data = entry.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    parts.push(header, name, data);
  }
  return Buffer.concat(parts);
}

function memoryStore(fetchedAt: Date | null = null) {
  const rows = new Map<string, IpRange[]>();
  const active = new Map<string, string>();
  const failures: string[] = [];
  const store: NetworkBlockListStore = {
    lists: () =>
      Promise.resolve(
        BLOCK_LIST_SOURCES.map((s) => ({ listKey: s.key, activeVersion: null, fetchedAt })),
      ),
    writeRanges: (key, version, ranges) => {
      const id = `${key}:${version}`;
      rows.set(id, [...(rows.get(id) ?? []), ...ranges]);
      return Promise.resolve();
    },
    activate: (key, version) => {
      active.set(key, version);
      return Promise.resolve();
    },
    dropVersion: (key, version) => {
      rows.delete(`${key}:${version}`);
      return Promise.resolve();
    },
    recordFailure: (key, message) => {
      failures.push(`${key}: ${message}`);
      return Promise.resolve();
    },
  };
  const ranges = (key: string) => rows.get(`${key}:${active.get(key) ?? ''}`) ?? [];
  return { store, ranges, failures, rows };
}

describe('the block-list refresh', () => {
  it('merges overlapping and touching ranges, so a point lookup is exact', () => {
    const merged = mergeRanges(
      ['10.0.0.0/25', '10.0.0.128/25', '10.0.0.5', '192.168.0.0/16'].map((l) => parseIpRange(l)!),
    );
    expect(merged).toHaveLength(2);
    const set = new IpRangeSet(merged);
    expect(set.has('10.0.0.200')).toBe(true);
    expect(set.has('10.0.1.0')).toBe(false);
  });

  it('reads PX1 rows', () => {
    expect(parsePx1Line('"16777216","16777471","AU","Australia"')).toEqual(
      parseIpRange('1.0.0.0/24'),
    );
    expect(parsePx1Line('ip_from,ip_to')).toBeNull();
  });

  it('fetches both X4B families and Tor into versioned lists; PX1 is skipped without a token', async () => {
    const mem = memoryStore();
    const logs: string[] = [];
    const fetcher: BlockListFetch = (url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: body(
          url.includes('ipv6')
            ? '2001:db8::/32\n'
            : url.includes('torbulk')
              ? '185.220.101.1\n'
              : '# list\n160.79.104.0/21\n35.80.0.0/12\n',
        ),
      });
    const outcomes = await refreshNetworkBlockLists({
      store: mem.store,
      env: {},
      fetcher,
      now: () => NOW,
      log: (m) => logs.push(m),
    });
    expect(outcomes.map((o) => `${o.key}:${o.status}`)).toEqual([
      'x4b_vpn:refreshed',
      'x4b_datacenter:refreshed',
      'tor_exit:refreshed',
      'ip2proxy_px1:skipped',
    ]);
    expect(new IpRangeSet(mem.ranges('x4b_datacenter')).has('35.88.1.1')).toBe(true);
    expect(new IpRangeSet(mem.ranges('x4b_datacenter')).has('2001:db8::1')).toBe(true);
    expect(new IpRangeSet(mem.ranges('tor_exit')).has('185.220.101.1')).toBe(true);
    expect(logs.join('\n')).toContain('IP2PROXY_LITE_TOKEN is not set');
  });

  it('keeps the active list when a fetch fails, and never stores the token', async () => {
    const mem = memoryStore();
    const fetcher: BlockListFetch = () => Promise.resolve({ ok: false, status: 503, body: null });
    await refreshNetworkBlockLists({
      store: mem.store,
      env: { IP2PROXY_LITE_TOKEN: 'secret-token' },
      fetcher,
      now: () => NOW,
      log: () => undefined,
    });
    expect(mem.failures).toHaveLength(4);
    expect(mem.failures.join()).not.toContain('secret-token');
    expect(mem.rows.size).toBe(0);
    expect(safeError(new Error('GET https://x.test/?token=abc failed'))).toBe('GET <url> failed');
  });

  it('does not refetch a list fetched within its cadence', async () => {
    const mem = memoryStore(new Date(NOW.getTime() - 3_600_000));
    let calls = 0;
    const fetcher: BlockListFetch = () => {
      calls += 1;
      return Promise.resolve({ ok: true, status: 200, body: body('1.2.3.4\n') });
    };
    await refreshNetworkBlockLists({ store: mem.store, env: {}, fetcher, now: () => NOW });
    expect(calls).toBe(0);
  });

  it('streams the PX1 CSV out of its ZIP, past a README entry, merging consecutive rows', async () => {
    const csv = [
      '"16777216","16777471","AU","Australia"',
      '"16777472","16777727","AU","Australia"',
      '"33554432","33554432","FR","France"',
    ].join('\r\n');
    const archive = zip([
      { name: 'README_LITE.TXT', data: 'attribution', deflate: false },
      { name: 'IP2PROXY-LITE-PX1.CSV', data: csv, deflate: true },
    ]);
    const lines: string[] = [];
    for await (const line of zipEntryLines(Readable.from([archive]), (n) => n.endsWith('.CSV'))) {
      lines.push(line);
    }
    expect(lines).toHaveLength(3);

    const mem = memoryStore();
    const outcomes = await refreshNetworkBlockLists({
      store: mem.store,
      env: { IP2PROXY_LITE_TOKEN: 't' },
      fetcher: () => Promise.resolve({ ok: true, status: 200, body: body(archive) }),
      now: () => NOW,
      sources: BLOCK_LIST_SOURCES.filter((s) => s.key === 'ip2proxy_px1'),
    });
    expect(outcomes).toEqual([{ key: 'ip2proxy_px1', status: 'refreshed', ranges: 2 }]);
    const set = new IpRangeSet(mem.ranges('ip2proxy_px1'));
    expect(set.has('1.0.1.255')).toBe(true);
    expect(set.has('2.0.0.0')).toBe(true);
    expect(set.has('2.0.0.1')).toBe(false);
  });

  it('reads a large entry through backpressure without holding it (200 000 rows)', async () => {
    const rows = Array.from(
      { length: 200_000 },
      (_, i) => `"${String(i * 4)}","${String(i * 4 + 1)}","US","United States"`,
    ).join(String.fromCharCode(10));
    const archive = zip([{ name: 'IP2PROXY-LITE-PX1.CSV', data: rows, deflate: true }]);
    let lines = 0;
    for await (const line of zipEntryLines(Readable.from([archive]), () => true)) {
      if (line !== '') lines += 1;
    }
    expect(lines).toBe(200_000);
  });
});
