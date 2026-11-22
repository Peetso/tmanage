import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/http/errors.js';
import type { GuardRefusal } from '../../../common/http/authentication-event-recorder.js';
import type { PlatformAuditInput } from '../../platform-admin/platform-admin.repository.js';
import type { PlatformAdminActor } from '../../platform-admin/platform-admin.guard.js';
import type { IpLookupValues } from '../geo/ip-lookups.repository.js';
import { SOURCE_BLOCKED_REASON, decideNetworkAccess } from './network-access-policy.js';
import type { NetworkAccessInput } from './network-access-policy.js';
import type {
  AllowlistEntry,
  BlockEntry,
  BlockListRow,
  NetworkAccessStore,
} from './network-access.repository.js';
import {
  NetworkAccessService,
  SOURCE_BLOCKED_MESSAGES,
  blockListStatus,
  envAllowlist,
  parseBlockValue,
} from './network-access.service.js';
import type { NetworkAccessRequest } from './network-access.service.js';

/**
 * SEC-TRACKER (Fable 5.2 ruling, gap 1) — the platform's own block list at the sign-in door:
 * refused first whatever the policy switch says, 409 on an allowlist overlap (both directions) and
 * on the admin's own address, at most a /24 or /48, audited; and gap 3's list status.
 */

const NOW = new Date('2026-11-22T12:00:00.000Z');
const ATTACKER = '154.47.20.3';
const OFFICE = '160.79.106.10';
const ADMIN_IP = '197.167.175.211';
const AT = new Date('2026-11-22T10:00:00.000Z');

const actor = {
  account: { userId: '0190a000-0000-7000-8000-000000000001', email: 'admin@platform.test' },
} as PlatformAdminActor;
const context = {
  correlationId: '0190a000-0000-7000-8000-0000000000cc',
  ip: ADMIN_IP,
  userAgent: null,
};

const place = (over: Partial<IpLookupValues>): IpLookupValues => ({
  ip: '',
  countryCode: null,
  country: null,
  region: null,
  city: null,
  postalCode: null,
  asn: null,
  networkOwner: null,
  networkKind: 'unknown',
  isTor: false,
  vpnOrProxy: 'unknown',
  source: null,
  ...over,
});

function setup(
  options: {
    readonly allow?: readonly AllowlistEntry[];
    readonly blocks?: readonly BlockEntry[];
    readonly policy?: string | null;
    readonly lists?: readonly BlockListRow[];
    readonly env?: string;
  } = {},
) {
  const allow = [...(options.allow ?? [])];
  const blocks = [...(options.blocks ?? [])];
  const audits: PlatformAuditInput[] = [];
  const recorded: GuardRefusal[] = [];
  let seq = 0;
  const store: NetworkAccessStore = {
    activeLists: () => Promise.resolve([]),
    listHits: () => Promise.resolve([]),
    allowlist: () => Promise.resolve([...allow]),
    policy: () => Promise.resolve(options.policy ?? null),
    accountSpread: () => Promise.resolve(null),
    addAllowlistEntry: (entry, audit) => {
      const id = `00000000-0000-7000-8000-0000000000${String((seq += 1)).padStart(2, '0')}`;
      allow.push({ id, ...entry });
      audits.push(audit(id));
      return Promise.resolve({ id, ...entry });
    },
    removeAllowlistEntry: () => Promise.resolve(false),
    setPolicy: () => Promise.resolve(),
    blocklist: () => Promise.resolve([...blocks]),
    addBlock: (entry, audit) => {
      if (blocks.some((b) => b.value === entry.value)) return Promise.resolve(null);
      const id = `00000000-0000-7000-8000-0000000000${String((seq += 1)).padStart(2, '0')}`;
      blocks.push({ id, ...entry });
      audits.push(audit(id));
      return Promise.resolve({ id, ...entry });
    },
    removeBlock: (id, audit) => {
      const index = blocks.findIndex((b) => b.id === id);
      if (index < 0) return Promise.resolve(null);
      const [removed] = blocks.splice(index, 1);
      audits.push(audit);
      return Promise.resolve(removed ?? null);
    },
    listStatus: () => Promise.resolve(options.lists ?? []),
  };
  const places: Record<string, IpLookupValues> = {
    [ATTACKER]: place({
      countryCode: 'NL',
      asn: 60068,
      networkOwner: 'CDN77',
      networkKind: 'hosting',
    }),
    // A GeoIP database answers the same network for the range's own first address.
    '154.47.20.0': place({
      countryCode: 'NL',
      asn: 60068,
      networkOwner: 'CDN77',
      networkKind: 'hosting',
    }),
    [OFFICE]: place({ countryCode: 'US', asn: 399358, networkOwner: 'Anthropic' }),
    '203.0.113.9': place({ countryCode: 'EG', asn: 8452, networkKind: 'residential' }),
  };
  const service = new NetworkAccessService(
    store,
    { classify: (ip) => (ip ? (places[ip] ?? null) : null) },
    { recordGuardRefusal: (r) => void recorded.push(r) },
    envAllowlist(options.env),
    () => NOW,
  );
  return { service, audits, recorded, blocks, allow };
}

