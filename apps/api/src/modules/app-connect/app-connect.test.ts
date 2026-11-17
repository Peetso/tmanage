import { describe, expect, it } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import type { Principal } from '@tmanage/domain';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { connectorBinding } from '../connectors/connectors.service.js';
import type { ConnectorsRepository } from '../connectors/connectors.repository.js';
import type { ConnectorInstallationRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { pkceChallenge } from '../../common/http/oauth-flow.js';
import {
  APP_CONNECT_PROVIDERS,
  appConnectCallbackPath,
  appConnectCallbackTarget,
  isAppConnectProvider,
  newAppConnectFlow,
  openAppConnectFlow,
  sealAppConnectFlow,
} from './app-connect.flow.js';
import { AppConnectCallbackController, AppConnectController } from './app-connect.controller.js';
import { AppConnectService } from './app-connect.service.js';
import {
  GITHUB_SCOPES,
  createGitHubClient,
  gitHubGrantIsAllowed,
  gitHubOAuthConfigFrom,
} from './github.oauth.js';
import { newFigmaFlow, openFigmaFlow, sealFigmaFlow } from '../figma/figma-oauth.js';

/**
 * FIX5 — one-click Connect for GitHub: the flow cookie and callback, the code exchange against a
 * mocked GitHub (no network), token storage in the vault, the replaced token revoked, the audit
 * rows, Disconnect. Slack and Microsoft Teams were removed: their providers answer 404.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const SECRET = 'session-secret-for-tests-0123456789';
const context = {
  organizationId: ORG,
  userId: 'user-1',
  membershipId: 'membership-1',
} as unknown as TenantContext;
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x61).toString('base64url')}`));

function principal(role: Principal['role']): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: role === 'owner',
  };
}
const owner = principal('owner');

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const ENV = { GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret' };

function build(
  options: {
    env?: Record<string, string>;
    tokens?: string[];
    revokeStatus?: number;
    revokeThrows?: boolean;
    /** The token response's `scope`; `null` leaves it out. */
    scope?: string | null;
    /** The `/user` answer's `X-OAuth-Scopes` header; absent when not given. */
    userScopes?: string;
  } = {},
) {
  const env = options.env ?? ENV;
  const tokens = [...(options.tokens ?? ['gho_token1234'])];
  const rows: ConnectorInstallationRow[] = [];
  const audits: { action: string; metadata: unknown; actorUserId: unknown }[] = [];
  const calls: Call[] = [];
  const logs: string[] = [];
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const vault = {
    findByKey: async (_r: unknown, _c: unknown, key: string) =>
      rows.find((row) => row.connectorKey === key) ?? null,
    insert: async (
      _r: unknown,
      _c: unknown,
      input: { connectorKey: string; credentialEnc: string | null; credentialHint: string | null },
    ) => {
      rows.push({
        id: `row-${rows.length}`,
        organizationId: ORG,
        installedBy: 'user-1',
        installedAt: new Date(0),
        ...input,
      });
    },
    remove: async (_r: unknown, _c: unknown, key: string) => {
      const index = rows.findIndex((row) => row.connectorKey === key);
      if (index >= 0) rows.splice(index, 1);
    },
  } as unknown as ConnectorsRepository;
  const audit = {
    record: async (
      _tx: unknown,
      _c: unknown,
      input: { action: string; metadata: unknown; actorUserId: unknown },
    ) => {
      audits.push({
        action: input.action,
        metadata: input.metadata,
        actorUserId: input.actorUserId,
      });
      return {} as never;
    },
  } as unknown as AuditService;

  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      const scope = options.scope === undefined ? 'read:user' : options.scope;
      return json({
        access_token: tokens.shift() ?? 'gho_spare',
        ...(scope === null ? {} : { scope }),
      });
    }
    if (url.startsWith('https://api.github.com/user')) {
      return new Response(JSON.stringify({ login: 'peter' }), {
        status: 200,
        headers: options.userScopes === undefined ? {} : { 'x-oauth-scopes': options.userScopes },
      });
    }
    if (url.startsWith('https://api.github.com/applications/')) {
      if (options.revokeThrows) throw new Error('ECONNRESET');
      return new Response(null, { status: options.revokeStatus ?? 204 });
    }
    throw new Error(`unexpected call ${url}`);
  };

  const service = new AppConnectService({
    database,
    cipher: CIPHER,
    vault,
    audit,
    config: { github: gitHubOAuthConfigFrom(env) },
    apiPublicUrl: 'https://tmanageapp.com',
    github: createGitHubClient(fetchImpl),
    log: (message) => logs.push(message),
  });
  const revokes = () =>
    calls
      .filter((c) => c.url.includes('/applications/'))
      .map((c) => (JSON.parse(String(c.init.body)) as { access_token: string }).access_token);
  return { service, rows, audits, calls, logs, revokes };
}

