import { describe, expect, it } from 'vitest';
import { renderChannelNotice } from '@tmanage/domain';
import type { ChannelBotDescriptor, TeamsBotDescriptor } from '@tmanage/domain';
import { postThroughBot } from './channel-bot-post.js';
import type { BotFetch } from './channel-bot-post.js';

/** FIX5 — notices posted as the Slack bot / through Graph for Teams, providers mocked. */

const NOW = 1_800_000_000_000;
const TEAM = '11111111-2222-3333-4444-555555555555';
const CHANNEL = '19:abc@thread.tacv2';
const MICROSOFT = { clientId: 'ms-id', clientSecret: 'ms-secret', tenant: 'organizations' };

function mock(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: BotFetch = async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const notice = (kind: 'slack' | 'teams') =>
  renderChannelNotice(kind, { kind: 'integration.test', state: null, link: null }, 'en');

describe('channel bot posts', () => {
  it('posts to Slack chat.postMessage as the bot, into the picked channel', async () => {
    const provider = mock(() => json({ ok: true }));
    const saved: ChannelBotDescriptor[] = [];
    const outcome = await postThroughBot(
      {
        fetch: provider.fetchImpl,
        microsoft: null,
        saveDescriptor: async (d) => void saved.push(d),
      },
      { provider: 'slack', channelId: 'C0GENERAL', botToken: 'xoxb-1' },
      notice('slack'),
    );
    expect(outcome).toEqual({ status: 'success', responseCode: 200, error: null });
    expect(provider.calls[0]?.url).toBe('https://slack.com/api/chat.postMessage');
    expect((provider.calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer xoxb-1',
    );
    expect(JSON.parse(String(provider.calls[0]?.init.body))).toMatchObject({
      channel: 'C0GENERAL',
    });
    expect(saved).toHaveLength(0);
  });

  it('pauses a Slack link the bot cannot post to (410), and retries a rate limit', async () => {
    const slack = { provider: 'slack', channelId: 'C0GENERAL', botToken: 'xoxb-1' } as const;
    const deps = (error: string) => ({
      fetch: mock(() => json({ ok: false, error })).fetchImpl,
      microsoft: null,
      saveDescriptor: async () => undefined,
    });
    expect(await postThroughBot(deps('not_in_channel'), slack, notice('slack'))).toMatchObject({
      status: 'failure',
      responseCode: 410,
      error: 'slack_not_in_channel',
    });
    expect(await postThroughBot(deps('ratelimited'), slack, notice('slack'))).toMatchObject({
      responseCode: 429,
    });
  });

  it('posts a Teams notice as a Graph chatMessage with the Adaptive Card attached', async () => {
    const provider = mock(() => json({ id: 'm1' }, 201));
    const descriptor: TeamsBotDescriptor = {
      provider: 'teams',
      teamId: TEAM,
      channelId: CHANNEL,
      accessToken: 'ms-access-1',
      refreshToken: 'ms-refresh-1',
      expiresAt: NOW + 3_600_000,
    };
    const outcome = await postThroughBot(
      {
        fetch: provider.fetchImpl,
        microsoft: MICROSOFT,
        now: () => NOW,
        saveDescriptor: async () => undefined,
      },
      descriptor,
      notice('teams'),
    );
    expect(outcome.status).toBe('success');
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.url).toBe(
      `https://graph.microsoft.com/v1.0/teams/${TEAM}/channels/${encodeURIComponent(CHANNEL)}/messages`,
    );
    const message = JSON.parse(String(provider.calls[0]?.init.body)) as {
      body: { content: string };
      attachments: { id: string; contentType: string; content: string }[];
    };
    expect(message.body.content).toBe('<attachment id="tmanage-notice"></attachment>');
    expect(message.attachments[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(JSON.parse(message.attachments[0]?.content ?? '{}')).toMatchObject({
      type: 'AdaptiveCard',
    });
  });

  it('refreshes an expired Teams token first and writes the new descriptor back', async () => {
    const provider = mock((url) =>
      url.startsWith('https://login.microsoftonline.com/organizations/')
        ? json({ access_token: 'ms-access-2', refresh_token: 'ms-refresh-2', expires_in: 3600 })
        : json({ id: 'm1' }, 201),
    );
    const saved: ChannelBotDescriptor[] = [];
    const outcome = await postThroughBot(
      {
        fetch: provider.fetchImpl,
        microsoft: MICROSOFT,
        now: () => NOW,
        saveDescriptor: async (d) => void saved.push(d),
      },
      {
        provider: 'teams',
        teamId: TEAM,
        channelId: CHANNEL,
        accessToken: 'ms-access-1',
        refreshToken: 'ms-refresh-1',
        expiresAt: NOW - 1,
      },
      notice('teams'),
    );
    expect(outcome.status).toBe('success');
    const form = new URLSearchParams(String(provider.calls[0]?.init.body));
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('ms-refresh-1');
    expect(saved[0]).toMatchObject({ accessToken: 'ms-access-2', refreshToken: 'ms-refresh-2' });
    expect((provider.calls[1]?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer ms-access-2',
    );
  });

  it('pauses a Teams link whose grant Microsoft refuses', async () => {
    const provider = mock(() => json({ error: 'invalid_grant' }, 400));
    const outcome = await postThroughBot(
      {
        fetch: provider.fetchImpl,
        microsoft: MICROSOFT,
        now: () => NOW,
        saveDescriptor: async () => undefined,
      },
      {
        provider: 'teams',
        teamId: TEAM,
        channelId: CHANNEL,
        accessToken: 'old',
        refreshToken: 'revoked',
        expiresAt: NOW - 1,
      },
      notice('teams'),
    );
    expect(outcome).toMatchObject({
      status: 'failure',
      responseCode: 410,
      error: 'teams_reconnect',
    });
  });
});
