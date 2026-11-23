'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, StateCapsule, StatusDot } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { connectorAddress, cursorEntry, deploymentAddress } from '../../lib/ai-connector-address';
import { listPersonalAccessTokens } from '../../lib/api/personal-access-tokens';
import type { PersonalAccessTokenView } from '../../lib/api/personal-access-tokens';
import { getConnectedApps } from '../../lib/api/connected-apps';
import type { ConnectedApp } from '../../lib/api/connected-apps';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useHydrated } from '../../lib/use-hydrated';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { appIntlLocale } from '../../lib/i18n/app-locale';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import {
  pendingTitle,
  reviewHref,
  singleClient,
  usePendingAiApprovals,
} from '../ai-actions/pending-ai-actions';
import '../../styles/screens/preferences.css';
import '../../styles/screens/ai-assistant.css';

export interface AiAssistantScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** This deployment's API origin. Defaults to the browser's; assistants connect to `<it>/mcp`. */
  serverUrl?: string;
  /** "Now", for the expiry check. Injected by tests. */
  now?: () => Date;
  /** How often to look for the connection while waiting, in ms. Tests pass `false`. */
  pollMs?: number | false;
}

/**
 * **AI assistant — connect in three steps** (55-15p, Figma 715:39480 / 715:39892 waiting,
 * 715:39681 / 715:40093 connected, review DESIGN-REVIEW-FIGMA-A points 7–9 and 16).
 *
 * This page is the "your own AI" direction of plan 62 (the other, TManage AI on credits, lives in
 * Control Center › AI): the assistant a person already uses reaches the workspace through the
 * hosted MCP endpoint, and nothing here depends on TManage AI being available. The page is three
 * cards — pick your assistant, copy one line, check the connection — and, when an assistant has
 * asked for something that changes work, a fourth card says how many actions wait for approval and
 * links to them.
 *
 * The line to copy is always this deployment's own address, `connectorAddress(deploymentAddress())`
 * read after hydration, never a typed host. "Connected" is read from the member's own connected
 * apps (OAuth) and personal access tokens; while nothing has connected yet the page looks again
 * every few seconds, so "Keep this page open" is true.
 */