const request = (ip: string, over: Partial<NetworkAccessRequest> = {}): NetworkAccessRequest => ({
  ip,
  userAgent: 'curl/8.4',
  clientTimeZone: null,
  clientLanguage: 'en',
  email: null,
  correlationId: 'corr-1',
  ...over,
});

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const block = (value: string, id = '0193b5a0-0000-7000-8000-00000000c001'): BlockEntry => ({
  id,
  value,
  note: null,
  createdAt: AT,
});

describe('the block list is the door’s first layer (gap 1)', () => {
  it('refuses a blocked address with the policy switch OFF, recorded as source_blocked', async () => {
    const { service, recorded } = setup({ blocks: [block('203.0.113.0/24')], policy: 'allow' });
    const error = await failure(service.enforce(request('203.0.113.9')));
    expect(error.status).toBe(403);
    expect(error.message).toBe(SOURCE_BLOCKED_MESSAGES.en);
    expect(recorded).toEqual([
      expect.objectContaining({
        action: 'network_guard',
        reason: SOURCE_BLOCKED_REASON,
        automationReasons: ['net.blocked'],
      }),
    ]);
  });

  it('refuses a blocked residential address that every other layer would let through', async () => {
    const { service } = setup({ blocks: [block('203.0.113.9/32')] });
    expect((await service.evaluate(request('203.0.113.9')))?.because).toBe('blocked');
    // The same address unblocked is clear: the refusal came from layer 0 alone.
    expect((await setup().service.evaluate(request('203.0.113.9')))?.because).toBe('clear');
  });

  it('decides blocked before the allowlist and the policy (pure)', () => {
    const input: NetworkAccessInput = {
      policy: 'allow',
      blocked: true,
      allowlisted: true,
      listHits: [],
      isTor: false,
      asn: null,
      networkOwner: null,
      countryCode: null,
      clientTimeZone: null,
      clientLanguage: null,
      accountSpread: null,
      now: NOW,
    };
    expect(decideNetworkAccess(input)).toEqual({
      refuse: true,
      because: 'blocked',
      score: 100,
      reasons: ['net.blocked'],
    });
  });

  it('is in force at once on this process after a block (cache dropped)', async () => {
    const { service } = setup();
    expect((await service.evaluate(request('203.0.113.9')))?.because).toBe('clear');
    await service.addBlock(actor, { value: '203.0.113.9' }, context);
    expect((await service.evaluate(request('203.0.113.9')))?.because).toBe('blocked');
  });
});

