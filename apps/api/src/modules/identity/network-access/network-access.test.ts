import { describe, expect, it } from 'vitest';
import { ipKey } from '@tmanage/domain';
import { ApiError } from '../../../common/http/errors.js';
import type { GuardRefusal } from '../../../common/http/authentication-event-recorder.js';
import type { IpLookupValues } from '../geo/ip-lookups.repository.js';
import { checkTimeZone, decideNetworkAccess } from './network-access-policy.js';
import type { NetworkAccessInput } from './network-access-policy.js';
import type {
  ActiveList,
  AllowlistEntry,
  NetworkAccessStore,
} from './network-access.repository.js';
import {
  NetworkAccessService,
  VPN_REFUSED_MESSAGES,
  envAllowlist,
  parseAllowlistValue,
} from './network-access.service.js';
import type { IpClassifier, NetworkAccessRequest } from './network-access.service.js';
import { NETWORK_GATED_ROUTES } from './network-access.guard.js';

/**
 * SEC-ALERTS item 7. The five cases the brief names (a hosting address is refused, an allowlisted
 * one passes, a residential one passes, an unknown one passes, the refusal is recorded), plus the
 * browser time-zone layer.
 */

const NOW = new Date('2026-11-22T12:00:00.000Z');

// Addresses from the 2026-11-21/22 checks: Anthropic's range sits inside an X4BNet data-centre
// range; the Egyptian home line and the Instinct tester are on no list.
const CLAUDE = '160.79.106.10';
const AWS = '35.88.1.1';
const HOME_EG = '197.167.175.211';
const TESTER = '48.47.63.166';
const UNKNOWN = '203.0.113.50';

const DATACENTER: ActiveList = { listKey: 'x4b_datacenter', version: 'v1' };
const LISTED = new Map([
  [CLAUDE, ['x4b_datacenter']],
  [AWS, ['x4b_datacenter']],
]);

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

const PLACES: Record<string, IpLookupValues> = {
  [AWS]: place({
    countryCode: 'US',
    asn: 16509,
    networkOwner: 'AMAZON-02',
    networkKind: 'hosting',
  }),
  [HOME_EG]: place({
    countryCode: 'EG',
    asn: 8452,
    networkOwner: 'TE Data',
    networkKind: 'residential',
  }),
  [TESTER]: place({
    countryCode: 'US',
    asn: 7922,
    networkOwner: 'Comcast',
    networkKind: 'residential',
  }),
};

function setup(entries: readonly AllowlistEntry[] = [], policy: string | null = null) {
  const recorded: GuardRefusal[] = [];
  const store: NetworkAccessStore = {
    activeLists: () => Promise.resolve([DATACENTER]),
    listHits: (_lists, key) =>
      Promise.resolve(
        [...LISTED].filter(([ip]) => ipKey(ip) === key).flatMap(([, lists]) => lists),
      ),
    allowlist: () => Promise.resolve(entries),
    policy: () => Promise.resolve(policy),
    accountSpread: () => Promise.resolve(null),
    addAllowlistEntry: () => Promise.reject(new Error('unused')),
    removeAllowlistEntry: () => Promise.reject(new Error('unused')),
    setPolicy: () => Promise.reject(new Error('unused')),
    blocklist: () => Promise.resolve([]),
    addBlock: () => Promise.reject(new Error('unused')),
    removeBlock: () => Promise.reject(new Error('unused')),
    listStatus: () => Promise.resolve([]),
  };
  const classifier: IpClassifier = { classify: (ip) => (ip ? (PLACES[ip] ?? null) : null) };
  const service = new NetworkAccessService(
    store,
    classifier,
    { recordGuardRefusal: (r) => void recorded.push(r) },
    envAllowlist(undefined),
    () => NOW,
  );
  return { service, recorded };
}

const request = (ip: string, over: Partial<NetworkAccessRequest> = {}): NetworkAccessRequest => ({
  ip,
  userAgent: 'Mozilla/5.0',
  clientTimeZone: null,
  clientLanguage: null,
  email: null,
  correlationId: 'corr-1',
  ...over,
});

const refusal = async (promise: Promise<void>): Promise<ApiError | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
};

