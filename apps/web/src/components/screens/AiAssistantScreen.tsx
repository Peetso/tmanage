'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { PreferencesNav } from './PreferencesScreen';
import { browserApiClient } from '../../lib/api/browser-client';
import { connectorAddress, deploymentAddress } from '../../lib/ai-connector-address';
import { useOrganizationName } from '../../lib/use-organization-names';
import { listPersonalAccessTokens } from '../../lib/api/personal-access-tokens';
import type { PersonalAccessTokenView } from '../../lib/api/personal-access-tokens';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useHydrated } from '../../lib/use-hydrated';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import '../../styles/screens/preferences.css';
import '../../styles/screens/ai-assistant.css';
import { appLocale } from '../../lib/i18n/app-locale';

export interface AiAssistantScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** This deployment's API origin. Defaults to the browser's; assistants connect to `<it>/mcp`. */
  serverUrl?: string;
  /** "Now", for the expiry check. Injected by tests. */
  now?: () => Date;
}

/**
 * **AI assistant — connect your own Claude, ChatGPT or any MCP assistant.**
 *
 * TManage runs no paid AI model of its own. Instead, the TManage MCP server (`apps/mcp-server`)
 * lets the assistant a person already uses work in TManage over the ordinary HTTP API, signed in
 * with a personal access token. This screen is the front door to that: what it does in plain
 * words, the connection details for this deployment, the member's active tokens and whether an
 * assistant has used one. Tokens are created and revoked on the one Access tokens page
 * (`/{org}/settings/security`, t2-d), where every token gets an expiry; this screen links there.
 *
 * Everything rides the existing personal-access-token routes (`…/me/personal-access-tokens`,
 * behind `work.read`, scoped by the server to the caller's own membership), so a token can only
 * ever do what its member can do, and nobody can see or revoke another member's tokens.
 */
