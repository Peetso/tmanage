import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 53-14 — the pure half of calendar push notifications and the ICS feed token: no database, no
 * network, so the checks that keep an outsider out are provable on their own.
 *
 * - A **secret** (a watch channel's token, a Graph subscription's `clientState`, an ICS feed
 *   address) is 32 random bytes, base64url. Only its SHA-256 hex is stored; the comparison is
 *   constant-time over the two hashes.
 * - A **notification** names its channel; the webhook finds the connection by that id and then
 *   proves the secret (and, for Google, the resource id) before anything runs.
 */

export const PUSH_PATH_GOOGLE = '/v1/public/calendar-push/google';
export const PUSH_PATH_MICROSOFT = '/v1/public/calendar-push/microsoft';
export const FEED_PATH = '/v1/public/calendar-feeds';

/** Google keeps an events watch channel for at most a week; Graph an events subscription ~3 days. */
export const GOOGLE_WATCH_TTL_MS = 7 * 86_400_000;
export const GRAPH_SUBSCRIPTION_TTL_MS = 4_200 * 60_000;
/** A channel ending within this is renewed by the sync job. */
export const PUSH_RENEW_BEFORE_MS = 24 * 3_600_000;

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
const CHANNEL_ID = /^[A-Za-z0-9_\-+/=]{1,64}$/;

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** A presented secret against a stored hash: shape first, then a constant-time compare. */
export function secretMatches(storedHash: string | null, presented: unknown): boolean {
  if (storedHash === null || !HASH.test(storedHash)) return false;
  if (typeof presented !== 'string' || !SECRET.test(presented)) return false;
  return timingSafeEqual(Buffer.from(hashSecret(presented), 'hex'), Buffer.from(storedHash, 'hex'));
}

/** The ICS token as it arrives in the path: the secret itself, or `null` when it cannot be one. */
export function feedSecretFrom(raw: unknown): string | null {
  return typeof raw === 'string' && SECRET.test(raw) ? raw : null;
}

/** The webhook address, or `null` when the API is not reachable over HTTPS (local: poll only). */
export function pushAddress(apiPublicUrl: string, path: string): string | null {
  const base = apiPublicUrl.replace(/\/+$/, '');
  return base.startsWith('https://') ? `${base}${path}` : null;
}

type Headers = Readonly<Record<string, string | string[] | undefined>>;

function one(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** What a Google push request says, or `null` when it is not shaped like one. */
export interface GoogleNotification {
  readonly channelId: string;
  readonly token: string | undefined;
  readonly resourceId: string | undefined;
  /** `sync` is the channel's own hello; `exists` / `not_exists` mean something changed. */
  readonly state: string | undefined;
}

export function readGoogleNotification(headers: Headers): GoogleNotification | null {
  const channelId = one(headers, 'x-goog-channel-id');
  if (!channelId || !CHANNEL_ID.test(channelId)) return null;
  return {
    channelId,
    token: one(headers, 'x-goog-channel-token'),
    resourceId: one(headers, 'x-goog-resource-id'),
    state: one(headers, 'x-goog-resource-state'),
  };
}

/** The stored channel a Google notification must match: token hash and resource id. */
export function googleNotificationValid(
  stored: { readonly watchTokenHash: string | null; readonly watchResourceId: string | null },
  notification: GoogleNotification,
): boolean {
  if (!secretMatches(stored.watchTokenHash, notification.token)) return false;
  return stored.watchResourceId === null || stored.watchResourceId === notification.resourceId;
}

/** One entry of a Graph change notification: the subscription it names and its `clientState`. */
export interface GraphNotification {
  readonly subscriptionId: string;
  readonly clientState: unknown;
}

/** The entries of a Graph notification body (at most 100; anything malformed is skipped). */
export function readGraphNotifications(body: unknown): readonly GraphNotification[] {
  const value = (body as { value?: unknown } | null)?.value;
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 100)
    .filter(
      (entry): entry is { subscriptionId: string; clientState?: unknown } =>
        typeof (entry as { subscriptionId?: unknown })?.subscriptionId === 'string' &&
        CHANNEL_ID.test((entry as { subscriptionId: string }).subscriptionId),
    )
    .map((entry) => ({ subscriptionId: entry.subscriptionId, clientState: entry.clientState }));
}

/** Graph's subscription handshake echoes `validationToken` as text; anything odd is refused. */
export function graphValidationToken(raw: unknown): string | null {
  return typeof raw === 'string' &&
    raw.length > 0 &&
    raw.length <= 1024 &&
    /^[\x20-\x7e]+$/.test(raw)
    ? raw
    : null;
}
