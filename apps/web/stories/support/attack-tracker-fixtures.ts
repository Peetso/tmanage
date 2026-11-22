import { ApiClient } from '../../src/lib/api/client';
import type {
  NetworkAccessView,
  TrackDetail,
  TrackPage,
  TrackStep,
  TrackSummary,
} from '../../src/lib/api/platform-security';
import type { PlatformMeView } from '../../src/lib/api/platform-admin';

/**
 * The Attack tracker's story data: the eight sources, the selected source's timeline, the
 * allowlist and the sign-in door exactly as the Figma frames draw them (840:1578 EN light, 840:906
 * AR light). Instants are built in the reader's own zone so "11:42" reads 11:42 wherever the
 * harness runs, which is what the screen promises (times in your own time zone).
 */

/** Sunday 22 November 2026, 12:00 local: "today" for every story. */
export const TRACKER_NOW = new Date(2026, 10, 22, 12, 0, 0);

const at = (day: number, hour: number, minute: number, second = 0) =>
  new Date(2026, 10, day, hour, minute, second).toISOString();

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

type Lang = 'en' | 'ar';

function track(fields: Partial<TrackSummary> & Pick<TrackSummary, 'trackId' | 'ip'>): TrackSummary {
  return {
    network: null,
    firstSeen: at(22, 0, 0),
    lastSeen: at(22, 0, 0),
    steps: 0,
    attempts: 0,
    refused: 0,
    throttled: 0,
    succeeded: 0,
    doorRefused: 0,
    accountsTargeted: [],
    userAgents: [],
    signals: [],
    breached: false,
    severity: 'medium',
    blocked: false,
    blockId: null,
    allowlisted: false,
    label: null,
    labelId: null,
    labelNote: null,
    ...fields,
  };
}

const ACCOUNT_IDS = Array.from({ length: 12 }, (_, index) => `user-${index + 1}`);

export const TRACKS: readonly TrackSummary[] = [
  track({
    trackId: 'a'.repeat(64),
    ip: '89.187.162.18',
    network: {
      countryCode: 'NL',
      asn: 60068,
      owner: 'CDN77',
      kind: 'hosting',
      tor: false,
      vpnLikely: true,
    },
    firstSeen: at(22, 11, 35),
    lastSeen: at(22, 11, 42),
    steps: 63,
    attempts: 63,
    refused: 53,
    throttled: 9,
    succeeded: 1,
    doorRefused: 1,
    accountsTargeted: ACCOUNT_IDS,
    userAgents: ['curl/8.4.0', CHROME_WINDOWS],
    signals: ['credential_stuffing', 'guard_refusal_burst', 'sign_in_after_failures'],
    breached: true,
    severity: 'critical',
  }),
  track({
    trackId: 'b'.repeat(64),
    ip: '185.220.101.47',
    network: {
      countryCode: 'DE',
      asn: 208294,
      owner: 'Zwiebelfreunde',
      kind: 'isp',
      tor: true,
      vpnLikely: false,
    },
    firstSeen: at(21, 22, 10),
    lastSeen: at(22, 11, 40),
    attempts: 214,
    refused: 176,
    throttled: 38,
    severity: 'high',
    blocked: true,
    blockId: 'block-1',
  }),
  track({
    trackId: 'c'.repeat(64),
    ip: '45.134.26.9',
    network: {
      countryCode: 'RU',
      asn: 49505,
      owner: 'Selectel',
      kind: 'hosting',
      tor: false,
      vpnLikely: false,
    },
    firstSeen: at(22, 3, 2),
    lastSeen: at(22, 10, 15),
    attempts: 48,
    refused: 40,
    throttled: 8,
    severity: 'high',
  }),
  track({
    trackId: 'd'.repeat(64),
    ip: '154.47.20.3',
    network: {
      countryCode: 'US',
      asn: 9009,
      owner: 'M247',
      kind: 'hosting',
      tor: false,
      vpnLikely: true,
    },
    firstSeen: at(22, 8, 44),
    lastSeen: at(22, 9, 20),
    attempts: 12,
    refused: 12,
  }),
  track({
    trackId: 'e'.repeat(64),
    ip: '2a03:b0c0:3:d0::1a2',
    network: {
      countryCode: 'DE',
      asn: 14061,
      owner: 'DigitalOcean',
      kind: 'hosting',
      tor: false,
      vpnLikely: false,
    },
    firstSeen: at(21, 17, 30),
    lastSeen: at(22, 8, 2),
    attempts: 22,
    refused: 22,
  }),
  track({
    trackId: 'f'.repeat(64),
    ip: '102.218.44.77',
    network: {
      countryCode: 'EG',
      asn: 36935,
      owner: 'Vodafone Egypt',
      kind: 'isp',
      tor: false,
      vpnLikely: false,
    },
    firstSeen: at(21, 13, 5),
    lastSeen: at(21, 19, 0),
    attempts: 7,
    refused: 7,
  }),
  track({
    trackId: '1'.repeat(64),
    ip: '48.47.63.166',
    network: {
      countryCode: 'US',
      asn: 8075,
      owner: 'Microsoft',
      kind: 'hosting',
      tor: false,
      vpnLikely: false,
    },
    firstSeen: at(22, 7, 12),
    lastSeen: at(22, 7, 30),
    attempts: 22,
    refused: 20,
    throttled: 2,
    allowlisted: true,
    label: 'known_tester',
    labelId: 'label-1',
    labelNote: 'Instinct AI tester',
  }),
  track({
    trackId: '2'.repeat(64),
    ip: '41.33.120.5',
    network: {
      countryCode: 'EG',
      asn: 8452,
      owner: 'TE Data',
      kind: 'isp',
      tor: false,
      vpnLikely: false,
    },
    firstSeen: at(20, 9, 40),
    lastSeen: at(20, 9, 41),
    attempts: 3,
    refused: 3,
    severity: 'low',
  }),
];