describe('blocking: validation, 409s and audit (gap 1)', () => {
  it('stores the canonical value, audits it, and lists it on the GET', async () => {
    const { service, audits } = setup();
    const entry = await service.addBlock(
      actor,
      { value: ` ${ATTACKER} `, note: 'stuffing' },
      context,
    );
    expect(entry).toMatchObject({ value: `${ATTACKER}/32`, note: 'stuffing', createdAt: NOW });
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'platform.network_block_added',
        targetId: entry.id,
        targetLabel: `cidr:${ATTACKER}/32`,
        actorUserId: actor.account.userId,
      }),
    ]);
    expect((await service.view()).blocked.map((b) => b.value)).toEqual([`${ATTACKER}/32`]);
  });

  it('accepts at most a /24 or a /48, never a wider slice or an ASN', async () => {
    const { service } = setup();
    for (const value of ['154.47.0.0/16', '2001:db8::/32', 'AS60068', 'nope', '154.47.20.3/24']) {
      expect((await failure(service.addBlock(actor, { value }, context))).status).toBe(400);
    }
    expect(parseBlockValue('154.47.20.0/24')?.value).toBe('154.47.20.0/24');
    expect(parseBlockValue('2001:db8:1::/48')?.bits).toBe(48);
  });

  it('409s on the admin’s own address (no self-lockout)', async () => {
    const { service, blocks } = setup();
    const error = await failure(service.addBlock(actor, { value: '197.167.175.0/24' }, context));
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/your own address/u);
    expect(blocks).toEqual([]);
  });

  it('409s on an allowlist overlap: a range, an env entry, an allowlisted network', async () => {
    const office: AllowlistEntry = {
      id: 'a',
      kind: 'cidr',
      value: '160.79.104.0/21',
      note: null,
      createdAt: AT,
    };
    const range = await failure(
      setup({ allow: [office] }).service.addBlock(actor, { value: OFFICE }, context),
    );
    expect(range.status).toBe(409);
    expect(range.message).toContain('160.79.104.0/21');
    const env = await failure(
      setup({ env: '154.47.20.0/24' }).service.addBlock(actor, { value: ATTACKER }, context),
    );
    expect(env.status).toBe(409);
    const asn: AllowlistEntry = { id: 'b', kind: 'asn', value: '60068', note: null, createdAt: AT };
    const network = await failure(
      setup({ allow: [asn] }).service.addBlock(actor, { value: ATTACKER }, context),
    );
    expect(network.status).toBe(409);
    expect(network.message).toContain('AS60068');
  });

  it('409s on a block inside an existing block', async () => {
    const { service } = setup({ blocks: [block('154.47.20.0/24')] });
    expect((await failure(service.addBlock(actor, { value: ATTACKER }, context))).status).toBe(409);
  });

  it('the allowlist POST 409s when the value overlaps a block (the other direction)', async () => {
    const { service, allow } = setup({ blocks: [block('154.47.20.0/24')] });
    const error = await failure(service.addEntry(actor, { value: '154.47.0.0/16' }, context));
    expect(error.status).toBe(409);
    expect(error.message).toContain('154.47.20.0/24');
    const byNetwork = await failure(service.addEntry(actor, { value: 'AS60068' }, context));
    expect(byNetwork.status).toBe(409);
    expect(allow).toEqual([]);
    // A value clear of every block is still added.
    await service.addEntry(actor, { value: '48.47.63.166' }, context);
    expect(allow.map((a) => a.value)).toEqual(['48.47.63.166']);
  });

  it('unblocks with an audit row, and 404s an unknown or malformed id', async () => {
    const entry = block(`${ATTACKER}/32`);
    const { service, audits } = setup({ blocks: [entry] });
    await service.removeBlock(actor, entry.id, context);
    expect(audits.map((a) => a.action)).toEqual(['platform.network_block_removed']);
    expect((await failure(service.removeBlock(actor, entry.id, context))).status).toBe(404);
    expect((await failure(service.removeBlock(actor, 'x', context))).status).toBe(404);
    expect((await service.evaluate(request(ATTACKER)))?.because).not.toBe('blocked');
  });
});

describe('the read side for the tracker (gaps 3 and 4)', () => {
  it('reports blocked with the entry id and allowlisted from the cached sets', async () => {
    const entry = block('154.47.20.0/24');
    const office: AllowlistEntry = {
      id: 'a',
      kind: 'cidr',
      value: '160.79.104.0/21',
      note: null,
      createdAt: AT,
    };
    const { service } = setup({ blocks: [entry], allow: [office] });
    const standing = await service.standing([
      { ip: ATTACKER, asn: 60068 },
      { ip: OFFICE, asn: null },
      { ip: '203.0.113.9', asn: 8452 },
    ]);
    expect(standing.get(ATTACKER)).toEqual({
      blocked: true,
      blockId: entry.id,
      allowlisted: false,
    });
    expect(standing.get(OFFICE)).toEqual({ blocked: false, blockId: null, allowlisted: true });
    expect(standing.get('203.0.113.9')).toEqual({
      blocked: false,
      blockId: null,
      allowlisted: false,
    });
  });

  it('turns each list row into ok / off / failed, without the stored error text', () => {
    const row = (over: Partial<BlockListRow>): BlockListRow => ({
      listKey: 'x4b_vpn',
      activeVersion: 'v1',
      rangeCount: 18_420,
      fetchedAt: AT,
      lastAttemptAt: AT,
      failed: false,
      ...over,
    });
    expect(blockListStatus(row({}))).toEqual({
      key: 'x4b_vpn',
      rangeCount: 18_420,
      fetchedAt: AT,
      lastAttemptAt: AT,
      status: 'ok',
    });
    expect(
      blockListStatus(row({ listKey: 'ip2proxy_px1', activeVersion: null, lastAttemptAt: null })),
    ).toMatchObject({ status: 'off', rangeCount: 0 });
    expect(blockListStatus(row({ failed: true })).status).toBe('failed');
    expect(Object.keys(blockListStatus(row({ failed: true })))).not.toContain('lastError');
  });

  it('the GET returns policy, entries, blocked[] and lists[]', async () => {
    const lists: BlockListRow[] = [
      {
        listKey: 'tor_exit',
        activeVersion: 'v2',
        rangeCount: 1_204,
        fetchedAt: AT,
        lastAttemptAt: AT,
        failed: false,
      },
    ];
    const view = await setup({ blocks: [block('154.47.20.0/24')], lists }).service.view();
    expect(view).toMatchObject({
      policy: 'refuse',
      entries: [],
      blocked: [expect.objectContaining({ value: '154.47.20.0/24' })],
      lists: [{ key: 'tor_exit', rangeCount: 1_204, status: 'ok' }],
    });
  });
});