describe('the sign-in door (SEC-ALERTS item 7)', () => {
  it('refuses a data-centre address and records it with every layer', async () => {
    const { service, recorded } = setup();
    const error = await refusal(service.enforce(request(AWS, { clientLanguage: 'en-US' })));
    expect(error?.status).toBe(403);
    expect(error?.message).toBe(VPN_REFUSED_MESSAGES.en);
    expect(recorded).toEqual([
      expect.objectContaining({
        action: 'network_guard',
        reason: 'vpn_refused',
        ip: AWS,
        automationScore: 100,
        automationReasons: expect.arrayContaining([
          'net.a.list:x4b_datacenter',
          'net.a.hosting_asn',
          'net.b.time_zone:unknown',
        ]) as unknown,
      }),
    ]);
  });

  it('lets an allowlisted address through, even inside a data-centre range', async () => {
    const { service, recorded } = setup([
      { id: 'a', kind: 'cidr', value: '160.79.104.0/21', note: null, createdAt: NOW },
    ]);
    expect(await refusal(service.enforce(request(CLAUDE)))).toBeNull();
    expect(recorded).toEqual([]);
    expect((await service.evaluate(request(CLAUDE)))?.because).toBe('allowlisted');
  });

  it('lets a residential address through, with a matching browser clock', async () => {
    const { service } = setup();
    const decision = await service.evaluate(
      request(HOME_EG, { clientTimeZone: 'Africa/Cairo', clientLanguage: 'ar-EG' }),
    );
    expect(decision).toMatchObject({ refuse: false, because: 'clear' });
    expect(await refusal(service.enforce(request(TESTER)))).toBeNull();
  });

  it('lets an unknown address through (fail-open)', async () => {
    const { service } = setup();
    expect(await refusal(service.enforce(request(UNKNOWN)))).toBeNull();
    expect(await refusal(service.enforce(request('not-an-address')))).toBeNull();
  });

  it('refuses a browser on Cairo time behind a US address (layer B)', async () => {
    const { service, recorded } = setup();
    const error = await refusal(
      service.enforce(request(TESTER, { clientTimeZone: 'Africa/Cairo', clientLanguage: 'ar' })),
    );
    expect(error?.message).toBe(VPN_REFUSED_MESSAGES.ar);
    expect(recorded[0]?.automationReasons).toContain('net.b.time_zone:mismatch');
  });

  it('does nothing when the platform policy is allow', async () => {
    const { service, recorded } = setup([], 'allow');
    expect(await refusal(service.enforce(request(AWS)))).toBeNull();
    expect(recorded).toEqual([]);
  });

  it('gates the sign-in, sign-up, reset, OAuth start and portal routes', () => {
    for (const route of [
      'POST v1/auth/password',
      'POST v1/public/sign-up',
      'POST v1/password-resets',
      'POST v1/auth/google/start',
      'POST v1/public/portal-sign-in/code',
    ]) {
      expect(NETWORK_GATED_ROUTES.has(route)).toBe(true);
    }
  });
});

describe('the layers, pure', () => {
  const base: NetworkAccessInput = {
    policy: 'refuse',
    blocked: false,
    allowlisted: false,
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

  it('keeps owner keywords weak: "Google Fiber" is never refused for its name', () => {
    expect(decideNetworkAccess({ ...base, networkOwner: 'Google Fiber Inc.' })).toMatchObject({
      refuse: false,
      reasons: expect.arrayContaining(['net.a_weak.owner_keyword']) as unknown,
    });
  });

  it('refuses Tor and VPN carriers', () => {
    expect(decideNetworkAccess({ ...base, isTor: true }).refuse).toBe(true);
    expect(decideNetworkAccess({ ...base, asn: 39351 }).refuse).toBe(true);
  });

  it('reads the clock against the country, with an hour of tolerance and UTC as weak', () => {
    expect(checkTimeZone('Europe/Berlin', 'DE', NOW)).toBe('match');
    expect(checkTimeZone('Asia/Riyadh', 'EG', NOW)).toBe('match'); // 1 h apart
    expect(checkTimeZone('America/New_York', 'DE', NOW)).toBe('mismatch');
    expect(checkTimeZone('UTC', 'EG', NOW)).toBe('utc');
    expect(checkTimeZone('Not/AZone', 'EG', NOW)).toBe('unknown');
  });

  it('records layer C without refusing on it', () => {
    const decision = decideNetworkAccess({ ...base, accountSpread: { countries: 4, networks: 6 } });
    expect(decision.refuse).toBe(false);
    expect(decision.reasons).toContain('net.c.countries:4');
    expect(decision.score).toBeGreaterThan(0);
  });

  it('parses allowlist values and refuses a slice of the internet', () => {
    expect(parseAllowlistValue('AS13335')).toEqual({ kind: 'asn', value: '13335' });
    expect(parseAllowlistValue('48.47.63.166')).toEqual({ kind: 'cidr', value: '48.47.63.166' });
    expect(parseAllowlistValue('0.0.0.0/0')).toBeNull();
    expect(parseAllowlistValue('hello')).toBeNull();
  });
});