const COUNTS: TrackPage['counts'] = {
  all: 8,
  critical: 1,
  high: 2,
  vpn: 2,
  tor: 1,
  hosting: 3,
  known_tester: 1,
};

/** The tiles over the whole window, as the API sums them (every source, not the page). */
export const WINDOW_TOTALS: TrackPage['windowTotals'] = {
  sources: COUNTS.all,
  gotIn: COUNTS.critical,
  refused: TRACKS.reduce((sum, track) => sum + track.refused, 0),
  throttled: TRACKS.reduce((sum, track) => sum + track.throttled, 0),
};

/** A window with nothing in it. */
export const QUIET_WINDOW_TOTALS: TrackPage['windowTotals'] = {
  sources: 0,
  gotIn: 0,
  refused: 0,
  throttled: 0,
};

const NAMES: Readonly<Record<Lang, readonly (readonly [string, string, string])[]>> = {
  en: [
    ['Mona Adel', 'mona@northwind.studio', 'Northwind Studio'],
    ['Omar Haddad', 'omar@northwind.studio', 'Northwind Studio'],
    ['Lina Saleh', 'lina@atlas.agency', 'Atlas Agency'],
    ['Karim Nabil', 'karim@atlas.agency', 'Atlas Agency'],
    ['Sara Fouad', 'sara@bluefern.co', 'Bluefern'],
    ['Youssef Amin', 'youssef@bluefern.co', 'Bluefern'],
    ['Hana Ali', 'hana@cedar.works', 'Cedar Works'],
    ['Tarek Samir', 'tarek@cedar.works', 'Cedar Works'],
    ['Nour Ibrahim', 'nour@delta.design', 'Delta Design'],
    ['Ahmed Fathy', 'ahmed@delta.design', 'Delta Design'],
    ['Rania Magdy', 'rania@ember.media', 'Ember Media'],
    ['Ziad Hassan', 'ziad@ember.media', 'Ember Media'],
  ],
  ar: [
    ['منى عادل', 'mona@northwind.studio', 'Northwind Studio'],
    ['عمر حداد', 'omar@northwind.studio', 'Northwind Studio'],
    ['لينا صالح', 'lina@atlas.agency', 'Atlas Agency'],
    ['كريم نبيل', 'karim@atlas.agency', 'Atlas Agency'],
    ['سارة فؤاد', 'sara@bluefern.co', 'Bluefern'],
    ['يوسف أمين', 'youssef@bluefern.co', 'Bluefern'],
    ['هنا علي', 'hana@cedar.works', 'Cedar Works'],
    ['طارق سمير', 'tarek@cedar.works', 'Cedar Works'],
    ['نور إبراهيم', 'nour@delta.design', 'Delta Design'],
    ['أحمد فتحي', 'ahmed@delta.design', 'Delta Design'],
    ['رانيا مجدي', 'rania@ember.media', 'Ember Media'],
    ['زياد حسن', 'ziad@ember.media', 'Ember Media'],
  ],
};

