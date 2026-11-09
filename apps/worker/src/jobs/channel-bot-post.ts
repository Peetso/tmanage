import { teamsWebhookToChatMessage } from '@tmanage/domain';
import type { ChannelBotDescriptor, TeamsBotDescriptor } from '@tmanage/domain';
import type { PostOutcome } from './channel-post-sweeper.js';

/**
 * FIX5 one-click connectors — the bot half of the channel post sweep. A link made through
 * Connect holds a bot descriptor (`@tmanage/domain` `channel-bot.ts`) instead of a webhook URL;
 * this posts through the provider's own API at a fixed host (no pasted URL, so no egress
 * resolution is needed):
 *
 * - Slack `chat.postMessage` with the bot token; Slack answers 200 with `ok: false` on errors.
 * - Teams Graph `POST /teams/{team}/channels/{channel}/messages` with the delegated token; an
 *   access token near expiry is refreshed first (Microsoft app from `MICROSOFT_*`) and the new
 *   descriptor is written back to the link.
 *
 * A refusal the owner must fix (token revoked, bot not in the channel, channel gone) is reported
 * as response code 410, so the breaker pauses the link at once instead of retrying for a day.
 */

export const BOT_POST_TIMEOUT_MS = 10_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const TEAMS_SCOPES =
  'openid profile offline_access Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send';

/** The Slack errors that will not go away on a retry. */
const SLACK_PERMANENT = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'account_inactive',
  'channel_not_found',
  'is_archived',
  'not_in_channel',
  'missing_scope',
  'restricted_action',
]);

export interface MicrosoftApp {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tenant: string;
}

export function microsoftAppFrom(env: {
  readonly MICROSOFT_CLIENT_ID?: string | undefined;
  readonly MICROSOFT_CLIENT_SECRET?: string | undefined;
  readonly MICROSOFT_TENANT?: string | undefined;
}): MicrosoftApp | null {
  const clientId = env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const tenant = env.MICROSOFT_TENANT?.trim();
  return {
    clientId,
    clientSecret,
    tenant: tenant && /^[A-Za-z0-9.-]{1,64}$/.test(tenant) ? tenant : 'common',
  };
}

export type BotFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface BotPostDeps {
  readonly fetch?: BotFetch | undefined;
  readonly microsoft: MicrosoftApp | null;
  readonly now?: (() => number) | undefined;
  /** Store the refreshed descriptor (plaintext; the caller encrypts it for the link). */
  readonly saveDescriptor: (descriptor: ChannelBotDescriptor) => Promise<void>;
}

const outcome = (
  status: PostOutcome['status'],
  responseCode: number | null,
  error: string | null,
): PostOutcome => ({ status, responseCode, error });

async function call(deps: BotPostDeps, url: string, init: RequestInit): Promise<Response> {
  const fetchImpl = deps.fetch ?? ((u: string, i: RequestInit) => globalThis.fetch(u, i));
  return fetchImpl(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(BOT_POST_TIMEOUT_MS),
  });
}

function networkFailure(error: unknown): PostOutcome {
  const timedOut =
    error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  return outcome('failure', null, timedOut ? 'timeout' : 'connection_failed');
}

async function postSlack(
  deps: BotPostDeps,
  descriptor: Extract<ChannelBotDescriptor, { provider: 'slack' }>,
  body: Record<string, unknown>,
): Promise<PostOutcome> {
  let response: Response;
  try {
    response = await call(deps, 'https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${descriptor.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ ...body, channel: descriptor.channelId, unfurl_links: false }),
    });
  } catch (error) {
    return networkFailure(error);
  }
  if (!response.ok) return outcome('failure', response.status, `slack_http_${response.status}`);
  const answer = (await response.json().catch(() => null)) as {
    ok?: unknown;
    error?: unknown;
  } | null;
  if (answer?.ok === true) return outcome('success', 200, null);
  const error = typeof answer?.error === 'string' ? answer.error.slice(0, 60) : 'unknown';
  if (SLACK_PERMANENT.has(error)) return outcome('failure', 410, `slack_${error}`);
  return outcome('failure', error === 'ratelimited' ? 429 : 502, `slack_${error}`);
}

/** The descriptor with a fresh access token, or the outcome that stops this attempt. */
async function freshTeams(
  deps: BotPostDeps,
  descriptor: TeamsBotDescriptor,
): Promise<TeamsBotDescriptor | PostOutcome> {
  const now = (deps.now ?? (() => Date.now()))();
  if (descriptor.expiresAt - REFRESH_MARGIN_MS > now) return descriptor;
  if (descriptor.refreshToken === null) return outcome('failure', 410, 'teams_reconnect');
  if (deps.microsoft === null) return outcome('failed_permanent', null, 'teams_not_configured');
  const app = deps.microsoft;
  let response: Response;
  try {
    response = await call(
      deps,
      `https://login.microsoftonline.com/${app.tenant}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          scope: TEAMS_SCOPES,
          grant_type: 'refresh_token',
          refresh_token: descriptor.refreshToken,
        }).toString(),
      },
    );
  } catch (error) {
    return networkFailure(error);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || typeof body?.['access_token'] !== 'string') {
    // invalid_grant: revoked, expired or the password changed. The owner connects again.
    if (response.status === 400 || response.status === 401) {
      return outcome('failure', 410, 'teams_reconnect');
    }
    return outcome('failure', response.status, 'teams_token_unavailable');
  }
  const seconds = typeof body['expires_in'] === 'number' ? body['expires_in'] : 3600;
  const fresh: TeamsBotDescriptor = {
    ...descriptor,
    accessToken: body['access_token'],
    refreshToken:
      typeof body['refresh_token'] === 'string' ? body['refresh_token'] : descriptor.refreshToken,
    expiresAt: now + seconds * 1000,
  };
  await deps.saveDescriptor(fresh);
  return fresh;
}

async function postTeams(
  deps: BotPostDeps,
  descriptor: TeamsBotDescriptor,
  body: Record<string, unknown>,
): Promise<PostOutcome> {
  const fresh = await freshTeams(deps, descriptor);
  if (!('provider' in fresh)) return fresh;
  let response: Response;
  try {
    response = await call(
      deps,
      `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(fresh.teamId)}/channels/${encodeURIComponent(fresh.channelId)}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${fresh.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(teamsWebhookToChatMessage(body)),
      },
    );
  } catch (error) {
    return networkFailure(error);
  }
  if (response.status >= 200 && response.status < 300)
    return outcome('success', response.status, null);
  // 401/403: the grant no longer covers the channel; 404: the team or channel is gone.
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return outcome('failure', 410, `teams_http_${response.status}`);
  }
  return outcome('failure', response.status, `teams_http_${response.status}`);
}

/** Post one rendered notice (`renderChannelNotice` output) through the link's bot. */
export function postThroughBot(
  deps: BotPostDeps,
  descriptor: ChannelBotDescriptor,
  body: Record<string, unknown>,
): Promise<PostOutcome> {
  return descriptor.provider === 'slack'
    ? postSlack(deps, descriptor, body)
    : postTeams(deps, descriptor, body);
}