export function AiAssistantScreen({
  organizationSlug,
  organizationName,
  client,
  serverUrl,
  now = () => new Date(),
  pollMs = 8_000,
}: AiAssistantScreenProps) {
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const api = client ?? browserApiClient();
  const hydrated = useHydrated();
  const origin = serverUrl ?? (hydrated ? deploymentAddress() : '');
  const address = origin === '' ? '' : connectorAddress(origin);

  const [assistant, setAssistant] = useState<AssistantId>('claude');
  const option = ASSISTANTS.find((a) => a.id === assistant) ?? ASSISTANTS[0]!;
  const assistantName =
    option.labelKey === undefined ? option.label : tOr(option.labelKey, option.label);

  const [connected, setConnected] = useState(false);
  const refetchInterval = connected || pollMs === false ? false : pollMs;
  const tokens = useQuery({
    queryKey: ['personal-access-tokens', organizationSlug],
    queryFn: () => listPersonalAccessTokens(api, organizationSlug),
    refetchInterval,
  });
  const apps = useQuery({
    queryKey: ['connected-apps', organizationSlug],
    queryFn: () => getConnectedApps(api, organizationSlug),
    refetchInterval,
    retry: false,
  });
  const pending = usePendingAiApprovals(organizationSlug, api);

  const status = connectionFrom(apps.data?.apps ?? [], tokens.data ?? [], now());
  if ((status !== null) !== connected) setConnected(status !== null);

  const line = assistant === 'cursor' && address !== '' ? cursorEntry(address) : address;
  const waitingItems = pending.data ?? [];

  return (
    <SettingsShell
      section="ai-assistant"
      client={api}
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={t('AiAssistantScreen.eyebrow')}
      title={t('AiAssistantScreen.title')}
      description={tOr(
        'AiAssistantScreen.leadThreeSteps',
        'Connect your assistant in three steps. It can only do what you can do, and anything that changes your work waits for your approval.',
      )}
    >
      <div className="tm-ai-connect">
        <section className="tm-prefs-card tm-ai-card" aria-labelledby="tm-ai-step1">
          <StepTitle id="tm-ai-step1" number={1}>
            {tOr('AiAssistantScreen.stepPick', 'Pick your assistant')}
          </StepTitle>
          <div
            className="tm-ai-chips"
            role="group"
            aria-label={t('AiAssistantScreen.chooseAssistant')}
          >
            {ASSISTANTS.map((a) => {
              const selected = a.id === assistant;
              return (
                <button
                  key={a.id}
                  type="button"
                  className="tm-chip tm-chip--compact tm-ai-chip"
                  aria-pressed={selected}
                  onClick={() => setAssistant(a.id)}
                >
                  {selected ? (
                    <span className="tm-ai-chip__check" aria-hidden="true">
                      ✓
                    </span>
                  ) : null}
                  {a.labelKey === undefined ? a.label : tOr(a.labelKey, a.label)}
                </button>
              );
            })}
          </div>
        </section>

        <section className="tm-prefs-card tm-ai-card" aria-labelledby="tm-ai-step2">
          <StepTitle id="tm-ai-step2" number={2}>
            {tOr('AiAssistantScreen.stepCopy', 'Copy one line')}
          </StepTitle>
          <p className="tm-prefs-card__body" data-testid="tm-ai-path">
            {tOr(option.pathKey, option.pathEnglish)}
          </p>
          <div className="tm-ai-line">
            <code className="tm-ai-line__text" dir="ltr" data-testid="tm-ai-line">
              {line}
            </code>
            <CopyButton text={line} label={t('ConnectAiHelp.copy')} />
          </div>
          {assistant === 'other' ? (
            <p className="tm-prefs-card__note">
              <Link href={`/${organizationSlug}/help/connect-ai`}>
                {t('AiAssistantScreen.helpLink')}
              </Link>
            </p>
          ) : null}
        </section>

        <section
          className="tm-prefs-card tm-ai-card"
          aria-labelledby="tm-ai-step3"
          aria-live="polite"
        >
          <StepTitle id="tm-ai-step3" number={3}>
            {tOr('AiAssistantScreen.stepCheck', 'Check the connection')}
          </StepTitle>
          {status !== null ? (
            <div className="tm-ai-status" data-testid="tm-ai-status">
              <StateCapsule state="done">{t('AiAssistantScreen.statusConnected')}</StateCapsule>
              <p className="tm-prefs-card__body">
                {tOr(
                  'AiAssistantScreen.connectedLine',
                  '{client} connected on {when}. It signs in as you.',
                )
                  .replace('{client}', status.client)
                  .replace('{when}', formatWhen(status.at))}
              </p>
            </div>
          ) : tokens.isError && apps.isError ? (
            <InlineAlert tone="danger" title={t('AiAssistantScreen.loadKeysError')}>
              {errorMessage(tokens.error)}
            </InlineAlert>
          ) : (
            <p className="tm-ai-status" data-testid="tm-ai-status">
              <StatusDot tone="live">
                {tOr(
                  'AiAssistantScreen.waitingLine',
                  'Waiting for {assistant} to connect. Keep this page open.',
                ).replace('{assistant}', assistantName)}
              </StatusDot>
            </p>
          )}
        </section>

        {waitingItems.length > 0 ? (
          <section
            className="tm-prefs-card tm-ai-card"
            aria-labelledby="tm-ai-pending"
            data-testid="tm-ai-pending"
          >
            <h2 id="tm-ai-pending" className="tm-ai-card__title">
              {pendingTitle(tOr, waitingItems.length, singleClient(waitingItems))}
            </h2>
            <p className="tm-prefs-card__body">
              {tOr(
                'AiAssistantScreen.pendingBody',
                'Nothing that changes your work runs until you approve it.',
              )}
            </p>
            <div>
              <Link
                className="tm-button tm-button--ink tm-button--accessible"
                href={reviewHref(organizationSlug, waitingItems)}
              >
                {tOr('AiAssistantScreen.review', 'Review')}
              </Link>
            </div>
          </section>
        ) : null}

        <p className="tm-prefs-card__note tm-ai-more">
          <Link href={locale.startsWith('ar') ? '/ar/help/ai-recipes' : '/help/ai-recipes'}>
            {tOr('AiAssistantScreen.recipesLink', 'Ready-made requests to try')}
          </Link>
          <span aria-hidden="true"> · </span>
          <Link href={`/${organizationSlug}/settings/security`}>
            {t('AiAssistantScreen.accessTokensLink')}
          </Link>
        </p>
      </div>
    </SettingsShell>
  );
}