function step(
  fields: Partial<TrackStep> & Pick<TrackStep, 'at' | 'kind' | 'action' | 'outcome'>,
): TrackStep {
  return { reason: null, userId: null, userAgent: null, ...fields };
}

/** The worst source's 63 attempts: newest first they fold into seven lines. */
function timeline(): readonly TrackStep[] {
  const steps: TrackStep[] = [
    step({
      at: at(22, 11, 42, 10),
      kind: 'sign_in',
      action: 'password_sign_in',
      outcome: 'succeeded',
      userId: 'user-1',
      userAgent: CHROME_WINDOWS,
    }),
    step({
      at: at(22, 11, 41, 20),
      kind: 'sign_in',
      action: 'network_guard',
      outcome: 'refused',
      reason: 'network_refused',
      userAgent: CHROME_WINDOWS,
      layers: ['net.a.list:x4b_vpn', 'net.b.time_zone:mismatch'],
      score: 80,
    }),
    step({
      at: at(22, 11, 38, 0),
      kind: 'signal',
      action: 'credential_stuffing',
      outcome: 'signal',
      reason: 'high',
      count: 38,
    }),
  ];
  for (let index = 0; index < 4; index += 1) {
    steps.push(
      step({
        at: at(22, 11, 37, 50 - index * 10),
        kind: 'public_link',
        action: 'public_link_code',
        outcome: 'refused',
        reason: 'wrong_code',
        userAgent: 'curl/8.4.0',
      }),
    );
  }
  for (let index = 0; index < 38; index += 1) {
    steps.push(
      step({
        at: at(22, 11, 36, 59 - index),
        kind: 'sign_in',
        action: 'password_sign_in',
        outcome: 'refused',
        reason: 'bad_password',
        userId: ACCOUNT_IDS[index % ACCOUNT_IDS.length] ?? null,
        userAgent: 'curl/8.4.0',
      }),
    );
  }
  steps.push(
    step({
      at: at(22, 11, 35, 40),
      kind: 'rate_limit',
      action: 'sign_in',
      outcome: 'observed',
      count: 9,
    }),
  );
  for (let index = 0; index < 10; index += 1) {
    steps.push(
      step({
        at: at(22, 11, 35, 30 - index),
        kind: 'sign_in',
        action: 'password_sign_in',
        outcome: 'refused',
        reason: 'no_such_user',
        userAgent: 'curl/8.4.0',
      }),
    );
  }
  return steps;
}

export function trackDetail(summary: TrackSummary, lang: Lang = 'en'): TrackDetail {
  const worst = summary.trackId === TRACKS[0]?.trackId;
  return {
    ...summary,
    timeline: worst
      ? timeline()
      : [
          step({
            at: summary.lastSeen,
            kind: 'sign_in',
            action: 'password_sign_in',
            outcome: 'refused',
            reason: 'bad_password',
            count: summary.refused,
          }),
        ],
    accounts: worst
      ? NAMES[lang].map(([displayName, email, organization], index) => ({
          userId: ACCOUNT_IDS[index] ?? `user-${index}`,
          displayName,
          email,
          organizations: [
            { name: organization, slug: organization.toLowerCase().replace(/ /gu, '-') },
          ],
        }))
      : [],
    accountsTotal: summary.accountsTargeted.length,
    accountsVisible: true,
    canSignOutAccounts: true,
    onLists: worst ? ['x4b_vpn'] : [],
  };
}