function plain(rows: ConnectorInstallationRow[], key: string): string {
  const row = rows.find((r) => r.connectorKey === key);
  if (!row?.credentialEnc) throw new Error(`no ${key} row`);
  return CIPHER.decrypt(row.credentialEnc, connectorBinding(ORG, key));
}

async function connect(harness: ReturnType<typeof build>, code = 'the-code') {
  const { url, flow } = harness.service.start(context, owner, 'github', 'acme');
  const view = await harness.service.complete(context, owner, 'github', flow, {
    code,
    state: flow.state,
  });
  return { url, flow, view };
}

describe('app-connect flow and callback', () => {
  it('seals a provider-bound flow and refuses a forged, expired or malformed cookie', () => {
    const flow = newAppConnectFlow(
      { provider: 'github', organizationId: ORG, organizationSlug: 'acme', membershipId: 'm' },
      1_000,
    );
    const sealed = sealAppConnectFlow(flow, SECRET);
    expect(openAppConnectFlow('github', sealed, SECRET, 1_100)).toEqual(flow);
    expect(openAppConnectFlow('github', sealed, 'other-secret', 1_100)).toBeUndefined();
    expect(openAppConnectFlow('github', `${sealed}x`, SECRET, 1_100)).toBeUndefined();
    expect(openAppConnectFlow('github', sealed, SECRET, 1_000 + 601)).toBeUndefined();
  });

  it('shares one sign-in helper with Figma, but neither cookie opens as the other', () => {
    const owner = { organizationId: ORG, organizationSlug: 'acme', membershipId: 'm' };
    const github = sealAppConnectFlow(newAppConnectFlow({ provider: 'github', ...owner }), SECRET);
    const figma = sealFigmaFlow(newFigmaFlow(owner), SECRET);
    expect(openFigmaFlow(github, SECRET)).toBeUndefined();
    expect(openAppConnectFlow('github', figma, SECRET)).toBeUndefined();
    expect(openFigmaFlow(figma, SECRET)?.organizationSlug).toBe('acme');
  });

  it('forwards code and state to the Integrations page in the fragment only', () => {
    const flow = newAppConnectFlow({
      provider: 'github',
      organizationId: ORG,
      organizationSlug: 'acme',
      membershipId: 'm',
    });
    const cookie = sealAppConnectFlow(flow, SECRET);
    const options = { sessionSecret: SECRET, webPublicUrl: 'https://tmanageapp.com/' };
    const target = appConnectCallbackTarget('github', options, cookie, {
      code: 'c1',
      state: flow.state,
    });
    expect(target.startsWith('https://tmanageapp.com/acme/automations/apps#')).toBe(true);
    const fragment = new URLSearchParams(target.split('#')[1]);
    expect(fragment.get('github')).toBe('complete');
    expect(fragment.get('code')).toBe('c1');
    expect(appConnectCallbackTarget('github', options, cookie, { error: 'access_denied' })).toBe(
      'https://tmanageapp.com/acme/automations/apps#github=error',
    );
    expect(appConnectCallbackTarget('github', options, undefined, { code: 'c', state: 's' })).toBe(
      'https://tmanageapp.com/',
    );
  });

  it('knows only GitHub: Slack and Teams are no longer providers', () => {
    expect(APP_CONNECT_PROVIDERS).toEqual(['github']);
    expect(isAppConnectProvider('slack')).toBe(false);
    expect(isAppConnectProvider('teams')).toBe(false);
    expect(build().service.redirectUri('github')).toBe(
      'https://tmanageapp.com/v1/integrations/github/callback',
    );
    expect(appConnectCallbackPath('github')).toBe('/v1/integrations/github/callback');
  });

  it('answers 404 for slack and teams on every app-connect route, and has no channel routes', () => {
    const { service } = build();
    const options = { sessionSecret: SECRET, secureCookies: false, webPublicUrl: 'https://x' };
    const controller = new AppConnectController(service, options);
    const reply = { header: () => undefined };
    for (const provider of ['slack', 'teams']) {
      expect(() => controller.status(context, owner, provider)).toThrow(
        expect.objectContaining({ status: 404 }),
      );
      expect(() => controller.start(context, owner, 'acme', provider, reply)).toThrow(
        expect.objectContaining({ status: 404 }),
      );
      expect(() =>
        controller.complete(context, owner, provider, {}, { headers: {} }, reply),
      ).toThrow(expect.objectContaining({ status: 404 }));
      expect(() => controller.disconnect(context, owner, provider)).toThrow(
        expect.objectContaining({ status: 404 }),
      );
    }
    const routes = (target: object) =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(target)).filter((n) => n !== 'constructor');
    expect(routes(controller).sort()).toEqual(['complete', 'disconnect', 'start', 'status']);
    const callbacks = new AppConnectCallbackController(options);
    expect(routes(callbacks).filter((name) => name !== 'target')).toEqual(['github']);
  });
});

