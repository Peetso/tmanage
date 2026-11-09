import { createHmac } from 'node:crypto';
import { isSlackChannelId } from '@tmanage/domain';
import { constantTimeEquals } from '../identity/session-token.js';
import {
  AppConnectRefusedError,
  AppConnectUnavailableError,
  defaultFetch,
  jsonBody,
  providerCall,
  type FetchLike,
} from './app-connect.flow.js';

/**
 * FIX5 — Slack one-click Connect ("Add to Slack", OAuth v2). `SLACK_CLIENT_ID` +
 * `SLACK_CLIENT_SECRET` switch it on; `SLACK_SIGNING_SECRET` verifies requests Slack sends to
 * TManage ({@link verifySlackSignature}) and is not needed for Connect itself.
 *
 * Bot scopes `chat:write channels:read incoming-webhook`: post notices as the TManage bot, list
 * the workspace's public channels for the picker, and the channel the person chose on Slack's
 * consent screen. Bot tokens (`xoxb-…`) do not expire (token rotation is off for this app).
 * Disconnect calls `auth.revoke`, which also uninstalls the app when it is the last token.
 */

export const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
export const SLACK_API = 'https://slack.com/api';
export const SLACK_BOT_SCOPES = 'chat:write,channels:read,incoming-webhook';

export interface SlackOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signingSecret: string | null;
}

export function slackOAuthConfigFrom(
  env: Readonly<Record<string, string | undefined>>,
): SlackOAuthConfig | null {
  const clientId = env['SLACK_CLIENT_ID']?.trim() ?? '';
  const clientSecret = env['SLACK_CLIENT_SECRET']?.trim() ?? '';
  const signingSecret = env['SLACK_SIGNING_SECRET']?.trim() ?? '';
  if (clientId === '' || clientSecret === '') return null;
  return { clientId, clientSecret, signingSecret: signingSecret === '' ? null : signingSecret };
}

export function slackAuthorizeUrl(input: {
  readonly config: SlackOAuthConfig;
  readonly redirectUri: string;
  readonly state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    scope: SLACK_BOT_SCOPES,
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

export interface SlackInstall {
  readonly botToken: string;
  readonly teamId: string;
  readonly teamName: string;
  /** The channel chosen on Slack's consent screen (the `incoming-webhook` scope). */
  readonly channelId: string | null;
  readonly channelName: string | null;
  /** That channel's incoming-webhook URL; kept so the Advanced path can still use it. */
  readonly webhookUrl: string | null;
}

export interface SlackChannel {
  readonly id: string;
  readonly name: string;
  readonly isMember: boolean;
}

export interface SlackClient {
  exchangeCode(input: {
    readonly config: SlackOAuthConfig;
    readonly redirectUri: string;
    readonly code: string;
  }): Promise<SlackInstall>;
  listChannels(botToken: string): Promise<readonly SlackChannel[]>;
  revoke(botToken: string): Promise<void>;
}

/** Slack answers 200 with `ok: false`; these errors mean the token or code is no good. */
const REFUSALS = new Set([
  'invalid_code',
  'code_already_used',
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'account_inactive',
  'bad_redirect_uri',
  'invalid_client_id',
  'bad_client_secret',
]);

async function slackCall(
  fetchImpl: FetchLike,
  method: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await providerCall(fetchImpl, `${SLACK_API}/${method}`, init, 'Slack');
  if (!response.ok) throw new AppConnectUnavailableError(`Slack answered ${response.status}`);
  const body = await jsonBody(response);
  if (body['ok'] !== true) {
    const error = typeof body['error'] === 'string' ? body['error'] : 'unknown';
    if (REFUSALS.has(error)) throw new AppConnectRefusedError(`Slack refused: ${error}`);
    throw new AppConnectUnavailableError(`Slack answered ${error}`);
  }
  return body;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const text = (value: unknown, max = 200): string =>
  typeof value === 'string' ? value.slice(0, max) : '';

export function createSlackClient(fetchImpl: FetchLike = defaultFetch): SlackClient {
  return {
    async exchangeCode(input) {
      const basic = Buffer.from(`${input.config.clientId}:${input.config.clientSecret}`).toString(
        'base64',
      );
      const body = await slackCall(fetchImpl, 'oauth.v2.access', {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ code: input.code, redirect_uri: input.redirectUri }).toString(),
      });
      const botToken = text(body['access_token'], 512);
      if (!botToken.startsWith('xoxb-')) {
        throw new AppConnectUnavailableError('Slack sent no bot token');
      }
      const team = record(body['team']);
      const hook = record(body['incoming_webhook']);
      const channelId = isSlackChannelId(hook['channel_id']) ? hook['channel_id'] : null;
      const webhookUrl = text(hook['url'], 2048);
      return {
        botToken,
        teamId: text(team['id'], 40),
        teamName: text(team['name']),
        channelId,
        channelName: channelId === null ? null : text(hook['channel']).replace(/^#/u, '') || null,
        webhookUrl: webhookUrl.startsWith('https://hooks.slack.com/') ? webhookUrl : null,
      };
    },

    async listChannels(botToken) {
      const channels: SlackChannel[] = [];
      let cursor = '';
      // At most 5 pages of 200: a picker, not an export.
      for (let page = 0; page < 5; page += 1) {
        const params = new URLSearchParams({
          types: 'public_channel',
          exclude_archived: 'true',
          limit: '200',
        });
        if (cursor !== '') params.set('cursor', cursor);
        const body = await slackCall(fetchImpl, `conversations.list?${params.toString()}`, {
          headers: { authorization: `Bearer ${botToken}` },
        });
        for (const raw of Array.isArray(body['channels']) ? body['channels'] : []) {
          const channel = record(raw);
          if (!isSlackChannelId(channel['id'])) continue;
          channels.push({
            id: channel['id'],
            name: text(channel['name'], 80),
            isMember: channel['is_member'] === true,
          });
        }
        cursor = text(record(body['response_metadata'])['next_cursor'], 500);
        if (cursor === '') break;
      }
      return channels.sort((a, b) => a.name.localeCompare(b.name));
    },

    async revoke(botToken) {
      try {
        await slackCall(fetchImpl, 'auth.revoke', {
          method: 'POST',
          headers: { authorization: `Bearer ${botToken}` },
        });
      } catch (error) {
        // Already revoked or uninstalled is what Disconnect wants.
        if (error instanceof AppConnectRefusedError) return;
        throw error;
      }
    },
  };
}

/** Slack's signing check for requests it sends us (v0, five-minute window). */
export function verifySlackSignature(input: {
  readonly signingSecret: string;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
  readonly rawBody: string;
  readonly nowSeconds?: number;
}): boolean {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const timestamp = Number(input.timestamp);
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > 300) return false;
  if (typeof input.signature !== 'string' || !input.signature.startsWith('v0=')) return false;
  const expected = `v0=${createHmac('sha256', input.signingSecret)
    .update(`v0:${String(timestamp)}:${input.rawBody}`)
    .digest('hex')}`;
  return constantTimeEquals(expected, input.signature);
}
