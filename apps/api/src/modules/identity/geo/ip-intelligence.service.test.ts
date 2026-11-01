import { expect, it, vi } from 'vitest';
import { StaticGeoLookup } from './geo-lookup.js';
import { IpIntelligenceService } from './ip-intelligence.service.js';

const at = (countryCode: string, asn: number, networkOwner: string) =>
  ({ countryCode, asn, networkOwner }) as never;
const table = { '203.0.113.7': at('EG', 8452, 'TE Data'), '198.51.100.9': at('DE', 1, 'Hetzner') };
const tor = { has: (ip: string) => ip === '198.51.100.9' };

function service(fresh: boolean, fail = false) {
  const repo = {
    touchIfFresh: vi.fn(async () => fresh),
    upsert: vi.fn(async (_tx: unknown, _v: unknown) => undefined),
  };
  const tables: unknown[] = [];
  const identityTransaction = (work: { tables: string[] }, fn: (tx: unknown) => Promise<void>) =>
    fail ? Promise.reject(new Error('down')) : (tables.push(work.tables), fn({}));
  const db = { identityTransaction } as never;
  const geo = new StaticGeoLookup(table);
  return { repo, tables, svc: new IpIntelligenceService(db, geo, tor, repo as never, () => {}) };
}

it('R12 IP intelligence classifies residential, hosting/Tor and local addresses', () => {
  const { svc } = service(true);
  const kinds = ['203.0.113.7', '198.51.100.9', '192.168.0.4', ''].map((ip) => svc.classify(ip));
  const text = kinds.map((k) => k && `${k.networkKind} ${k.isTor} ${k.vpnOrProxy}`).join();
  expect(text).toBe('residential false unknown,hosting true likely,local false unknown,');
});

it('R12 IP intelligence bumps a fresh row, refreshes a stale one, and never throws', async () => {
  const [fresh, stale] = [service(true), service(false)];
  await Promise.all([fresh.svc.record('203.0.113.7'), stale.svc.record('203.0.113.7')]);
  expect([fresh.repo.upsert.mock.calls.length, fresh.tables]).toEqual([0, [['ip_lookups']]]);
  expect(stale.repo.upsert.mock.calls[0]?.[1]).toMatchObject({ countryCode: 'EG' });
  await expect(service(true, true).svc.record('203.0.113.7')).resolves.toBeUndefined();
});
