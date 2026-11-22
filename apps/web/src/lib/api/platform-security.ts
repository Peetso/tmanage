import type { ApiClient } from './client';

/**
 * SEC-ALERTS items 6–7 and SEC-TRACKER — the platform admin's Attack tracker
 * (`/v1/platform/security/attack-tracks…`), the known-tester label
 * (`/v1/platform/security/source-labels…`) and the sign-in door with its allowlist and block list
 * (`/v1/platform/security/network-access…`). Every route is platform admin only, with
 * `platform.settings.edit` behind a fresh step-up, and every read and write is audited on the
 * server.
 *
 * Hand-written for the boundary reason `errors.ts` gives. The API declares its instants as `Date`;
 * on the wire they are ISO strings, which is what is declared here.
 */

export type TrackSeverity = 'critical' | 'high' | 'medium' | 'low';
export type TrackStepOutcome = 'refused' | 'throttled' | 'succeeded' | 'signal' | 'observed';
export type TrackStepKind = 'sign_in' | 'guard' | 'signal' | 'public_link' | 'rate_limit';
export type TrackFilter = 'all' | 'critical' | 'high' | 'vpn' | 'tor' | 'hosting' | 'known_tester';
export type SourceLabelKind = 'known_tester';
export type NetworkPolicyMode = 'refuse' | 'allow';

/** The chips in the order the design draws them (Figma 840:1935). */
export const TRACK_FILTERS: readonly TrackFilter[] = [
  'all',
  'critical',
  'high',
  'vpn',
  'tor',
  'hosting',
  'known_tester',
];

export interface TrackNetwork {
  readonly countryCode: string | null;
  readonly asn: number | null;
  readonly owner: string | null;
  /** `hosting` marks a data-centre network. */
  readonly kind: string;
  readonly tor: boolean;
  readonly vpnLikely: boolean;
}

export interface TrackStep {
  readonly at: string;
  readonly kind: TrackStepKind;
  readonly action: string;
  readonly outcome: TrackStepOutcome;
  readonly reason: string | null;
  readonly userId: string | null;
  readonly userAgent: string | null;
  readonly count?: number;
  /** The sign-in door's readings on a `network_guard` step (`net.a.list:x4b_vpn`, …). */
  readonly layers?: readonly string[];
  readonly score?: number;
}

/** One list row: what the log says about one source address, plus the platform's own state. */
export interface TrackSummary {
  readonly trackId: string;
  readonly ip: string;
  readonly network: TrackNetwork | null;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly steps: number;
  /** `refused + throttled + succeeded`, so the detail line always sums. */
  readonly attempts: number;
  readonly refused: number;
  readonly throttled: number;
  readonly succeeded: number;
  readonly doorRefused: number;
  readonly accountsTargeted: readonly string[];
  readonly userAgents: readonly string[];
  readonly signals: readonly string[];
  readonly breached: boolean;
  readonly severity: TrackSeverity;
  readonly blocked: boolean;
  readonly blockId: string | null;
  readonly allowlisted: boolean;
  readonly label: SourceLabelKind | null;
  readonly labelId: string | null;
  readonly labelNote: string | null;
}

export interface TrackAccount {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly organizations: readonly { readonly name: string; readonly slug: string }[];
}

export interface TrackDetail extends TrackSummary {
  readonly timeline: readonly TrackStep[];
  readonly accounts: readonly TrackAccount[];
  readonly accountsTotal: number;
  /** The viewer may see who was targeted (`platform.people.view`). */
  readonly accountsVisible: boolean;
  /** The viewer may sign a targeted account out everywhere (`platform.people.security`). */
  readonly canSignOutAccounts: boolean;
  readonly onLists: readonly string[];
}