function StepTitle({ id, number, children }: { id: string; number: number; children: string }) {
  return (
    <h2 id={id} className="tm-ai-card__title tm-ai-card__title--step">
      <span className="tm-ai-step-num" aria-hidden="true">
        {number}
      </span>
      {children}
    </h2>
  );
}

// ── Assistants ────────────────────────────────────────────────────────────

type AssistantId = 'claude' | 'chatgpt' | 'cursor' | 'other';

interface AssistantOption {
  readonly id: AssistantId;
  /** Brand names stay Latin in every locale; only "Another assistant" is translated. */
  readonly label: string;
  readonly labelKey?: string;
  /** Where the line goes, for step 2. */
  readonly pathKey: string;
  readonly pathEnglish: string;
}

const ASSISTANTS: readonly AssistantOption[] = [
  {
    id: 'claude',
    label: 'Claude',
    pathKey: 'AiAssistantScreen.pathClaude',
    pathEnglish: 'Paste it into Claude → Settings → Connectors → Add custom connector.',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    pathKey: 'AiAssistantScreen.pathChatgpt',
    pathEnglish: 'Paste it into ChatGPT → Settings → Connectors → Add custom MCP server.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    pathKey: 'AiAssistantScreen.pathCursor',
    pathEnglish: "Paste it into Cursor's mcp.json, inside mcpServers.",
  },
  {
    id: 'other',
    label: 'Another assistant',
    labelKey: 'AiAssistantScreen.chipOther',
    pathKey: 'AiAssistantScreen.pathOther',
    pathEnglish: 'Add it to your assistant as an HTTP MCP server, then sign in.',
  },
];

export { connectorAddress };

// ── Connection ────────────────────────────────────────────────────────────

export interface Connection {
  /** The assistant (OAuth app) or key name that signed in. */
  readonly client: string;
  /** When it was last seen: its last use, else when it connected. */
  readonly at: string;
}

export function isActive(token: PersonalAccessTokenView, now: Date): boolean {
  if (token.revokedAt !== null) return false;
  if (token.expiresAt === null) return true;
  return new Date(token.expiresAt).getTime() > now.getTime();
}

/**
 * Has an assistant connected as this member? The member's own connected apps (OAuth: Claude,
 * ChatGPT, Cursor) count from the moment they connect; an active personal access token counts
 * once it has been used. The most recent one names the assistant. Null: nothing yet.
 */
export function connectionFrom(
  apps: readonly ConnectedApp[],
  tokens: readonly PersonalAccessTokenView[],
  now: Date,
): Connection | null {
  let latest: Connection | null = null;
  const consider = (candidate: Connection) => {
    if (latest === null || candidate.at > latest.at) latest = candidate;
  };
  for (const app of apps) {
    if (!app.mine) continue;
    consider({ client: app.clientName, at: app.lastUsedAt ?? app.connectedAt });
  }
  for (const token of tokens) {
    if (token.lastUsedAt === null || !isActive(token, now)) continue;
    consider({ client: token.name, at: token.lastUsedAt });
  }
  return latest;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="tm-button tm-button--outline tm-button--default"
      disabled={text === ''}
      aria-live="polite"
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

/** "18 Nov at 10:42" in the interface language. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(appIntlLocale(), {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}
