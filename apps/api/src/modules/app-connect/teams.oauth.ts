import { isTeamId, isTeamsChannelId } from '@tmanage/domain';
import {
  authorizeEndpoint,
  oneDriveConfigFrom,
  tokenEndpoint,
  type OneDriveConfig,
} from '../onedrive/onedrive.graph.js';
import {
  AppConnectRefusedError,
  AppConnectUnavailableError,
  defaultFetch,
  jsonBody,
  pkceChallenge,
  providerCall,
  type FetchLike,
} from './app-connect.flow.js';

/**
 * FIX5 — Microsoft Teams one-click Connect, on the Microsoft app TManage already has
 * (`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, optional `MICROSOFT_TENANT`: the OneDrive and
 * Outlook registration, read through the OneDrive reader, never copied).
 *
 * Delegated Graph scopes `Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send` (none
 * needs an admin's consent) plus `openid profile offline_access` for the account's name and a
 * refresh token. Access tokens last about an hour; refresh tokens **rotate**, and every refresh
 * stores the newest one. Microsoft has no endpoint for an app to revoke one delegated grant, so
 * Disconnect forgets every token; the person can also remove TManage at myapps.microsoft.com.
 */

export const TEAMS_SCOPES =
  'openid profile offline_access Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send';
export const TEAMS_GRAPH = 'https://graph.microsoft.com/v1.0';
/** Refresh this long before the access token runs out. */
export const TEAMS_REFRESH_MARGIN_MS = 5 * 60_000;

export type TeamsOAuthConfig = OneDriveConfig;

export function teamsOAuthConfigFrom(
  env: Readonly<Record<string, string | undefined>>,
): TeamsOAuthConfig | null {
  return oneDriveConfigFrom(env);
}

export function teamsAuthorizeUrl(input: {
  readonly config: TeamsOAuthConfig;
  readonly redirectUri: string;
  readonly state: string;
  readonly verifier: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    response_mode: 'query',
    client_id: input.config.clientId,
    redirect_uri: input.redirectUri,
    scope: TEAMS_SCOPES,
    state: input.state,
    code_challenge: pkceChallenge(input.verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${authorizeEndpoint(input.config)}?${params.toString()}`;
}

export interface TeamsTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Unix milliseconds. */
  readonly expiresAt: number;
  /** The account's name from the ID token, when Microsoft sent one. */
  readonly account: string | null;
}

export interface TeamsTeam {
  readonly id: string;
  readonly name: string;
}

export interface TeamsChannel {
  readonly id: string;
  readonly name: string;
}

export interface TeamsClient {
  exchangeCode(input: {
    readonly config: TeamsOAuthConfig;
    readonly redirectUri: string;
    readonly code: string;
    readonly verifier: string;
  }): Promise<TeamsTokens>;
  refresh(config: TeamsOAuthConfig, refreshToken: string): Promise<TeamsTokens>;
  listTeams(accessToken: string): Promise<readonly TeamsTeam[]>;
  listChannels(accessToken: string, teamId: string): Promise<readonly TeamsChannel[]>;
}

/** The `name` (or `preferred_username`) claim of an unverified ID token, for display only. */
export function idTokenAccount(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const name = claims['name'] ?? claims['preferred_username'];
    return typeof name === 'string' && name !== '' ? name.slice(0, 200) : null;
  } catch {
    return null;
  }
}

export function createTeamsClient(
  fetchImpl: FetchLike = defaultFetch,
  now: () => number = () => Date.now(),
): TeamsClient {
  async function token(
    config: TeamsOAuthConfig,
    form: Record<string, string>,
  ): Promise<TeamsTokens> {
    const response = await providerCall(
      fetchImpl,
      tokenEndpoint(config),
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          scope: TEAMS_SCOPES,
          ...form,
        }).toString(),
      },
      'Microsoft',
    );
    const body = await jsonBody(response);
    if (!response.ok) {
      if (body['error'] === 'invalid_grant' || response.status === 400 || response.status === 401) {
        throw new AppConnectRefusedError('Microsoft refused the grant');
      }
      throw new AppConnectUnavailableError(`Microsoft answered ${response.status}`);
    }
    const accessToken = typeof body['access_token'] === 'string' ? body['access_token'] : '';
    if (accessToken === '') throw new AppConnectUnavailableError('Microsoft sent no access token');
    const seconds = typeof body['expires_in'] === 'number' ? body['expires_in'] : 3600;
    return {
      accessToken,
      refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : null,
      expiresAt: now() + seconds * 1000,
      account: idTokenAccount(body['id_token']),
    };
  }

  async function graph(accessToken: string, path: string): Promise<Record<string, unknown>> {
    const response = await providerCall(
      fetchImpl,
      `${TEAMS_GRAPH}${path}`,
      { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } },
      'Microsoft Graph',
    );
    if (response.status === 401) throw new AppConnectRefusedError('Graph refused the token');
    if (!response.ok) throw new AppConnectUnavailableError(`Graph answered ${response.status}`);
    return jsonBody(response);
  }

  const named = (raw: unknown): { id: unknown; name: string } => {
    const item = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return {
      id: item['id'],
      name: typeof item['displayName'] === 'string' ? item['displayName'].slice(0, 200) : '',
    };
  };

  return {
    exchangeCode(input) {
      return token(input.config, {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
      });
    },

    refresh(config, refreshToken) {
      return token(config, { grant_type: 'refresh_token', refresh_token: refreshToken });
    },

    async listTeams(accessToken) {
      const body = await graph(accessToken, '/me/joinedTeams?$select=id,displayName');
      const teams: TeamsTeam[] = [];
      for (const raw of Array.isArray(body['value']) ? body['value'] : []) {
        const team = named(raw);
        if (isTeamId(team.id)) teams.push({ id: team.id, name: team.name });
      }
      return teams.sort((a, b) => a.name.localeCompare(b.name));
    },

    async listChannels(accessToken, teamId) {
      const body = await graph(
        accessToken,
        `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`,
      );
      const channels: TeamsChannel[] = [];
      for (const raw of Array.isArray(body['value']) ? body['value'] : []) {
        const channel = named(raw);
        if (isTeamsChannelId(channel.id)) channels.push({ id: channel.id, name: channel.name });
      }
      return channels;
    },
  };
}