describe('app-connect service (GitHub)', () => {
  it('says "not set up" without the env vars, and refuses Connect with 409', async () => {
    const harness = build({ env: {} });
    const view = await harness.service.status(context, owner, 'github');
    expect(view).toMatchObject({ setUp: false, connected: false });
    expect(() => harness.service.start(context, owner, 'github', 'acme')).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it('is owner/admin only', async () => {
    const harness = build();
    await expect(
      harness.service.status(context, principal('member'), 'github'),
    ).rejects.toMatchObject({ status: 403 });
    expect(() => harness.service.start(context, principal('member'), 'github', 'acme')).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('refuses a missing, mismatched or other-member flow without calling GitHub', async () => {
    const harness = build();
    const { flow } = harness.service.start(context, owner, 'github', 'acme');
    await expect(
      harness.service.complete(context, owner, 'github', undefined, {
        code: 'c',
        state: flow.state,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      harness.service.complete(context, owner, 'github', flow, { code: 'c', state: 'wrong' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      harness.service.complete(
        context,
        owner,
        'github',
        { ...flow, membershipId: 'someone-else' },
        { code: 'c', state: flow.state },
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      harness.service.complete(
        context,
        owner,
        'github',
        { ...flow, organizationId: 'organization-0000-0000-0000-000000000002' },
        { code: 'c', state: flow.state },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(harness.calls).toHaveLength(0);
    expect(harness.audits).toHaveLength(0);
  });

  it('asks GitHub for read:user only (no repo access), with PKCE', async () => {
    const harness = build();
    const { url, flow } = await connect(harness);
    expect(GITHUB_SCOPES).toBe('read:user');
    const consent = new URL(url);
    expect(consent.origin + consent.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(consent.searchParams.get('scope')).toBe('read:user');
    expect(consent.searchParams.get('scope')).not.toContain('repo');
    expect(consent.searchParams.get('redirect_uri')).toBe(
      'https://tmanageapp.com/v1/integrations/github/callback',
    );
    expect(consent.searchParams.get('code_challenge')).toBe(pkceChallenge(flow.verifier));
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('exchanges the code and stores the token encrypted where a pasted token goes', async () => {
    const harness = build();
    const { flow, view } = await connect(harness);
    expect(view).toMatchObject({ connected: true, setUp: true, account: 'peter' });
    expect(JSON.stringify(view)).not.toContain('gho_');

    const exchange = new URLSearchParams(String(harness.calls[0]?.init.body));
    expect(exchange.get('code_verifier')).toBe(flow.verifier);
    expect(exchange.get('client_secret')).toBe('gh-secret');

    const row = harness.rows.find((r) => r.connectorKey === 'github');
    expect(row?.credentialEnc).not.toContain('gho_token1234');
    expect(row?.credentialHint).toBe('1234');
    expect(plain(harness.rows, 'github')).toBe('gho_token1234');
    // A first Connect has nothing to revoke.
    expect(harness.revokes()).toEqual([]);
  });

  it('audits Connect with the actor and no token', async () => {
    const harness = build();
    await connect(harness);
    expect(harness.audits).toEqual([
      {
        action: 'github_connection.connected',
        metadata: { provider: 'github', replaced: false },
        actorUserId: 'user-1',
      },
    ]);
    expect(JSON.stringify(harness.audits)).not.toContain('gho_');
  });

  it('a second Connect revokes the token it replaces at GitHub, after storing the new one', async () => {
    const harness = build({ tokens: ['gho_first0001', 'gho_second002'] });
    await connect(harness);
    await connect(harness, 'second-code');
    expect(plain(harness.rows, 'github')).toBe('gho_second002');
    expect(harness.rows.filter((r) => r.connectorKey === 'github')).toHaveLength(1);
    expect(harness.revokes()).toEqual(['gho_first0001']);
    expect(harness.audits.map((a) => a.metadata)).toEqual([
      { provider: 'github', replaced: false },
      { provider: 'github', replaced: true },
    ]);
  });

  it('a failed revocation of the replaced token never blocks the new connection', async () => {
    for (const failing of [{ revokeThrows: true }, { revokeStatus: 500 }]) {
      const harness = build({ tokens: ['gho_first0001', 'gho_second002'], ...failing });
      await connect(harness);
      const { view } = await connect(harness, 'second-code');
      expect(view.connected).toBe(true);
      expect(plain(harness.rows, 'github')).toBe('gho_second002');
      expect(harness.logs.join('\n')).toContain('revoke failed');
      expect(harness.logs.join('\n')).not.toContain('gho_');
    }
  });

  it('Disconnect revokes the token at GitHub, forgets it and audits once', async () => {
    const harness = build();
    await connect(harness);
    const view = await harness.service.disconnect(context, owner, 'github');
    expect(view.connected).toBe(false);
    const revoke = harness.calls.find((c) => c.url.includes('/applications/'));
    expect(revoke?.url).toBe('https://api.github.com/applications/gh-id/token');
    expect(revoke?.init.method).toBe('DELETE');
    expect(JSON.parse(String(revoke?.init.body))).toEqual({ access_token: 'gho_token1234' });
    expect(harness.rows).toHaveLength(0);
    expect(harness.audits.map((a) => a.action)).toEqual([
      'github_connection.connected',
      'github_connection.disconnected',
    ]);
    expect(harness.audits[1]).toMatchObject({
      metadata: { provider: 'github' },
      actorUserId: 'user-1',
    });

    // Nothing stored: nothing revoked, nothing audited.
    await harness.service.disconnect(context, owner, 'github');
    expect(harness.audits).toHaveLength(2);
  });

  it('Disconnect forgets the token even when GitHub is down', async () => {
    const harness = build({ revokeThrows: true });
    await connect(harness);
    await harness.service.disconnect(context, owner, 'github');
    expect(harness.rows).toHaveLength(0);
    expect(harness.audits.at(-1)?.action).toBe('github_connection.disconnected');
  });

  it('maps a refused code to 400 and an unreachable GitHub to 409, storing nothing', async () => {
    const base = build();
    const deps = (
      base.service as unknown as { deps: ConstructorParameters<typeof AppConnectService>[0] }
    ).deps;
    const refused = new AppConnectService({
      ...deps,
      github: createGitHubClient(async () => json({ error: 'bad_verification_code' })),
    });
    const { flow } = refused.start(context, owner, 'github', 'acme');
    await expect(
      refused.complete(context, owner, 'github', flow, { code: 'c', state: flow.state }),
    ).rejects.toMatchObject({ status: 400 });

    const down = new AppConnectService({
      ...deps,
      github: createGitHubClient(async () => {
        throw new Error('ECONNRESET');
      }),
    });
    const downFlow = down.start(context, owner, 'github', 'acme').flow;
    await expect(
      down.complete(context, owner, 'github', downFlow, { code: 'c', state: downFlow.state }),
    ).rejects.toMatchObject({ status: 409 });
    expect(base.rows).toHaveLength(0);
    expect(base.audits).toHaveLength(0);
  });
});

describe('app-connect GitHub granted scope (security review L4)', () => {
  it('accepts a read:user grant (and an empty one)', async () => {
    expect(gitHubGrantIsAllowed('read:user')).toBe(true);
    expect(gitHubGrantIsAllowed('')).toBe(true);
    expect(gitHubGrantIsAllowed('read:user, ')).toBe(true);
    const harness = build({ scope: 'read:user' });
    const { view } = await connect(harness);
    expect(view.connected).toBe(true);
    expect(plain(harness.rows, 'github')).toBe('gho_token1234');
    expect(harness.revokes()).toEqual([]);
  });

  it('refuses read:user,repo: revokes the token at GitHub, stores nothing, audits the refusal', async () => {
    const harness = build({ scope: 'read:user,repo' });
    const { flow } = harness.service.start(context, owner, 'github', 'acme');
    await expect(
      harness.service.complete(context, owner, 'github', flow, {
        code: 'the-code',
        state: flow.state,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'validation_failed',
      details: [{ field: 'scope', message: 'scope_too_wide' }],
    });
    expect(harness.rows).toHaveLength(0);
    expect(harness.revokes()).toEqual(['gho_token1234']);
    // Refused before the token is used: no `/user` call.
    expect(harness.calls.some((c) => c.url === 'https://api.github.com/user')).toBe(false);
    expect(harness.audits).toEqual([
      {
        action: 'github_connection.connected',
        metadata: { provider: 'github', reason: 'scope_too_wide' },
        actorUserId: 'user-1',
      },
    ]);
    expect(JSON.stringify(harness.audits)).not.toContain('gho_');
  });

  it('refuses repo alone, and keeps an existing connection untouched', async () => {
    expect(gitHubGrantIsAllowed('repo')).toBe(false);
    const harness = build({ tokens: ['gho_first0001', 'gho_wide00002'] });
    await connect(harness);
    const deps = (
      harness.service as unknown as { deps: ConstructorParameters<typeof AppConnectService>[0] }
    ).deps;
    const wideCalls: string[] = [];
    const wide = new AppConnectService({
      ...deps,
      github: createGitHubClient(async (url, init) => {
        wideCalls.push(url);
        if (url.startsWith('https://github.com/login/oauth/access_token')) {
          return json({ access_token: 'gho_wide00002', scope: 'repo' });
        }
        if (url.includes('/applications/')) {
          wideCalls.push(String(init.body));
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected call ${url}`);
      }),
    });
    const { flow } = wide.start(context, owner, 'github', 'acme');
    await expect(
      wide.complete(context, owner, 'github', flow, { code: 'c', state: flow.state }),
    ).rejects.toMatchObject({
      status: 400,
      details: [{ field: 'scope', message: 'scope_too_wide' }],
    });
    expect(wideCalls).toContain(JSON.stringify({ access_token: 'gho_wide00002' }));
    expect(plain(harness.rows, 'github')).toBe('gho_first0001');
  });

  it('checks X-OAuth-Scopes when the token response carries no scope', async () => {
    const refused = build({ scope: null, userScopes: 'repo, read:user' });
    const { flow } = refused.service.start(context, owner, 'github', 'acme');
    await expect(
      refused.service.complete(context, owner, 'github', flow, { code: 'c', state: flow.state }),
    ).rejects.toMatchObject({ status: 400 });
    expect(refused.rows).toHaveLength(0);
    expect(refused.revokes()).toEqual(['gho_token1234']);

    const fine = build({ scope: null, userScopes: 'read:user' });
    expect((await connect(fine)).view.connected).toBe(true);
  });
});