export const DOOR: NetworkAccessView = {
  policy: 'refuse',
  entries: [
    {
      id: 'allow-1',
      kind: 'cidr',
      value: '48.47.63.166/32',
      note: 'Instinct AI tester (Peter, 2026-11-22)',
      createdAt: at(22, 9, 0),
    },
    {
      id: 'allow-2',
      kind: 'cidr',
      value: '160.79.104.0/21',
      note: 'Anthropic, Claude checks (Peter, 2026-11-22)',
      createdAt: at(22, 9, 5),
    },
  ],
  blocked: [
    {
      id: 'block-1',
      value: '185.220.101.47',
      note: 'Stolen-password attempts',
      createdAt: at(21, 23, 0),
    },
  ],
  lists: [
    {
      key: 'x4b_vpn',
      rangeCount: 18_420,
      fetchedAt: at(22, 6, 0),
      lastAttemptAt: at(22, 6, 0),
      status: 'ok',
    },
    {
      key: 'x4b_datacenter',
      rangeCount: 61_033,
      fetchedAt: at(22, 6, 0),
      lastAttemptAt: at(22, 6, 0),
      status: 'ok',
    },
    {
      key: 'tor_exit',
      rangeCount: 1_204,
      fetchedAt: at(22, 6, 0),
      lastAttemptAt: at(22, 6, 0),
      status: 'ok',
    },
    { key: 'ip2proxy_px1', rangeCount: 0, fetchedAt: null, lastAttemptAt: null, status: 'off' },
  ],
};

export const PLATFORM_ME: PlatformMeView = {
  email: 'peter@tmanageapp.com',
  displayName: 'Peter',
  mfaEnabled: true,
  stepUpNeedsAuthenticatorCode: true,
  stepUpExpiresAt: new Date(TRACKER_NOW.getTime() + 20 * 3_600_000).toISOString(),
  stepUpMinutes: 1440,
  source: 'env',
  preset: 'super_admin',
  permissions: ['platform.settings.edit', 'platform.people.view', 'platform.people.security'],
  supportSessions: [],
};

export type TrackerVariant = 'busy' | 'quiet' | 'list-error' | 'loading';

export interface TrackerClientOptions {
  readonly variant?: TrackerVariant;
  readonly lang?: Lang;
}

function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function filtered(filter: string | null, q: string | null): readonly TrackSummary[] {
  return TRACKS.filter((item) => {
    if (
      q &&
      !item.ip.startsWith(q) &&
      !(item.network?.owner ?? '').toLowerCase().includes(q.toLowerCase())
    )
      return false;
    switch (filter) {
      case 'critical':
      case 'high':
        return item.severity === filter;
      case 'vpn':
        return item.network?.vpnLikely === true;
      case 'tor':
        return item.network?.tor === true;
      case 'hosting':
        return item.network?.kind === 'hosting';
      case 'known_tester':
        return item.label === 'known_tester';
      default:
        return true;
    }
  });
}

/** A client that answers every Attack tracker read from the data above; writes succeed. */
export function trackerClient({
  variant = 'busy',
  lang = 'en',
}: TrackerClientOptions = {}): ApiClient {
  const answer = (url: URL, method: string): Promise<Response> | Response => {
    const path = url.pathname;
    if (path === '/v1/platform/me') return json(PLATFORM_ME);
    if (path === '/v1/platform/security/attack-tracks') {
      if (variant === 'loading') return new Promise<Response>(() => undefined);
      if (variant === 'list-error')
        return json(
          { type: 'about:blank', title: 'Unavailable', status: 503, code: 'unavailable' },
          503,
        );
      const tracks =
        variant === 'quiet'
          ? []
          : filtered(url.searchParams.get('filter'), url.searchParams.get('q'));
      const page: TrackPage = {
        tracks,
        from: url.searchParams.get('from') ?? TRACKER_NOW.toISOString(),
        total: tracks.length,
        counts:
          variant === 'quiet'
            ? { all: 0, critical: 0, high: 0, vpn: 0, tor: 0, hosting: 0, known_tester: 0 }
            : COUNTS,
        windowTotals: variant === 'quiet' ? QUIET_WINDOW_TOTALS : WINDOW_TOTALS,
        nextCursor: null,
        truncated: false,
      };
      return json(page);
    }
    if (path.startsWith('/v1/platform/security/attack-tracks/')) {
      const id = path.split('/').pop();
      const found = TRACKS.find((item) => item.trackId === id);
      return found ? json(trackDetail(found, lang)) : json({ status: 404 }, 404);
    }
    if (path === '/v1/platform/security/network-access') {
      if (variant === 'loading') return new Promise<Response>(() => undefined);
      return json(DOOR);
    }
    if (method !== 'GET') return json(undefined, 204);
    return json({ status: 404 }, 404);
  };
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-story',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      return Promise.resolve(answer(url, (init?.method ?? 'GET').toUpperCase()));
    }) as typeof globalThis.fetch,
  });
}
