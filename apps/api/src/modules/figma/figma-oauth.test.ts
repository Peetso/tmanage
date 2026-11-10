import { describe, expect, it } from 'vitest';
import {
  FigmaOAuthRefusedError,
  exchangeFigmaCode,
  figmaAuthorizeUrl,
  figmaCallbackTarget,
  newFigmaFlow,
  openFigmaFlow,
  sealFigmaFlow,
} from './figma-oauth.js';
import { figmaAuthHeaders } from './figma.rest.js';
import { pkceChallenge, sealOAuthFlow } from '../../common/http/oauth-flow.js';

/** FIX4 item 6 — Figma one-click Connect: the flow cookie, the callback and the code exchange. */

const SECRET = 'session-secret-for-tests-0123456789';
const owner = { organizationId: 'org-1', organizationSlug: 'acme', membershipId: 'm-1' };

describe('figma-oauth', () => {
  it('seals a flow the server can open, and refuses a forged or expired one', () => {
    const flow = newFigmaFlow(owner, 1_000);
    const sealed = sealFigmaFlow(flow, SECRET);
    expect(openFigmaFlow(sealed, SECRET, 1_100)).toEqual(flow);
    expect(flow.returnTo).toBe('integrations');
    expect(openFigmaFlow(sealed, 'another-secret', 1_100)).toBeUndefined();
    expect(openFigmaFlow(`${sealed}x`, SECRET, 1_100)).toBeUndefined();
    expect(openFigmaFlow(sealed, SECRET, 1_000 + 601)).toBeUndefined();
  });

  it('forwards the code to the Integrations page in the fragment', () => {
    const flow = newFigmaFlow(owner);
    const cookie = sealFigmaFlow(flow, SECRET);
    const options = { sessionSecret: SECRET, webPublicUrl: 'https://app.example.test/' };
    const target = figmaCallbackTarget(options, cookie, 'the-code', flow.state);
    expect(target.startsWith('https://app.example.test/acme/automations/apps#')).toBe(true);
    const fragment = new URLSearchParams(target.split('#')[1]);
    expect(fragment.get('figma')).toBe('complete');
    expect(fragment.get('code')).toBe('the-code');
    expect(figmaCallbackTarget(options, cookie, undefined, undefined)).toBe(
      'https://app.example.test/acme/automations/apps#figma=error',
    );
    expect(figmaCallbackTarget(options, undefined, 'c', 's')).toBe('https://app.example.test/');
    const fromSettings = sealFigmaFlow(
      newFigmaFlow({ ...owner, returnTo: 'connected-apps' }),
      SECRET,
    );
    expect(figmaCallbackTarget(options, fromSettings, 'c', 's')).toMatch(
      /^https:\/\/app\.example\.test\/acme\/settings\/connected-apps#figma=complete/,
    );
  });

  it('exchanges the code with HTTP Basic client credentials', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ access_token: 'figu_abc', refresh_token: 'r' }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const reply = await exchangeFigmaCode(
      {
        config: { clientId: 'id', clientSecret: 'secret' },
        redirectUri: 'https://api.example.test/v1/integrations/figma/callback',
        code: 'the-code',
      },
      fetchImpl,
    );
    expect(reply).toEqual({ accessToken: 'figu_abc' });
    expect(calls[0]?.url).toBe('https://api.figma.com/v1/oauth/token');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.has('client_secret')).toBe(false);

    const refusing = (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch;
    await expect(
      exchangeFigmaCode(
        { config: { clientId: 'id', clientSecret: 's' }, redirectUri: 'x', code: 'c' },
        refusing,
      ),
    ).rejects.toBeInstanceOf(FigmaOAuthRefusedError);
  });

  it('sends an OAuth token as a bearer token and a pasted one as X-Figma-Token', () => {
    expect(figmaAuthHeaders('oauth:figu_abc')).toEqual({ Authorization: 'Bearer figu_abc' });
    expect(figmaAuthHeaders('figd_pasted')).toEqual({ 'X-Figma-Token': 'figd_pasted' });
  });

  describe('PKCE S256 (security review L5)', () => {
    const config = { clientId: 'id', clientSecret: 'secret' };
    const redirectUri = 'https://api.example.test/v1/integrations/figma/callback';
    const capture = () => {
      const bodies: URLSearchParams[] = [];
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        bodies.push(new URLSearchParams(String(init.body)));
        return new Response(JSON.stringify({ access_token: 'figu_abc' }), { status: 200 });
      }) as unknown as typeof fetch;
      return { bodies, fetchImpl };
    };

    it('puts an S256 challenge on the consent address that matches the cookie verifier', () => {
      const flow = newFigmaFlow(owner);
      expect(typeof flow.verifier).toBe('string');
      const opened = openFigmaFlow(sealFigmaFlow(flow, SECRET), SECRET);
      expect(opened?.verifier).toBe(flow.verifier);
      const url = new URL(
        figmaAuthorizeUrl({ config, redirectUri, state: flow.state, verifier: opened?.verifier }),
      );
      expect(url.searchParams.get('code_challenge')).toBe(pkceChallenge(flow.verifier as string));
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    });

    it('sends code_verifier on the exchange, next to the client secret', async () => {
      const { bodies, fetchImpl } = capture();
      await exchangeFigmaCode(
        { config, redirectUri, code: 'c', verifier: 'the-verifier' },
        fetchImpl,
      );
      expect(bodies[0]?.get('code_verifier')).toBe('the-verifier');
    });

    it('still completes a flow sealed before PKCE (no verifier, no code_verifier sent)', async () => {
      const { verifier: _dropped, ...old } = newFigmaFlow(owner);
      const cookie = sealOAuthFlow(old, 'figma-flow.v1', SECRET);
      const opened = openFigmaFlow(cookie, SECRET);
      expect(opened).toBeDefined();
      expect(opened?.verifier).toBeUndefined();
      const url = new URL(
        figmaAuthorizeUrl({ config, redirectUri, state: 's', verifier: undefined }),
      );
      expect(url.searchParams.has('code_challenge')).toBe(false);
      const { bodies, fetchImpl } = capture();
      const reply = await exchangeFigmaCode(
        { config, redirectUri, code: 'c', verifier: opened?.verifier },
        fetchImpl,
      );
      expect(reply).toEqual({ accessToken: 'figu_abc' });
      expect(bodies[0]?.has('code_verifier')).toBe(false);
    });
  });
});
