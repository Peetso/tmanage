import { authorize, isSlackChannelId, isTeamId, isTeamsChannelId } from '@tmanage/domain';
import type { ChannelBotDescriptor, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { SeedCipher } from '../identity/seed-cipher.js';
import { connectorBinding } from '../connectors/connectors.service.js';
import type { ConnectorsRepository } from '../connectors/connectors.repository.js';
import type { ChannelLinkView, ChannelLinksService } from '../automations/channel-links.service.js';
import {
  AppConnectRefusedError,
  appConnectCallbackPath,
  appConnectStateMatches,
  newAppConnectFlow,
  type AppConnectFlow,
  type AppConnectProvider,
} from './app-connect.flow.js';
import { gitHubAuthorizeUrl, type GitHubClient, type GitHubOAuthConfig } from './github.oauth.js';
import { slackAuthorizeUrl, type SlackClient, type SlackOAuthConfig } from './slack.oauth.js';
import {
  TEAMS_REFRESH_MARGIN_MS,
  teamsAuthorizeUrl,
  type TeamsClient,
  type TeamsOAuthConfig,
  type TeamsTokens,
} from './teams.oauth.js';

/**
 * FIX5 — one-click Connect for GitHub, Slack and Microsoft Teams (owner/admin, `org.manage`).
 *
 * Tokens live in the token vault (`connector_installations.credential_enc`, the SeedCipher bound
 * to the organization and the vault key, {@link connectorBinding}) and never leave the server:
 * a view says whether the app is set up and connected, and the account's name, nothing more.
 *
 * - **GitHub** stores the bare access token under `github`, exactly where a pasted token goes,
 *   so every GitHub reader works the same whichever way the owner connected.
 * - **Slack** stores the bot token, workspace and the channel picked on Slack's screen under
 *   `slack`; that channel is linked at once, so Connect alone starts the notices.
 * - **Teams** stores the delegated Graph tokens under `teams` and refreshes them here before use
 *   (refresh tokens rotate; the newest is stored).
 *
 * Picking a channel creates a channel link whose encrypted secret is a bot descriptor (channel +
 * token) instead of a webhook URL; the worker posts through the provider's API. Disconnect revokes
 * at the provider (best effort), removes the provider's bot links and forgets the tokens.
 */

export const APP_CONNECT_SERVICE = Symbol.for('tmanage.AppConnectService');

export interface AppConnectView {
  readonly provider: AppConnectProvider;
  /** The server has this provider's app registered (its env vars are set). */
  readonly setUp: boolean;
  readonly connected: boolean;
  /** GitHub login, Slack workspace or Microsoft account; null when unknown. */
  readonly account: string | null;
  /** Slack: the channel chosen on Slack's own screen. */
  readonly channel: string | null;
}

export interface SlackVaultEntry {
  readonly v: 1;
  readonly botToken: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly channelId: string | null;
  readonly channelName: string | null;
  readonly webhookUrl: string | null;
}

export interface TeamsVaultEntry {
  readonly v: 1;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number;
  readonly account: string | null;
}

export interface AppConnectDeps {
  readonly database: TenantDatabase;
  readonly cipher: SeedCipher;
  readonly vault: Pick<ConnectorsRepository, 'findByKey' | 'insert' | 'remove'>;
  readonly channels: Pick<ChannelLinksService, 'createBotLink' | 'removeBotLinks'>;
  readonly config: {
    readonly github: GitHubOAuthConfig | null;
    readonly slack: SlackOAuthConfig | null;
    readonly teams: TeamsOAuthConfig | null;
  };
  /** Where providers redirect back to (`{apiPublicUrl}/v1/integrations/<provider>/callback`). */
  readonly apiPublicUrl: string;
  readonly github: GitHubClient;
  readonly slack: SlackClient;
  readonly teams: TeamsClient;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

const VAULT_KEY: Readonly<Record<AppConnectProvider, string>> = {
  github: 'github',
  slack: 'slack',
  teams: 'teams',
};

const NAMES: Readonly<Record<AppConnectProvider, string>> = {
  github: 'GitHub',
  slack: 'Slack',
  teams: 'Microsoft Teams',
};

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request is invalid', [{ field, message }]);
}

function conflict(provider: AppConnectProvider, reason: string, message: string): ApiError {
  return new ApiError(
    409,
    'conflict',
    message,
    [{ field: 'provider', message: reason }],
    `app_connect_${provider}_${reason}`,
  );
}

export class AppConnectService {
  private readonly now: () => number;

  constructor(private readonly deps: AppConnectDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private requireManage(context: TenantContext, principal: Principal): void {
    const { allowed } = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'denied_org.manage');
    }
  }

  private setUp(provider: AppConnectProvider): boolean {
    return this.deps.config[provider] !== null && this.deps.apiPublicUrl !== '';
  }

  private requireSetUp(provider: AppConnectProvider): void {
    if (!this.setUp(provider)) {
      throw conflict(provider, 'not_configured', `${NAMES[provider]} is not set up yet`);
    }
  }

  redirectUri(provider: AppConnectProvider): string {
    return `${this.deps.apiPublicUrl.replace(/\/+$/, '')}${appConnectCallbackPath(provider)}`;
  }

  // ── The vault ──────────────────────────────────────────────────────────

  private async readSecret(context: TenantContext, provider: AppConnectProvider) {
    const key = VAULT_KEY[provider];
    const row = await this.deps.database.read(context, (runner) =>
      this.deps.vault.findByKey(runner, context, key),
    );
    if (!row?.credentialEnc) return null;
    try {
      return this.deps.cipher.decrypt(
        row.credentialEnc,
        connectorBinding(context.organizationId, key),
      );
    } catch {
      return null;
    }
  }

  private async writeSecret(
    context: TenantContext,
    provider: AppConnectProvider,
    plain: string,
    hint: string,
  ): Promise<void> {
    const key = VAULT_KEY[provider];
    const credentialEnc = this.deps.cipher.encrypt(
      plain,
      connectorBinding(context.organizationId, key),
    );
    await this.deps.database.transaction(context, async (tx) => {
      // One connection per provider: a second Connect replaces the first.
      await this.deps.vault.remove(tx, context, key);
      await this.deps.vault.insert(tx, context, {
        connectorKey: key,
        credentialEnc,
        credentialHint: hint.slice(-4),
      });
    });
  }

  private async readJson<T>(context: TenantContext, provider: AppConnectProvider) {
    const plain = await this.readSecret(context, provider);
    if (plain === null) return null;
    try {
      const value = JSON.parse(plain) as T & { v?: unknown };
      return value !== null && typeof value === 'object' && value.v === 1 ? (value as T) : null;
    } catch {
      return null;
    }
  }

  // ── Status, start, complete ────────────────────────────────────────────

  async status(
    context: TenantContext,
    principal: Principal,
    provider: AppConnectProvider,
  ): Promise<AppConnectView> {
    this.requireManage(context, principal);
    const base = { provider, setUp: this.setUp(provider), account: null, channel: null };
    if (provider === 'github') {
      return { ...base, connected: (await this.readSecret(context, 'github')) !== null };
    }
    if (provider === 'slack') {
      const entry = await this.readJson<SlackVaultEntry>(context, 'slack');
      return entry === null
        ? { ...base, connected: false }
        : { ...base, connected: true, account: entry.teamName || null, channel: entry.channelName };
    }
    const entry = await this.readJson<TeamsVaultEntry>(context, 'teams');
    return entry === null
      ? { ...base, connected: false }
      : { ...base, connected: true, account: entry.account };
  }

  start(
    context: TenantContext,
    principal: Principal,
    provider: AppConnectProvider,
    organizationSlug: string,
  ): { readonly url: string; readonly flow: AppConnectFlow } {
    this.requireManage(context, principal);
    this.requireSetUp(provider);
    const flow = newAppConnectFlow({
      provider,
      organizationId: context.organizationId,
      organizationSlug,
      membershipId: context.membershipId,
    });
    const common = { redirectUri: this.redirectUri(provider), state: flow.state };
    const { github, slack, teams } = this.deps.config;
    const url =
      provider === 'github'
        ? gitHubAuthorizeUrl({ ...common, config: github!, verifier: flow.verifier })
        : provider === 'slack'
          ? slackAuthorizeUrl({ ...common, config: slack! })
          : teamsAuthorizeUrl({ ...common, config: teams!, verifier: flow.verifier });
    return { url, flow };
  }

  async complete(
    context: TenantContext,
    principal: Principal,
    provider: AppConnectProvider,
    flow: AppConnectFlow | undefined,
    input: { readonly code?: unknown; readonly state?: unknown },
  ): Promise<AppConnectView> {
    this.requireManage(context, principal);
    this.requireSetUp(provider);
    const code = typeof input.code === 'string' ? input.code : '';
    if (
      !flow ||
      flow.provider !== provider ||
      flow.organizationId !== context.organizationId ||
      flow.membershipId !== context.membershipId ||
      !appConnectStateMatches(flow, input.state) ||
      code === '' ||
      code.length > 4096
    ) {
      throw invalid('state', 'the sign-in expired; press Connect again');
    }
    const redirectUri = this.redirectUri(provider);
    try {
      if (provider === 'github') {
        const config = this.deps.config.github!;
        const { accessToken } = await this.deps.github.exchangeCode({
          config,
          redirectUri,
          code,
          verifier: flow.verifier,
        });
        const { login } = await this.deps.github.me(accessToken);
        await this.writeSecret(context, 'github', accessToken, accessToken);
        return { ...(await this.status(context, principal, 'github')), account: login || null };
      }
      if (provider === 'slack') {
        const install = await this.deps.slack.exchangeCode({
          config: this.deps.config.slack!,
          redirectUri,
          code,
        });
        const entry: SlackVaultEntry = { v: 1, ...install };
        await this.writeSecret(context, 'slack', JSON.stringify(entry), install.botToken);
        if (install.channelId !== null) {
          await this.linkQuietly(
            context,
            { provider: 'slack', channelId: install.channelId, botToken: install.botToken },
            install.channelName === null ? 'Slack' : `#${install.channelName}`,
          );
        }
        return this.status(context, principal, 'slack');
      }
      const tokens = await this.deps.teams.exchangeCode({
        config: this.deps.config.teams!,
        redirectUri,
        code,
        verifier: flow.verifier,
      });
      await this.saveTeams(context, tokens, tokens.account);
      return this.status(context, principal, 'teams');
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof AppConnectRefusedError) {
        throw invalid('code', `${NAMES[provider]} did not accept the sign-in; press Connect again`);
      }
      throw conflict(provider, 'unreachable', `${NAMES[provider]} is not reachable right now`);
    }
  }

  /** A channel already linked (a second Connect) is not an error. */
  private async linkQuietly(
    context: TenantContext,
    descriptor: ChannelBotDescriptor,
    label: string,
  ): Promise<void> {
    try {
      await this.deps.channels.createBotLink(context, descriptor, { label });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) throw error;
    }
  }

  private async saveTeams(
    context: TenantContext,
    tokens: TeamsTokens,
    account: string | null,
  ): Promise<TeamsVaultEntry> {
    const entry: TeamsVaultEntry = {
      v: 1,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      account,
    };
    await this.writeSecret(context, 'teams', JSON.stringify(entry), tokens.accessToken);
    return entry;
  }

  /** The Teams tokens, refreshed first when the access token is (nearly) out. */
  private async teamsTokens(context: TenantContext): Promise<TeamsVaultEntry> {
    const entry = await this.readJson<TeamsVaultEntry>(context, 'teams');
    if (entry === null) throw conflict('teams', 'not_connected', 'Connect Microsoft Teams first');
    if (entry.expiresAt - TEAMS_REFRESH_MARGIN_MS > this.now()) return entry;
    if (entry.refreshToken === null) {
      throw conflict('teams', 'reconnect', 'Connect Microsoft Teams again');
    }
    try {
      const fresh = await this.deps.teams.refresh(this.deps.config.teams!, entry.refreshToken);
      return await this.saveTeams(
        context,
        { ...fresh, refreshToken: fresh.refreshToken ?? entry.refreshToken },
        fresh.account ?? entry.account,
      );
    } catch (error) {
      if (error instanceof AppConnectRefusedError) {
        throw conflict('teams', 'reconnect', 'Connect Microsoft Teams again');
      }
      throw conflict('teams', 'unreachable', 'Microsoft Teams is not reachable right now');
    }
  }

  // ── Channels ───────────────────────────────────────────────────────────

  /** Slack: the public channels. Teams: the person's teams, or one team's channels. */
  async listChannels(
    context: TenantContext,
    principal: Principal,
    provider: AppConnectProvider,
    teamId: unknown,
  ): Promise<{
    readonly teams?: readonly { id: string; name: string }[];
    readonly channels?: readonly { id: string; name: string }[];
  }> {
    this.requireManage(context, principal);
    this.requireSetUp(provider);
    try {
      if (provider === 'slack') {
        const entry = await this.readJson<SlackVaultEntry>(context, 'slack');
        if (entry === null) throw conflict('slack', 'not_connected', 'Connect Slack first');
        return { channels: await this.deps.slack.listChannels(entry.botToken) };
      }
      if (provider === 'teams') {
        const tokens = await this.teamsTokens(context);
        if (teamId === undefined || teamId === '') {
          return { teams: await this.deps.teams.listTeams(tokens.accessToken) };
        }
        if (!isTeamId(teamId)) throw invalid('teamId', 'is not a team id');
        return { channels: await this.deps.teams.listChannels(tokens.accessToken, teamId) };
      }
    } catch (error) {
      throw this.providerFailure(provider, error);
    }
    throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'app_connect_no_channels');
  }

  /** Post notices to one more channel (the picker). The channel must be one the provider lists. */
  async addChannel(
    context: TenantContext,
    principal: Principal,
    provider: AppConnectProvider,
    body: {
      readonly channelId?: unknown;
      readonly teamId?: unknown;
      readonly events?: unknown;
      readonly locale?: unknown;
    },
  ): Promise<ChannelLinkView> {
    this.requireManage(context, principal);
    this.requireSetUp(provider);
    try {
      if (provider === 'slack') {
        if (!isSlackChannelId(body.channelId)) throw invalid('channelId', 'is not a channel');
        const entry = await this.readJson<SlackVaultEntry>(context, 'slack');
        if (entry === null) throw conflict('slack', 'not_connected', 'Connect Slack first');
        const channel = (await this.deps.slack.listChannels(entry.botToken)).find(
          (c) => c.id === body.channelId,
        );
        if (!channel) throw invalid('channelId', 'is not a channel of this Slack workspace');
        return await this.deps.channels.createBotLink(
          context,
          { provider: 'slack', channelId: channel.id, botToken: entry.botToken },
          { label: `#${channel.name}`, events: body.events, locale: body.locale },
        );
      }
      if (provider === 'teams') {
        if (!isTeamId(body.teamId)) throw invalid('teamId', 'is not a team id');
        if (!isTeamsChannelId(body.channelId)) throw invalid('channelId', 'is not a channel');
        const tokens = await this.teamsTokens(context);
        const team = (await this.deps.teams.listTeams(tokens.accessToken)).find(
          (t) => t.id === body.teamId,
        );
        const channel = team
          ? (await this.deps.teams.listChannels(tokens.accessToken, team.id)).find(
              (c) => c.id === body.channelId,
            )
          : undefined;
        if (!team || !channel) throw invalid('channelId', 'is not one of your Teams channels');
        return await this.deps.channels.createBotLink(
          context,
          {
            provider: 'teams',
            teamId: team.id,
            channelId: channel.id,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
          },
          { label: `${team.name} › ${channel.name}`, events: body.events, locale: body.locale },
        );
      }
    } catch (error) {
      throw this.providerFailure(provider, error);
    }
    throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'app_connect_no_channels');
  }

  private providerFailure(provider: AppConnectProvider, error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    if (error instanceof AppConnectRefusedError) {
      return conflict(provider, 'reconnect', `Connect ${NAMES[provider]} again`);
    }
    return conflict(provider, 'unreachable', `${NAMES[provider]} is not reachable right now`);
  }

  // ── Disconnect ─────────────────────────────────────────────────────────

  async disconnect(
    context: TenantContext,
    principal: Principal,
    provider: AppConnectProvider,
  ): Promise<AppConnectView> {
    this.requireManage(context, principal);
    const plain = await this.readSecret(context, provider);
    if (plain !== null) {
      try {
        if (provider === 'github' && this.deps.config.github) {
          await this.deps.github.revoke(this.deps.config.github, plain);
        } else if (provider === 'slack') {
          const entry = JSON.parse(plain) as Partial<SlackVaultEntry>;
          if (typeof entry.botToken === 'string') await this.deps.slack.revoke(entry.botToken);
        }
        // Teams: Microsoft offers an app no revoke for one delegated grant; forgetting is all.
      } catch {
        // The provider being down must not keep the tokens here: forget them anyway.
        this.deps.log?.(`[app-connect] ${provider} revoke failed; tokens forgotten locally`);
      }
    }
    if (provider !== 'github') await this.deps.channels.removeBotLinks(context, provider);
    await this.deps.database.transaction(context, (tx) =>
      this.deps.vault.remove(tx, context, VAULT_KEY[provider]),
    );
    return {
      provider,
      setUp: this.setUp(provider),
      connected: false,
      account: null,
      channel: null,
    };
  }
}
