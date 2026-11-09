import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { parseSeedKeys } from '@tmanage/config';
import { parseChannelBot } from '@tmanage/domain';
import type { ChannelBotDescriptor, Principal } from '@tmanage/domain';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { connectorBinding } from '../connectors/connectors.service.js';
import type { ConnectorsRepository } from '../connectors/connectors.repository.js';
import type { ConnectorInstallationRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ChannelLinksService } from '../automations/channel-links.service.js';
import {
  appConnectCallbackPath,
  appConnectCallbackTarget,
  newAppConnectFlow,
  openAppConnectFlow,
  pkceChallenge,
  sealAppConnectFlow,
  type AppConnectProvider,
} from './app-connect.flow.js';
import { AppConnectService } from './app-connect.service.js';
import { createGitHubClient, gitHubOAuthConfigFrom } from './github.oauth.js';
import { createSlackClient, slackOAuthConfigFrom, verifySlackSignature } from './slack.oauth.js';
import { createTeamsClient, teamsOAuthConfigFrom } from './teams.oauth.js';

/**
 * FIX5 — one-click Connect for GitHub, Slack and Teams: the flow cookie and callback, the code
 * exchange against mocked providers (no network), token storage in the vault, the channel picker
 * and Disconnect (revoke, bot links removed, tokens forgotten).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const SECRET = 'session-secret-for-tests-0123456789';
const context = {
  organizationId: ORG,
  userId: 'user-1',
  membershipId: 'membership-1',
} as unknown as TenantContext;
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x61).toString('base64url')}`));
const TEAM = '11111111-2222-3333-4444-555555555555';
const TEAMS_CHANNEL = '19:abcDEF123@thread.tacv2';

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

/** A provider stand-in: answers by URL prefix and records every call. */
function mockFetch(routes: Record<string, (init: RequestInit) => Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) throw new Error(`unexpected call ${url}`);
    return (routes[key] as (init: RequestInit) => Response)(init);
  };
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function idToken(claims: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
}

const ENV = {
  GITHUB_CLIENT_ID: 'gh-id',
  GITHUB_CLIENT_SECRET: 'gh-secret',
  SLACK_CLIENT_ID: 'sl-id',
  SLACK_CLIENT_SECRET: 'sl-secret',
  SLACK_SIGNING_SECRET: 'sl-signing',
  MICROSOFT_CLIENT_ID: 'ms-id',
  MICROSOFT_CLIENT_SECRET: 'ms-secret',
  MICROSOFT_TENANT: 'organizations',
};

function build(options: { env?: Record<string, string>; now?: number } = {}) {
  const env = options.env ?? ENV;
  let now = options.now ?? 1_800_000_000_000;
  const rows: ConnectorInstallationRow[] = [];
  const botLinks: { descriptor: ChannelBotDescriptor; label: string }[] = [];
  const removedBotKinds: string[] = [];
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
        installedAt: new Date(now),
        ...input,
      });
    },
    remove: async (_r: unknown, _c: unknown, key: string) => {
      const index = rows.findIndex((row) => row.connectorKey === key);
      if (index >= 0) rows.splice(index, 1);
    },
  } as unknown as ConnectorsRepository;
  const channels = {
    createBotLink: async (
      _c: unknown,
      descriptor: ChannelBotDescriptor,
      body: { label: string },
    ) => {
      botLinks.push({ descriptor, label: body.label });
      return { id: `link-${botLinks.length}`, label: body.label } as never;
    },
    removeBotLinks: async (_c: unknown, kind: string) => {
      removedBotKinds.push(kind);
      return 1;
    },
  } as unknown as ChannelLinksService;

  const provider = mockFetch({
    'https://github.com/login/oauth/access_token': () =>
      json({ access_token: 'gho_token1234', scope: 'read:user,repo', token_type: 'bearer' }),
    'https://api.github.com/user': () => json({ login: 'peter' }),
    'https://api.github.com/applications/': () => new Response(null, { status: 204 }),
    'https://slack.com/api/oauth.v2.access': () =>
      json({
        ok: true,
        access_token: 'xoxb-bot-token',
        bot_user_id: 'U1',
        team: { id: 'T1', name: 'Peetrix' },
        incoming_webhook: {
          channel: '#general',
          channel_id: 'C0GENERAL',
          url: 'https://hooks.slack.com/services/T1/B1/xyz',
        },
      }),
    'https://slack.com/api/conversations.list': () =>
      json({
        ok: true,
        channels: [
          { id: 'C0RANDOM', name: 'random', is_member: false },
          { id: 'C0GENERAL', name: 'general', is_member: true },
        ],
        response_metadata: { next_cursor: '' },
      }),
    'https://slack.com/api/auth.revoke': () => json({ ok: true, revoked: true }),
    'https://login.microsoftonline.com/organizations/oauth2/v2.0/token': (init) => {
      const form = new URLSearchParams(String(init.body));
      const refreshed = form.get('grant_type') === 'refresh_token';
      return json({
        access_token: refreshed ? 'ms-access-2' : 'ms-access-1',
        refresh_token: refreshed ? 'ms-refresh-2' : 'ms-refresh-1',
        expires_in: 3600,
        id_token: idToken({ name: 'Peter Example' }),
      });
    },
    'https://graph.microsoft.com/v1.0/me/joinedTeams': () =>
      json({ value: [{ id: TEAM, displayName: 'Studio' }] }),
    [`https://graph.microsoft.com/v1.0/teams/${TEAM}/channels`]: () =>
      json({ value: [{ id: TEAMS_CHANNEL, displayName: 'General' }] }),
  });

  const service = new AppConnectService({
    database,
    cipher: CIPHER,
    vault,
    channels,
    config: {
      github: gitHubOAuthConfigFrom(env),
      slack: slackOAuthConfigFrom(env),
      teams: teamsOAuthConfigFrom(env),
    },
    apiPublicUrl: 'https://tmanage.peetrix.com',
    github: createGitHubClient(provider.fetchImpl),
    slack: createSlackClient(provider.fetchImpl),
    teams: createTeamsClient(provider.fetchImpl, () => now),
    now: () => now,
  });
  return {
    service,
    rows,
    botLinks,
    removedBotKinds,
    calls: provider.calls,
    advance: (ms: number) => (now += ms),
  };
}

