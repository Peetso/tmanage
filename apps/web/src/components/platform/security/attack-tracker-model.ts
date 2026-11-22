import { ipKey, parseIpRange } from '@tmanage/domain';
import type { CapsuleState } from '@tmanage/ui';
import type { MessageKey } from '../../../lib/i18n/t';
import type {
  AllowlistEntry,
  BlockListStatus,
  TrackFilter,
  TrackNetwork,
  TrackSeverity,
  TrackStep,
  TrackStepOutcome,
  TrackSummary,
} from '../../../lib/api/platform-security';

/**
 * The Attack tracker's pure reading of the API (Figma 833:85442, Fix 1 frames 840:1578 …
 * 841:1622). Everything a number or a word on the screen is derived from lives here, so the screen
 * only lays it out and the unit tests can hold each rule on its own.
 */

// ── Period ─────────────────────────────────────────────────────────────────

export type TrackPeriod = '24h' | '7d' | '30d';
export const TRACK_PERIODS: readonly TrackPeriod[] = ['24h', '7d', '30d'];
const PERIOD_DAYS: Readonly<Record<TrackPeriod, number>> = { '24h': 1, '7d': 7, '30d': 30 };

export const PERIOD_LABEL: Readonly<Record<TrackPeriod, MessageKey>> = {
  '24h': 'AttackTracker.period24h',
  '7d': 'AttackTracker.period7d',
  '30d': 'AttackTracker.period30d',
};

export const PERIOD_SUMMARY: Readonly<Record<TrackPeriod, MessageKey>> = {
  '24h': 'AttackTracker.summary24h',
  '7d': 'AttackTracker.summary7d',
  '30d': 'AttackTracker.summary30d',
};

export const PERIOD_QUIET: Readonly<Record<TrackPeriod, MessageKey>> = {
  '24h': 'AttackTracker.quiet24h',
  '7d': 'AttackTracker.quiet7d',
  '30d': 'AttackTracker.quiet30d',
};

/** The window start the list is read from, rounded down to the minute so a refetch keeps its key. */
export function periodFrom(period: TrackPeriod, now: Date): string {
  const start = now.getTime() - PERIOD_DAYS[period] * 86_400_000;
  return new Date(start - (start % 60_000)).toISOString();
}

// ── Chips, capsules and words ──────────────────────────────────────────────

export const FILTER_LABEL: Readonly<Record<TrackFilter, MessageKey>> = {
  all: 'AttackTracker.filterAll',
  critical: 'AttackTracker.severityCritical',
  high: 'AttackTracker.severityHigh',
  vpn: 'AttackTracker.networkVpn',
  tor: 'AttackTracker.networkTor',
  hosting: 'AttackTracker.networkDataCentre',
  known_tester: 'AttackTracker.knownTester',
};

/**
 * The chips shown: every one but "Known tester", which appears only while a marked source exists
 * (Fable must-fix 1), and a chip that is selected always stays so it can be turned off.
 */
export function visibleFilters(
  filters: readonly TrackFilter[],
  counts: Readonly<Record<TrackFilter, number>> | null,
  selected: TrackFilter,
): readonly TrackFilter[] {
  return filters.filter(
    (filter) => filter !== 'known_tester' || selected === filter || (counts?.known_tester ?? 0) > 0,
  );
}

export const SEVERITY_LABEL: Readonly<Record<TrackSeverity, MessageKey>> = {
  critical: 'AttackTracker.severityCritical',
  high: 'AttackTracker.severityHigh',
  medium: 'AttackTracker.severityMedium',
  low: 'AttackTracker.severityLow',
};

/** Critical has the danger edge, High the warning edge; Medium and Low are neutral. */
export const SEVERITY_CAPSULE: Readonly<Record<TrackSeverity, CapsuleState>> = {
  critical: 'blocked',
  high: 'waiting',
  medium: 'neutral',
  low: 'neutral',
};

export type NetworkKind = 'tor' | 'vpn' | 'hosting';

export const NETWORK_LABEL: Readonly<Record<NetworkKind, MessageKey>> = {
  tor: 'AttackTracker.networkTor',
  vpn: 'AttackTracker.networkVpn',
  hosting: 'AttackTracker.networkDataCentre',
};