export interface TrackPage {
  readonly tracks: readonly TrackSummary[];
  readonly from: string;
  readonly total: number;
  readonly counts: Readonly<Record<TrackFilter, number>>;
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

export interface AllowlistEntry {
  readonly id: string;
  readonly kind: 'cidr' | 'asn';
  readonly value: string;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface BlockEntry {
  readonly id: string;
  readonly value: string;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface BlockListStatus {
  readonly key: string;
  readonly rangeCount: number;
  readonly fetchedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly status: 'ok' | 'off' | 'failed';
}

export interface NetworkAccessView {
  readonly policy: NetworkPolicyMode;
  readonly entries: readonly AllowlistEntry[];
  readonly blocked: readonly BlockEntry[];
  readonly lists: readonly BlockListStatus[];
}

export interface SourceLabel {
  readonly id: string;
  readonly value: string;
  readonly label: SourceLabelKind;
  readonly note: string | null;
  readonly createdAt: string;
}

const TRACKS = '/v1/platform/security/attack-tracks';
const LABELS = '/v1/platform/security/source-labels';
const DOOR = '/v1/platform/security/network-access';

export interface TrackListQuery {
  /** ISO start of the window (24 h / 7 days / 30 days back). */
  readonly from: string;
  readonly filter: TrackFilter;
  readonly q: string;
  readonly cursor?: string | null;
}

export async function listAttackTracks(
  client: ApiClient,
  query: TrackListQuery,
): Promise<TrackPage> {
  const params = new URLSearchParams({ from: query.from });
  if (query.filter !== 'all') params.set('filter', query.filter);
  const q = query.q.trim();
  if (q !== '') params.set('q', q);
  if (query.cursor) params.set('cursor', query.cursor);
  const { data } = await client.request<TrackPage>({ path: `${TRACKS}?${params.toString()}` });
  return data;
}

/** The track id is the SHA-256 source hash: the address itself never goes into a URL. */
export async function fetchAttackTrack(client: ApiClient, trackId: string): Promise<TrackDetail> {
  const { data } = await client.request<TrackDetail>({
    path: `${TRACKS}/${encodeURIComponent(trackId)}`,
  });
  return data;
}

export async function fetchNetworkAccess(client: ApiClient): Promise<NetworkAccessView> {
  const { data } = await client.request<NetworkAccessView>({ path: DOOR });
  return data;
}

export async function setNetworkPolicy(
  client: ApiClient,
  mode: NetworkPolicyMode,
): Promise<NetworkAccessView> {
  const { data } = await client.request<NetworkAccessView>({
    method: 'PUT',
    path: `${DOOR}/policy`,
    body: { mode },
  });
  return data;
}

function withNote(value: string, note: string): { value: string; note?: string } {
  const trimmed = note.trim();
  return trimmed === '' ? { value } : { value, note: trimmed };
}

export async function addAllowlistEntry(
  client: ApiClient,
  value: string,
  note: string,
): Promise<AllowlistEntry> {
  const { data } = await client.request<AllowlistEntry>({
    method: 'POST',
    path: `${DOOR}/allowlist`,
    body: withNote(value, note),
  });
  return data;
}

export async function removeAllowlistEntry(client: ApiClient, id: string): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `${DOOR}/allowlist/${encodeURIComponent(id)}`,
  });
}

export async function blockSource(
  client: ApiClient,
  value: string,
  note: string,
): Promise<BlockEntry> {
  const { data } = await client.request<BlockEntry>({
    method: 'POST',
    path: `${DOOR}/blocklist`,
    body: withNote(value, note),
  });
  return data;
}

export async function unblockSource(client: ApiClient, id: string): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `${DOOR}/blocklist/${encodeURIComponent(id)}`,
  });
}

export async function markKnownTester(
  client: ApiClient,
  value: string,
  note: string,
): Promise<SourceLabel> {
  const { data } = await client.request<SourceLabel>({
    method: 'POST',
    path: LABELS,
    body: { ...withNote(value, note), label: 'known_tester' },
  });
  return data;
}

export async function removeSourceLabel(client: ApiClient, id: string): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `${LABELS}/${encodeURIComponent(id)}`,
  });
}