export function AiAssistantScreen({
  organizationSlug,
  organizationName,
  client,
  serverUrl,
  now = () => new Date(),
}: AiAssistantScreenProps) {
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const api = client ?? browserApiClient();
  const t = useT();
  const queryKey = ['personal-access-tokens', organizationSlug] as const;

  const statusLabel: Record<ConnectionStatus['kind'], string> = {
    connected: t('AiAssistantScreen.statusConnected'),
    waiting: t('AiAssistantScreen.statusWaiting'),
    off: t('AiAssistantScreen.statusOff'),
  };

  const statusDetail = (status: ConnectionStatus): string => {
    switch (status.kind) {
      case 'connected':
        return `${t('AiAssistantScreen.statusDetailConnectedPrefix')} ${formatDateTime(status.lastUsedAt)} ${t('AiAssistantScreen.statusDetailConnectedWith')} “${status.tokenName}”.`;
      case 'waiting':
        return t('AiAssistantScreen.statusDetailWaiting');
      case 'off':
        return t('AiAssistantScreen.statusDetailOff');
    }
  };
  // Read after hydration: a same-origin deployment's address is the browser's own origin, which
  // the server render cannot know.
  const hydrated = useHydrated();
  const origin = serverUrl ?? (hydrated ? deploymentAddress() : '');
  // Assistants connect to the hosted MCP endpoint the API serves at `/mcp` (Streamable HTTP,
  // signed in with the personal access token as a Bearer header).
  const address = origin === '' ? '' : connectorAddress(origin);

  const tokens = useQuery({
    queryKey,
    queryFn: () => listPersonalAccessTokens(api, organizationSlug),
  });

  const [assistant, setAssistant] = useState<AssistantId>('claude');
  const workspaceName = useOrganizationName(organizationSlug, organizationName);

  const active = (tokens.data ?? []).filter((token) => isActive(token, now()));
  const status = connectionStatus(active);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={t('AiAssistantScreen.eyebrow')}
      title={t('AiAssistantScreen.title')}
      description={t('AiAssistantScreen.description')}
      contextRail={<PreferencesNav organizationSlug={organizationSlug} current="ai-assistant" />}
    >
      <div className="tm-prefs tm-ai">
        <div className="tm-prefs__main">
          <section className="tm-prefs-card" aria-labelledby="tm-ai-how-heading">
            <h2 id="tm-ai-how-heading" className="tm-prefs-eyebrow">
              {t('AiAssistantScreen.howItWorks')}
            </h2>
            <ol className="tm-ai-steps">
              <li className="tm-ai-step">
                <span className="tm-ai-step__num" aria-hidden="true">
                  1
                </span>
                <span className="tm-ai-step__text">
                  <span className="tm-prefs-card__lead">{t('AiAssistantScreen.step1Lead')}</span>
                  <span className="tm-prefs-card__body">{t('AiAssistantScreen.step1Body')}</span>
                </span>
              </li>
              <li className="tm-ai-step">
                <span className="tm-ai-step__num" aria-hidden="true">
                  2
                </span>
                <span className="tm-ai-step__text">
                  <span className="tm-prefs-card__lead">{t('AiAssistantScreen.step2Lead')}</span>
                  <span className="tm-prefs-card__body">{t('AiAssistantScreen.step2Body')}</span>
                </span>
              </li>
              <li className="tm-ai-step">
                <span className="tm-ai-step__num" aria-hidden="true">
                  3
                </span>
                <span className="tm-ai-step__text">
                  <span className="tm-prefs-card__lead">{t('AiAssistantScreen.step3Lead')}</span>
                  <span className="tm-prefs-card__body">{t('AiAssistantScreen.step3Body')}</span>
                </span>
              </li>
            </ol>
            <p className="tm-prefs-card__note">{t('AiAssistantScreen.noChargeNote')}</p>
          </section>

          <section className="tm-prefs-card" aria-labelledby="tm-ai-connect-heading">
            <h2 id="tm-ai-connect-heading" className="tm-prefs-card__title">
              {t('AiAssistantScreen.connectionDetails')}
            </h2>

            <div className="tm-ai-detail">
              <span className="tm-prefs-field__label" id="tm-ai-address-label">
                {t('AiAssistantScreen.addressLabel')}
              </span>
              <span className="tm-ai-detail__row">
                <code className="tm-prefs-secret" aria-labelledby="tm-ai-address-label">
                  {address}
                </code>
                <CopyButton text={address} label={t('AiAssistantScreen.copyAddress')} />
              </span>
            </div>

            <div
              className="tm-ai-tabs"
              role="tablist"
              aria-label={t('AiAssistantScreen.chooseAssistant')}
            >
              {ASSISTANTS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="tab"
                  id={`tm-ai-tab-${option.id}`}
                  aria-selected={assistant === option.id}
                  aria-controls="tm-ai-panel"
                  className="tm-ai-tab"
                  onClick={() => setAssistant(option.id)}
                >
                  {option.labelKey === undefined ? option.label : t(option.labelKey)}
                </button>
              ))}
            </div>

            <AssistantPanel
              assistant={assistant}
              address={address}
              token={null}
              workspaceName={workspaceName}
            />

            <p className="tm-prefs-card__note">
              <Link href={`/${organizationSlug}/help/connect-ai`}>
                {t('AiAssistantScreen.helpLink')}
              </Link>
            </p>
          </section>
        </div>

        <div className="tm-prefs__side">
          <section
            className="tm-prefs-card tm-prefs-card--tight"
            aria-labelledby="tm-ai-status-heading"
          >
            <h2 id="tm-ai-status-heading" className="tm-prefs-eyebrow">
              {t('AiAssistantScreen.statusHeading')}
            </h2>
            {tokens.isPending ? (
              <LoadingRegion label={t('AiAssistantScreen.loadingStatus')}>
                <Skeleton />
              </LoadingRegion>
            ) : tokens.isError ? (
              <InlineAlert tone="danger" title={t('AiAssistantScreen.loadKeysError')}>
                {errorMessage(tokens.error)}
              </InlineAlert>
            ) : (
              <p className="tm-ai-status" data-testid="tm-ai-status">
                <span className={`tm-prefs-dot ${STATUS_DOT[status.kind]}`} aria-hidden="true" />
                <span className="tm-ai-status__text">
                  <span className="tm-prefs-card__lead">{statusLabel[status.kind]}</span>
                  <span className="tm-prefs-card__body">{statusDetail(status)}</span>
                </span>
              </p>
            )}
          </section>

          <section className="tm-prefs-card" aria-labelledby="tm-ai-create-heading">
            <h2 id="tm-ai-create-heading" className="tm-prefs-card__title">
              {t('AiAssistantScreen.createKeyHeading')}
            </h2>
            <p className="tm-prefs-card__body">{t('AccessTokens.aiCreateBody')}</p>
            <div>
              <Link
                className="tm-prefs-capsule tm-prefs-capsule--ink"
                href={`/${organizationSlug}/settings/security`}
              >
                {t('AccessTokens.aiCreateLink')}
              </Link>
            </div>
          </section>

          <section className="tm-prefs-card" aria-labelledby="tm-ai-keys-heading">
            <h2 id="tm-ai-keys-heading" className="tm-prefs-card__title">
              {t('AiAssistantScreen.yourKeys')}
            </h2>
            {tokens.isSuccess && active.length === 0 ? (
              <p className="tm-prefs-card__body">{t('AiAssistantScreen.noActiveKeys')}</p>
            ) : null}
            {active.length > 0 ? (
              <ul className="tm-prefs-tokens">
                {active.map((token) => (
                  <li key={token.id} className="tm-prefs-token">
                    <span className="tm-prefs-token__text">
                      <span className="tm-prefs-token__name">{token.name}</span>
                      <span className="tm-prefs-token__meta">
                        {token.lastUsedAt
                          ? `${t('AiAssistantScreen.lastUsedPrefix')} ${formatDate(token.lastUsedAt)}`
                          : t('AiAssistantScreen.notUsedYet')}
                        {token.expiresAt
                          ? ` ${t('AiAssistantScreen.expiresConnector')} ${formatDate(token.expiresAt)}`
                          : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="tm-prefs-card__note">
              {t('AiAssistantScreen.revokeNotePrefix')}{' '}
              <Link href={`/${organizationSlug}/settings/security`}>
                {t('AiAssistantScreen.accessTokensLink')}
              </Link>
              .
            </p>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

// ── Assistants ────────────────────────────────────────────────────────────

type AssistantId = 'claude' | 'claude-code' | 'chatgpt' | 'other';

/** Brand names stay Latin in every locale; only "Other assistants" is translated. */
const ASSISTANTS: readonly { id: AssistantId; label: string; labelKey?: MessageKey }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'other', label: 'Other assistants', labelKey: 'AiAssistantScreen.tabOther' },
];

export const TOKEN_PLACEHOLDER = 'paste-your-key-here';

export { connectorAddress };

function AssistantPanel({
  assistant,
  address,
  token,
  workspaceName,
}: {
  assistant: AssistantId;
  address: string;
  token: string | null;
  workspaceName: string;
}) {
  const t = useT();
  const panel = assistantPanel(t, assistant, address, token, workspaceName);
  return (
    <div
      id="tm-ai-panel"
      role="tabpanel"
      aria-labelledby={`tm-ai-tab-${assistant}`}
      className="tm-ai-panel"
    >
      <ol className="tm-ai-howto">
        {panel.steps.map((step) => (
          <li key={step} className="tm-prefs-card__body">
            {step}
          </li>
        ))}
      </ol>
      {panel.snippet === null ? null : (
        <>
          <pre className="tm-ai-snippet" data-testid="tm-ai-snippet">
            <code>{panel.snippet}</code>
          </pre>
          <CopyButton text={panel.snippet} label={t('AiAssistantScreen.copySettings')} />
        </>
      )}
    </div>
  );
}

/**
 * The steps and snippet for one assistant (AUT-05, AUT-06). Claude and ChatGPT add TManage as a
 * custom connector and sign in with OAuth, so they need no key and no snippet. Claude Code signs
 * in with OAuth through `/mcp`, or takes the member's key as a header once one is created. Any
 * other MCP client gets the address and the key header.
 */
export function assistantPanel(
  t: (key: MessageKey) => string,
  assistant: AssistantId,
  address: string,
  token: string | null,
  workspaceName: string,
): { steps: readonly string[]; snippet: string | null } {
  const header = `Authorization: Bearer ${token ?? TOKEN_PLACEHOLDER}`;
  switch (assistant) {
    case 'claude':
      return {
        steps: [
          t('ConnectAiHelp.claudeStep1'),
          t('ConnectAiHelp.claudeStep2'),
          t('ConnectAiHelp.claudeStep3'),
        ],
        snippet: null,
      };
    case 'claude-code':
      return token === null
        ? {
            steps: [t('ConnectAiHelp.claudeCodeStep1')],
            snippet: `claude mcp add --transport http tmanage ${address}`,
          }
        : {
            steps: [t('AiAssistantScreen.ccStep1')],
            snippet: [
              `claude mcp add --transport http tmanage ${address} \\`,
              `  --header "${header}"`,
            ].join('\n'),
          };
    case 'chatgpt':
      return {
        steps: [
          t('ConnectAiHelp.chatgptStep1'),
          t('ConnectAiHelp.chatgptStep2'),
          `${t('ConnectAiHelp.chatgptStep3Prefix')} ${workspaceName}.`,
        ],
        snippet: null,
      };
    case 'other':
      return {
        steps: [t('AiAssistantScreen.otherStep1')],
        snippet: [`URL: ${address}`, header].join('\n'),
      };
  }
}

// ── Status ────────────────────────────────────────────────────────────────

type ConnectionStatus =
  | { kind: 'connected'; lastUsedAt: string; tokenName: string }
  | { kind: 'waiting' }
  | { kind: 'off' };

const STATUS_DOT: Record<ConnectionStatus['kind'], string> = {
  connected: 'tm-prefs-dot--lime',
  waiting: 'tm-prefs-dot--warn',
  off: 'tm-prefs-dot--empty',
};

export function isActive(token: PersonalAccessTokenView, now: Date): boolean {
  if (token.revokedAt !== null) return false;
  if (token.expiresAt === null) return true;
  return new Date(token.expiresAt).getTime() > now.getTime();
}

export function connectionStatus(active: readonly PersonalAccessTokenView[]): ConnectionStatus {
  let latest: PersonalAccessTokenView | null = null;
  for (const token of active) {
    if (token.lastUsedAt === null) continue;
    if (latest === null || token.lastUsedAt > (latest.lastUsedAt ?? '')) latest = token;
  }
  if (latest?.lastUsedAt) {
    return { kind: 'connected', lastUsedAt: latest.lastUsedAt, tokenName: latest.name };
  }
  return active.length > 0 ? { kind: 'waiting' } : { kind: 'off' };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="tm-prefs-capsule"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? t('AiAssistantScreen.copied') : label}
    </button>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(appLocale());
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(appLocale(), { dateStyle: 'medium', timeStyle: 'short' });
}