/** The one network capsule a source shows: Tor, else VPN, else data centre, else none. */
export function networkKind(network: TrackNetwork | null): NetworkKind | null {
  if (network === null) return null;
  if (network.tor) return 'tor';
  if (network.vpnLikely) return 'vpn';
  if (network.kind === 'hosting') return 'hosting';
  return null;
}

/** The country's name in the reader's language ("Netherlands", «هولندا»), or null. */
export function countryName(code: string | null, locale: string): string | null {
  if (code === null || !/^[A-Za-z]{2}$/u.test(code)) return null;
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code.toUpperCase()) ?? null;
  } catch {
    return null;
  }
}

/** "AS60068": the network number, shown in the detail only (must-fix 2). */
export function networkNumber(network: TrackNetwork | null): string | null {
  return network?.asn == null ? null : `AS${network.asn}`;
}

export const SIGNAL_LABEL: Readonly<Record<string, MessageKey>> = {
  credential_stuffing: 'AttackTracker.signalStolenPasswords',
  guard_refusal_burst: 'AttackTracker.signalRefusalsInARow',
  sign_in_after_failures: 'AttackTracker.gotInAfterFailing',
  public_link_guessing: 'AttackTracker.signalLinkGuessing',
  rate_limit_saturation: 'AttackTracker.signalTooManyRequests',
};

export function signalLabel(ruleKey: string): MessageKey {
  return SIGNAL_LABEL[ruleKey] ?? 'AttackTracker.signalOther';
}

/** The source the detail shows: the one picked if it is still listed, else the worst (first). */
export function selectedTrack(
  tracks: readonly TrackSummary[],
  picked: string | null,
): TrackSummary | null {
  return tracks.find((track) => track.trackId === picked) ?? tracks[0] ?? null;
}

// ── Actions follow the source's state (Fable build rule 1) ─────────────────

export type AllowlistAction = 'add' | 'on-list' | 'blocked';

/**
 * "Add to allowlist": an allowlisted source shows it as "On the allowlist", disabled; on a blocked
 * source the click opens the refusal ("This address is blocked. Unblock it first.").
 */
export function allowlistAction(track: TrackSummary): AllowlistAction {
  if (track.allowlisted) return 'on-list';
  if (track.blocked) return 'blocked';
  return 'add';
}

/**
 * The allowlist entry that lets `track` through, as people write it ("160.79.104.0/21", "AS13335"),
 * so the Block dialog can name it; null when none of the entries read matches.
 */
export function allowlistEntryHolding(
  track: Pick<TrackSummary, 'ip' | 'network'>,
  entries: readonly AllowlistEntry[],
): string | null {
  const key = ipKey(track.ip);
  for (const entry of entries) {
    if (entry.kind === 'asn') {
      if (track.network?.asn != null && String(track.network.asn) === entry.value) {
        return `AS${entry.value}`;
      }
      continue;
    }
    const range = parseIpRange(entry.value);
    if (key !== null && range !== null && range.start <= key && key <= range.end) {
      return entry.value;
    }
  }
  return null;
}

// ── Browsers ───────────────────────────────────────────────────────────────

export type ParsedAgent =
  | { readonly kind: 'script'; readonly name: string }
  | { readonly kind: 'browser'; readonly browser: string; readonly system: string | null };