function plain(rows: ConnectorInstallationRow[], key: string): string {
  const row = rows.find((r) => r.connectorKey === key);
  if (!row?.credentialEnc) throw new Error(`no ${key} row`);
  return CIPHER.decrypt(row.credentialEnc, connectorBinding(ORG, key));
}

async function connect(
  harness: ReturnType<typeof build>,
  provider: AppConnectProvider,
  code = 'the-code',
) {
  const { url, flow } = harness.service.start(context, owner, provider, 'acme');
  const view = await harness.service.complete(context, owner, provider, flow, {
    code,
    state: flow.state,
  });
  return { url, flow, view };
}

describe('app-connect flow and callback', () => {
  it('seals a provider-bound flow and refuses a forged, expired or other-provider cookie', () => {
    const flow = newAppConnectFlow(
      { provider: 'github', organizationId: ORG, organizationSlug: 'acme', membershipId: 'm' },
      1_000,
    );
    const sealed = sealAppConnectFlow(flow, SECRET);
    expect(openAppConnectFlow('github', sealed, SECRET, 1_100)).toEqual(flow);
    expect(openAppConnectFlow('slack', sealed, SECRET, 1_100)).toBeUndefined();
    expect(openAppConnectFlow('github', sealed, 'other-secret', 1_100)).toBeUndefined();
    expect(openAppConnectFlow('github', `${sealed}x`, SECRET, 1_100)).toBeUndefined();
    expect(openAppConnectFlow('github', sealed, SECRET, 1_000 + 601)).toBeUndefined();
  });

  it('forwards code and state to the Integrations page in the fragment only', () => {
    const flow = newAppConnectFlow({
      provider: 'slack',
      organizationId: ORG,
      organizationSlug: 'acme',
      membershipId: 'm',
    });
    const cookie = sealAppConnectFlow(flow, SECRET);
    const options = { sessionSecret: SECRET, webPublicUrl: 'https://tmanage.peetrix.com/' };
    const target = appConnectCallbackTarget('slack', options, cookie, {
      code: 'c1',
      state: flow.state,
    });
    expect(target.startsWith('https://tmanage.peetrix.com/acme/automations/apps#')).toBe(true);
    const fragment = new URLSearchParams(target.split('#')[1]);
    expect(fragment.get('slack')).toBe('complete');
    expect(fragment.get('code')).toBe('c1');
    expect(appConnectCallbackTarget('slack', options, cookie, { error: 'access_denied' })).toBe(
      'https://tmanage.peetrix.com/acme/automations/apps#slack=error',
    );
    expect(appConnectCallbackTarget('github', options, cookie, { code: 'c', state: 's' })).toBe(
      'https://tmanage.peetrix.com/',
    );
  });

  it('uses exactly the registered callbacks', () => {
    expect(build().service.redirectUri('github')).toBe(
      'https://tmanage.peetrix.com/v1/integrations/github/callback',
    );
    expect(appConnectCallbackPath('slack')).toBe('/v1/integrations/slack/callback');
    expect(appConnectCallbackPath('teams')).toBe('/v1/integrations/teams/callback');
  });
});

