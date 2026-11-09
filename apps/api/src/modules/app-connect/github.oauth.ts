import {
  AppConnectRefusedError,
  AppConnectUnavailableError,
  defaultFetch,
  jsonBody,
  providerCall,
  type FetchLike,
} from './app-connect.flow.js';
import { pkceChallenge } from '../../common/http/oauth-flow.js';

/**
 * FIX5 — GitHub one-click Connect (a GitHub **OAuth App**, `GITHUB_CLIENT_ID` +
 * `GITHUB_CLIENT_SECRET`). Scope `read:user` only: who connected, nothing in their repositories.
 * Nothing reads repository data with this token yet; on an OAuth App `repo` would grant full
 * read *and write* control of every private repository, so it is not requested (security review
 * 2026-11-10, M1). When an issue / pull-request linker ships it should use a GitHub App with
 * read-only, per-repository permissions instead. GitHub OAuth App tokens do not expire and carry
 * no refresh token; Disconnect, and a second Connect, revoke the token at GitHub
 * (`DELETE /applications/{id}/token`).
 */

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_API = 'https://api.github.com';
export const GITHUB_SCOPES = 'read:user';

export interface GitHubOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export function gitHubOAuthConfigFrom(
  env: Readonly<Record<string, string | undefined>>,
): GitHubOAuthConfig | null {
  const clientId = env['GITHUB_CLIENT_ID']?.trim() ?? '';
  const clientSecret = env['GITHUB_CLIENT_SECRET']?.trim() ?? '';
  return clientId !== '' && clientSecret !== '' ? { clientId, clientSecret } : null;
}

export function gitHubAuthorizeUrl(input: {
  readonly config: GitHubOAuthConfig;
  readonly redirectUri: string;
  readonly state: string;
  readonly verifier: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    redirect_uri: input.redirectUri,
    scope: GITHUB_SCOPES,
    state: input.state,
    allow_signup: 'false',
    code_challenge: pkceChallenge(input.verifier),
    code_challenge_method: 'S256',
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

const apiHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'TManage',
});

export interface GitHubClient {
  exchangeCode(input: {
    readonly config: GitHubOAuthConfig;
    readonly redirectUri: string;
    readonly code: string;
    readonly verifier: string;
  }): Promise<{ readonly accessToken: string; readonly scope: string }>;
  /** The account the token belongs to (`login`). */
  me(accessToken: string): Promise<{ readonly login: string }>;
  /** Best effort: GitHub forgets the token. A token GitHub no longer knows is already revoked. */
  revoke(config: GitHubOAuthConfig, accessToken: string): Promise<void>;
}

export function createGitHubClient(fetchImpl: FetchLike = defaultFetch): GitHubClient {
  return {
    async exchangeCode(input) {
      const response = await providerCall(
        fetchImpl,
        GITHUB_TOKEN_URL,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            client_id: input.config.clientId,
            client_secret: input.config.clientSecret,
            code: input.code,
            redirect_uri: input.redirectUri,
            code_verifier: input.verifier,
          }).toString(),
        },
        'GitHub',
      );
      const body = await jsonBody(response);
      // GitHub answers 200 with `error` for a bad or used code.
      if (response.status === 400 || response.status === 401 || typeof body['error'] === 'string') {
        throw new AppConnectRefusedError('GitHub refused the code');
      }
      if (!response.ok) throw new AppConnectUnavailableError(`GitHub answered ${response.status}`);
      const accessToken = typeof body['access_token'] === 'string' ? body['access_token'] : '';
      if (accessToken === '' || accessToken.length > 512) {
        throw new AppConnectUnavailableError('GitHub sent no usable token');
      }
      return {
        accessToken,
        scope: typeof body['scope'] === 'string' ? body['scope'].slice(0, 200) : '',
      };
    },

    async me(accessToken) {
      const response = await providerCall(
        fetchImpl,
        `${GITHUB_API}/user`,
        { headers: apiHeaders(accessToken) },
        'GitHub',
      );
      if (response.status === 401) throw new AppConnectRefusedError('GitHub refused the token');
      if (!response.ok) throw new AppConnectUnavailableError(`GitHub answered ${response.status}`);
      const body = await jsonBody(response);
      return { login: typeof body['login'] === 'string' ? body['login'].slice(0, 100) : '' };
    },

    async revoke(config, accessToken) {
      const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
      const response = await providerCall(
        fetchImpl,
        `${GITHUB_API}/applications/${encodeURIComponent(config.clientId)}/token`,
        {
          method: 'DELETE',
          headers: {
            authorization: `Basic ${basic}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'user-agent': 'TManage',
          },
          body: JSON.stringify({ access_token: accessToken }),
        },
        'GitHub',
      );
      // 204 revoked; 404/422 GitHub no longer knows it (a pasted token, or already revoked).
      if (response.status === 204 || response.status === 404 || response.status === 422) return;
      if (!response.ok) throw new AppConnectUnavailableError(`GitHub answered ${response.status}`);
    },
  };
}