const SCRIPTS: readonly (readonly [RegExp, string])[] = [
  [/^curl\//iu, 'curl'],
  [/^Wget\//iu, 'Wget'],
  [/python-requests|python-urllib|aiohttp|httpx/iu, 'Python'],
  [/Go-http-client/iu, 'Go'],
  [/okhttp/iu, 'OkHttp'],
  [/node-fetch|undici|axios/iu, 'Node.js'],
  [/PostmanRuntime/iu, 'Postman'],
  [/^Java\//iu, 'Java'],
  [/libwww-perl/iu, 'Perl'],
  [/HeadlessChrome|Playwright|Puppeteer/iu, 'headless browser'],
];

/** "Script (curl)" or "Chrome on Windows" from a raw user agent; null when nothing is known. */
export function parseUserAgent(userAgent: string | null): ParsedAgent | null {
  if (userAgent === null || userAgent.trim() === '') return null;
  for (const [pattern, name] of SCRIPTS) {
    if (pattern.test(userAgent)) return { kind: 'script', name };
  }
  const browser = /Edg\//u.test(userAgent)
    ? 'Edge'
    : /OPR\//u.test(userAgent)
      ? 'Opera'
      : /Firefox\//u.test(userAgent)
        ? 'Firefox'
        : /Chrome\//u.test(userAgent)
          ? 'Chrome'
          : /Safari\//u.test(userAgent)
            ? 'Safari'
            : null;
  const system = /iPhone|iPad/u.test(userAgent)
    ? 'iOS'
    : /Android/u.test(userAgent)
      ? 'Android'
      : /Mac OS X|Macintosh/u.test(userAgent)
        ? 'macOS'
        : /Windows/u.test(userAgent)
          ? 'Windows'
          : /Linux/u.test(userAgent)
            ? 'Linux'
            : null;
  if (browser === null) return { kind: 'script', name: userAgent.split(/[/ ]/u)[0] ?? userAgent };
  return { kind: 'browser', browser, system };
}

// ── Timeline ───────────────────────────────────────────────────────────────

/** Steps shown before "All N attempts" (must-fix 6: the panel does not grow). */
export const TIMELINE_PREVIEW = 6;

export interface TimelineGroup {
  /** Stable key: the newest step's time and position. */
  readonly key: string;
  /** The newest step of the run. */
  readonly step: TrackStep;
  /** How many times it happened ("×38"); signals carry no multiplier. */
  readonly times: number;
  /** The accounts the run touched. */
  readonly userIds: readonly string[];
}

function sameRun(a: TrackStep, b: TrackStep): boolean {
  return (
    a.kind === b.kind && a.action === b.action && a.outcome === b.outcome && a.reason === b.reason
  );
}

/**
 * The timeline newest first, with a run of identical steps folded into one line ("Password sign-in
 * ×38 · 12 accounts · wrong password"). A success never folds into the failures around it.
 */
export function groupTimeline(steps: readonly TrackStep[]): readonly TimelineGroup[] {
  const newest = [...steps].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const groups: { step: TrackStep; times: number; users: Set<string>; index: number }[] = [];
  newest.forEach((step, index) => {
    const last = groups[groups.length - 1];
    const weight = step.kind === 'signal' ? 1 : (step.count ?? 1);
    if (last !== undefined && sameRun(last.step, step) && step.outcome !== 'succeeded') {
      last.times += weight;
      if (step.userId !== null) last.users.add(step.userId);
      return;
    }
    groups.push({
      step,
      times: weight,
      users: new Set(step.userId === null ? [] : [step.userId]),
      index,
    });
  });
  return groups.map((group) => ({
    key: `${group.step.at}-${group.index}`,
    step: group.step,
    times: group.step.kind === 'signal' ? 1 : group.times,
    userIds: [...group.users],
  }));
}

const ACTION_TITLE: Readonly<Record<string, MessageKey>> = {
  password_sign_in: 'AttackTracker.stepPasswordSignIn',
  mfa_challenge: 'AttackTracker.stepTwoStepCode',
  recovery_code: 'AttackTracker.stepRecoveryCode',
  google_sign_in: 'AttackTracker.stepGoogleSignIn',
  microsoft_sign_in: 'AttackTracker.stepMicrosoftSignIn',
  magic_link: 'AttackTracker.stepSignInLink',
  reauthentication: 'AttackTracker.stepPasswordCheck',
  password_set: 'AttackTracker.stepPasswordChange',
  network_guard: 'AttackTracker.signInDoor',
};

/** What happened, in plain words ("Password sign-in", "Sign-in door", "Stolen-password attempts"). */
export function stepTitle(step: TrackStep): MessageKey {
  switch (step.kind) {
    case 'signal':
      return signalLabel(step.action);
    case 'public_link':
      return 'AttackTracker.stepPublicLinkCode';
    case 'rate_limit':
      return 'AttackTracker.stepTooManyRequests';
    case 'guard':
      return 'AttackTracker.stepSecurityCheck';
    case 'sign_in':
      return ACTION_TITLE[step.action] ?? 'AttackTracker.stepSignIn';
  }
}

const REASON_DETAIL: Readonly<Record<string, MessageKey>> = {
  bad_password: 'AttackTracker.reasonWrongPassword',
  authentication_failed: 'AttackTracker.reasonWrongPassword',
  no_such_user: 'AttackTracker.reasonUnknownAccount',
  mfa_bad_code: 'AttackTracker.reasonWrongCode',
  wrong_code: 'AttackTracker.reasonWrongCode',
  account_disabled: 'AttackTracker.reasonAccountOff',
  csrf_failed: 'AttackTracker.reasonPageCheck',
  missing_session: 'AttackTracker.reasonSignedOut',
  source_throttled: 'AttackTracker.slowedDown',
  source_account_throttled: 'AttackTracker.slowedDown',
  locked_out: 'AttackTracker.slowedDown',
  rate_limited: 'AttackTracker.slowedDown',
};

/** The reason a step was refused, in plain words, or null. */
export function reasonDetail(step: TrackStep): MessageKey | null {
  if (step.kind === 'rate_limit') return 'AttackTracker.slowedDown';
  if (step.reason === null) return null;
  return REASON_DETAIL[step.reason] ?? null;
}

export type DoorReading =
  { readonly key: MessageKey } | { readonly key: MessageKey; readonly country: true };

const LIST_READING: Readonly<Record<string, MessageKey>> = {
  x4b_vpn: 'AttackTracker.doorOnVpnList',
  x4b_datacenter: 'AttackTracker.doorOnDataCentreList',
  tor_exit: 'AttackTracker.doorTorAddress',
  ip2proxy_px1: 'AttackTracker.doorOnProxyList',
};

/**
 * The sign-in door's readings on a refusal, in plain words ("On a VPN list · clock does not match
 * the Netherlands"). Only the readings that count against the source are named.
 */
export function doorReadings(layers: readonly string[] | undefined): readonly DoorReading[] {
  const out: DoorReading[] = [];
  for (const layer of layers ?? []) {
    if (layer === 'net.blocked') out.push({ key: 'AttackTracker.doorBlockedByYou' });
    else if (layer.startsWith('net.a.list:')) {
      out.push({ key: LIST_READING[layer.slice(11)] ?? 'AttackTracker.doorOnAList' });
    } else if (layer === 'net.a.tor') out.push({ key: 'AttackTracker.doorTorAddress' });
    else if (layer === 'net.a.hosting_asn')
      out.push({ key: 'AttackTracker.doorDataCentreNetwork' });
    else if (layer === 'net.a.vpn_asn') out.push({ key: 'AttackTracker.doorVpnProvider' });
    else if (layer === 'net.b.time_zone:mismatch') {
      out.push({ key: 'AttackTracker.doorClockMismatch', country: true });
    } else if (layer === 'net.b.language:mismatch') {
      out.push({ key: 'AttackTracker.doorLanguageMismatch', country: true });
    }
  }
  return out.filter(
    (reading, index) => out.findIndex((other) => other.key === reading.key) === index,
  );
}

export const OUTCOME_LABEL: Readonly<Record<TrackStepOutcome, MessageKey>> = {
  succeeded: 'AttackTracker.gotIn',
  refused: 'AttackTracker.refused',
  throttled: 'AttackTracker.slowedDown',
  signal: 'AttackTracker.signal',
  observed: 'AttackTracker.slowedDown',
};

export const OUTCOME_CAPSULE: Readonly<Record<TrackStepOutcome, CapsuleState>> = {
  succeeded: 'blocked',
  refused: 'neutral',
  throttled: 'waiting',
  signal: 'client',
  observed: 'waiting',
};

// ── Sign-in door ───────────────────────────────────────────────────────────

/** The four free lists, in the design's order and words (must-fix 4: no provider names). */
export const DOOR_LISTS: readonly { readonly key: string; readonly label: MessageKey }[] = [
  { key: 'x4b_vpn', label: 'AttackTracker.listVpn' },
  { key: 'x4b_datacenter', label: 'AttackTracker.listDataCentre' },
  { key: 'tor_exit', label: 'AttackTracker.listTor' },
  { key: 'ip2proxy_px1', label: 'AttackTracker.listProxy' },
];

/** The newest successful refresh of any list, or null. */
export function lastListRefresh(lists: readonly BlockListStatus[]): string | null {
  return lists.reduce<string | null>(
    (latest, list) =>
      list.fetchedAt !== null && (latest === null || list.fetchedAt > latest)
        ? list.fetchedAt
        : latest,
    null,
  );
}

// ── Dates ──────────────────────────────────────────────────────────────────

/** Calendar-day difference between two instants in the reader's own zone (0 = same day). */
export function dayGap(iso: string, now: Date): number {
  const at = new Date(iso);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOf(now) - startOf(at)) / 86_400_000);
}