describe('app-connect service', () => {
  it('says "not set up" without the env vars, and refuses Connect with 409', async () => {
    const harness = build({ env: {} });
    for (const provider of ['github', 'slack', 'teams'] as const) {
      const view = await harness.service.status(context, owner, provider);
      expect(view).toMatchObject({ setUp: false, connected: false });
      expect(() => harness.service.start(context, owner, provider, 'acme')).toThrow(
        expect.objectContaining({ status: 409 }),
      );
    }
  });

  it('is owner/admin only', async () => {
    const harness = build();
    await expect(
      harness.service.status(context, principal('member'), 'github'),
    ).rejects.toMatchObject({ status: 403 });
    expect(() => harness.service.start(context, principal('member'), 'slack', 'acme')).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('refuses a missing, mismatched or other-member flow without calling the provider', async () => {
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
    expect(harness.calls).toHaveLength(0);
  });

  it('GitHub: PKCE consent, code exchange, token stored encrypted where a pasted token goes', async () => {
    const harness = build();
    const { url, flow, view } = await connect(harness, 'github');
    const consent = new URL(url);
    expect(consent.origin + consent.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(consent.searchParams.get('scope')).toBe('read:user repo');
    expect(consent.searchParams.get('redirect_uri')).toBe(
      'https://tmanage.peetrix.com/v1/integrations/github/callback',
    );
    expect(consent.searchParams.get('code_challenge')).toBe(pkceChallenge(flow.verifier));
    expect(view).toMatchObject({ connected: true, setUp: true, account: 'peter' });
    expect(JSON.stringify(view)).not.toContain('gho_');

    const exchange = new URLSearchParams(String(harness.calls[0]?.init.body));
    expect(exchange.get('code_verifier')).toBe(flow.verifier);
    expect(exchange.get('client_secret')).toBe('gh-secret');

    const row = harness.rows.find((r) => r.connectorKey === 'github');
    expect(row?.credentialEnc).not.toContain('gho_token1234');
    expect(row?.credentialHint).toBe('1234');
    expect(plain(harness.rows, 'github')).toBe('gho_token1234');
  });

  it('GitHub: Disconnect revokes the token at GitHub and forgets it', async () => {
    const harness = build();
    await connect(harness, 'github');
    const view = await harness.service.disconnect(context, owner, 'github');
    expect(view.connected).toBe(false);
    const revoke = harness.calls.find((c) => c.url.includes('/applications/'));
    expect(revoke?.url).toBe('https://api.github.com/applications/gh-id/token');
    expect(revoke?.init.method).toBe('DELETE');
    expect(JSON.parse(String(revoke?.init.body))).toEqual({ access_token: 'gho_token1234' });
    expect(harness.rows).toHaveLength(0);
  });

  it('Slack: Add to Slack stores the bot token and links the channel chosen on Slack', async () => {
    const harness = build();
    const { url, view } = await connect(harness, 'slack');
    const consent = new URL(url);
    expect(consent.origin + consent.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(consent.searchParams.get('scope')).toBe('chat:write,channels:read,incoming-webhook');
    expect(view).toMatchObject({ connected: true, account: 'Peetrix', channel: 'general' });

    const stored = JSON.parse(plain(harness.rows, 'slack')) as Record<string, unknown>;
    expect(stored).toMatchObject({ botToken: 'xoxb-bot-token', channelId: 'C0GENERAL' });
    expect(harness.botLinks).toEqual([
      {
        descriptor: { provider: 'slack', channelId: 'C0GENERAL', botToken: 'xoxb-bot-token' },
        label: '#general',
      },
    ]);
  });

  it('Slack: the picker lists channels and only links a listed one', async () => {
    const harness = build();
    await connect(harness, 'slack');
    const listed = await harness.service.listChannels(context, owner, 'slack', undefined);
    expect(listed.channels?.map((c) => c.name)).toEqual(['general', 'random']);
    await harness.service.addChannel(context, owner, 'slack', { channelId: 'C0RANDOM' });
    expect(harness.botLinks.at(-1)?.label).toBe('#random');
    await expect(
      harness.service.addChannel(context, owner, 'slack', { channelId: 'C0NOTOURS' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('Slack: Disconnect revokes the bot token, removes bot links and forgets the token', async () => {
    const harness = build();
    await connect(harness, 'slack');
    await harness.service.disconnect(context, owner, 'slack');
    const revoke = harness.calls.find((c) => c.url.endsWith('/auth.revoke'));
    expect((revoke?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer xoxb-bot-token',
    );
    expect(harness.removedBotKinds).toEqual(['slack']);
    expect(harness.rows).toHaveLength(0);
  });

  it('Teams: PKCE consent, tokens stored, team + channel picked, refresh when expired', async () => {
    const harness = build();
    const { url, view } = await connect(harness, 'teams');
    const consent = new URL(url);
    expect(consent.origin + consent.pathname).toBe(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
    );
    expect(consent.searchParams.get('scope')).toContain(
      'Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send',
    );
    expect(view).toMatchObject({ connected: true, account: 'Peter Example' });

    const teams = await harness.service.listChannels(context, owner, 'teams', undefined);
    expect(teams.teams).toEqual([{ id: TEAM, name: 'Studio' }]);
    const channels = await harness.service.listChannels(context, owner, 'teams', TEAM);
    expect(channels.channels).toEqual([{ id: TEAMS_CHANNEL, name: 'General' }]);

    // An hour later the access token is out: the next use refreshes and stores the new pair.
    harness.advance(2 * 3600 * 1000);
    await harness.service.addChannel(context, owner, 'teams', {
      teamId: TEAM,
      channelId: TEAMS_CHANNEL,
    });
    const link = harness.botLinks.at(-1);
    expect(link?.label).toBe('Studio › General');
    expect(link?.descriptor).toMatchObject({
      provider: 'teams',
      accessToken: 'ms-access-2',
      refreshToken: 'ms-refresh-2',
    });
    expect(JSON.parse(plain(harness.rows, 'teams'))).toMatchObject({
      accessToken: 'ms-access-2',
      refreshToken: 'ms-refresh-2',
    });
  });

  it('Teams: Disconnect removes bot links and forgets the tokens (no Microsoft revoke exists)', async () => {
    const harness = build();
    await connect(harness, 'teams');
    const before = harness.calls.length;
    await harness.service.disconnect(context, owner, 'teams');
    expect(harness.calls.length).toBe(before);
    expect(harness.removedBotKinds).toEqual(['teams']);
    expect(harness.rows).toHaveLength(0);
  });

  it('maps a refused code to 400 and an unreachable provider to 409', async () => {
    const refusing = build();
    const refused = {
      ...refusing,
      service: new AppConnectService({
        ...(
          refusing.service as unknown as {
            deps: ConstructorParameters<typeof AppConnectService>[0];
          }
        ).deps,
        github: createGitHubClient(async () => json({ error: 'bad_verification_code' })),
      }),
    };
    const { flow } = refused.service.start(context, owner, 'github', 'acme');
    await expect(
      refused.service.complete(context, owner, 'github', flow, { code: 'c', state: flow.state }),
    ).rejects.toMatchObject({ status: 400 });

    const down = new AppConnectService({
      ...(
        refusing.service as unknown as { deps: ConstructorParameters<typeof AppConnectService>[0] }
      ).deps,
      slack: createSlackClient(async () => {
        throw new Error('ECONNRESET');
      }),
    });
    const slackFlow = down.start(context, owner, 'slack', 'acme').flow;
    await expect(
      down.complete(context, owner, 'slack', slackFlow, { code: 'c', state: slackFlow.state }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('slack signing secret', () => {
  it('accepts Slack’s v0 signature within five minutes and nothing else', () => {
    const rawBody = 'token=x&team_id=T1';
    const signature = `v0=${createHmac('sha256', 'sl-signing').update(`v0:1000:${rawBody}`).digest('hex')}`;
    const base = { signingSecret: 'sl-signing', timestamp: '1000', signature, rawBody };
    expect(verifySlackSignature({ ...base, nowSeconds: 1_100 })).toBe(true);
    expect(verifySlackSignature({ ...base, nowSeconds: 1_400 })).toBe(false);
    expect(verifySlackSignature({ ...base, rawBody: 'tampered', nowSeconds: 1_100 })).toBe(false);
  });
});

describe('bot descriptor', () => {
  it('parses only well-formed descriptors', () => {
    expect(
      parseChannelBot('tm-bot:{"provider":"slack","channelId":"C0GENERAL","botToken":"xoxb-1"}'),
    ).toEqual({ provider: 'slack', channelId: 'C0GENERAL', botToken: 'xoxb-1' });
    expect(parseChannelBot('https://hooks.slack.com/services/x')).toBeNull();
    expect(
      parseChannelBot('tm-bot:{"provider":"slack","channelId":"../x","botToken":"t"}'),
    ).toBeNull();
    expect(parseChannelBot('tm-bot:not json')).toBeNull();
  });
});
