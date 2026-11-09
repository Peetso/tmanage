/**
 * FIX5 one-click connectors — the **bot delivery** of a Slack / Teams channel link.
 *
 * A pasted incoming-webhook link stores its URL (encrypted) in `integration_channel_links
 * .webhook_url_enc`. A link made through one-click Connect stores, in the same encrypted column, a
 * descriptor that starts with {@link CHANNEL_BOT_PREFIX}: which channel to post to and the token
 * that posts there. No migration: the column, the cipher purpose (`integration_token`) and the AAD
 * (the link id) are the webhook ones, so a descriptor is exactly as protected as a webhook URL.
 *
 * - Slack: the workspace bot token (`xoxb-…`, does not expire) and the channel id.
 * - Teams: the delegated Microsoft Graph tokens (access + rotating refresh) and the team and
 *   channel ids; the worker refreshes an expired access token and writes the descriptor back.
 */

export const CHANNEL_BOT_PREFIX = 'tm-bot:';

/** The host a bot link shows (`urlHost`) instead of a webhook host. */
export const CHANNEL_BOT_HOSTS = { slack: 'slack.com', teams: 'graph.microsoft.com' } as const;

export interface SlackBotDescriptor {
  readonly provider: 'slack';
  readonly channelId: string;
  readonly botToken: string;
}

export interface TeamsBotDescriptor {
  readonly provider: 'teams';
  readonly teamId: string;
  readonly channelId: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Unix milliseconds. */
  readonly expiresAt: number;
}

export type ChannelBotDescriptor = SlackBotDescriptor | TeamsBotDescriptor;

const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{2,30}$/u;
const TEAM_ID = /^[0-9a-fA-F-]{36}$/u;
/** Graph channel ids look like `19:abc…@thread.tacv2`. */
const TEAMS_CHANNEL_ID = /^19:[A-Za-z0-9_\-.]{1,200}@thread\.[a-z0-9]{1,20}$/u;

export function isSlackChannelId(value: unknown): value is string {
  return typeof value === 'string' && SLACK_CHANNEL_ID.test(value);
}

export function isTeamId(value: unknown): value is string {
  return typeof value === 'string' && TEAM_ID.test(value);
}

export function isTeamsChannelId(value: unknown): value is string {
  return typeof value === 'string' && TEAMS_CHANNEL_ID.test(value);
}

export function isChannelBotSecret(plain: string): boolean {
  return plain.startsWith(CHANNEL_BOT_PREFIX);
}

export function encodeChannelBot(descriptor: ChannelBotDescriptor): string {
  return `${CHANNEL_BOT_PREFIX}${JSON.stringify(descriptor)}`;
}

const str = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The descriptor, or `null` for anything that is not a well-formed bot descriptor. */
export function parseChannelBot(plain: string): ChannelBotDescriptor | null {
  if (!isChannelBotSecret(plain)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(plain.slice(CHANNEL_BOT_PREFIX.length)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  if (raw['provider'] === 'slack') {
    if (!isSlackChannelId(raw['channelId']) || !str(raw['botToken'])) return null;
    return { provider: 'slack', channelId: raw['channelId'], botToken: raw['botToken'] };
  }
  if (raw['provider'] === 'teams') {
    if (!isTeamId(raw['teamId']) || !isTeamsChannelId(raw['channelId'])) return null;
    if (!str(raw['accessToken']) || typeof raw['expiresAt'] !== 'number') return null;
    return {
      provider: 'teams',
      teamId: raw['teamId'],
      channelId: raw['channelId'],
      accessToken: raw['accessToken'],
      refreshToken: str(raw['refreshToken']) ? raw['refreshToken'] : null,
      expiresAt: raw['expiresAt'],
    };
  }
  return null;
}

/**
 * A Teams webhook body (`renderTeams`: one Adaptive Card attachment) as a Graph `chatMessage`:
 * the card is referenced from the HTML body by attachment id, and its content is a JSON string.
 */
export function teamsWebhookToChatMessage(body: Record<string, unknown>): Record<string, unknown> {
  const attachments = Array.isArray(body['attachments'])
    ? (body['attachments'] as Record<string, unknown>[])
    : [];
  const card = attachments[0]?.['content'] ?? {};
  const id = 'tmanage-notice';
  return {
    body: { contentType: 'html', content: `<attachment id="${id}"></attachment>` },
    attachments: [
      {
        id,
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: JSON.stringify(card),
      },
    ],
  };
}
