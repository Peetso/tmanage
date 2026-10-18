'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { PreferencesNav } from './PreferencesScreen';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import {
  createPersonalAccessToken,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
} from '../../lib/api/personal-access-tokens';
import type {
  CreatedPersonalAccessTokenView,
  PersonalAccessTokenView,
} from '../../lib/api/personal-access-tokens';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useHydrated } from '../../lib/use-hydrated';
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
}

/**
 * **AI assistant — connect your own Claude, ChatGPT or any MCP assistant.**
 *
 * TManage runs no paid AI model of its own. Instead, the TManage MCP server (`apps/mcp-server`)
 * lets the assistant a person already uses work in TManage over the ordinary HTTP API, signed in
 * with a personal access token. This screen is the front door to that: what it does in plain
 * words, the connection details for this deployment, the token itself (created here, shown once,
 * revocable here), and whether an assistant has used it.
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
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const queryKey = ['personal-access-tokens', organizationSlug] as const;
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

  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedPersonalAccessTokenView | null>(null);
  const [assistant, setAssistant] = useState<AssistantId>('claude-desktop');

  const create = useMutation({
    mutationFn: (): Promise<CreatedPersonalAccessTokenView> =>
      createPersonalAccessToken(api, organizationSlug, { name: name.trim(), expiresInDays: null }),
    onSuccess: (result) => {
      setCreated(result);
      setName('');
      void queries.invalidateQueries({ queryKey });
    },
  });

  const revoke = useMutation({
    mutationFn: (tokenId: string) => revokePersonalAccessToken(api, organizationSlug, tokenId),
    onSuccess: (_, tokenId) => {
      if (created?.id === tokenId) setCreated(null);
      void queries.invalidateQueries({ queryKey });
    },
  });

  const active = (tokens.data ?? []).filter((token) => isActive(token, now()));
  const status = connectionStatus(active);
  const tokenForSnippet = created?.token ?? TOKEN_PLACEHOLDER;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow="Settings · AI assistant"
      title="AI assistant"
      description="Use the AI assistant you already have (Claude, ChatGPT or another) inside TManage. It can search, read your work, create tasks and comment, always with your permissions and nothing more."
      contextRail={<PreferencesNav organizationSlug={organizationSlug} current="ai-assistant" />}
    >
      <div className="tm-prefs tm-ai">
        <div className="tm-prefs__main">
          <section className="tm-prefs-card" aria-labelledby="tm-ai-how-heading">
            <h2 id="tm-ai-how-heading" className="tm-prefs-eyebrow">
              How it works
            </h2>
            <ol className="tm-ai-steps">
              <li className="tm-ai-step">
                <span className="tm-ai-step__num" aria-hidden="true">
                  1
                </span>
                <span className="tm-ai-step__text">
                  <span className="tm-prefs-card__lead">Create a key</span>
                  <span className="tm-prefs-card__body">
                    A key lets your assistant sign in to TManage as you. It can only do what you can
                    do, and you can switch it off at any time.
                  </span>
                </span>
              </li>
              <li className="tm-ai-step">
                <span className="tm-ai-step__num" aria-hidden="true">
                  2
                </span>
                <span className="tm-ai-step__text">
                  <span className="tm-prefs-card__lead">Add TManage to your assistant</span>
                  <span className="tm-prefs-card__body">
                    Copy the settings below into Claude, ChatGPT or any assistant that supports MCP
                    connectors.
                  </span>
                </span>
              </li>
              <li className="tm-ai-step">
                <span className="tm-ai-step__num" aria-hidden="true">
                  3
                </span>
                <span className="tm-ai-step__text">
                  <span className="tm-prefs-card__lead">Ask it about your work</span>
                  <span className="tm-prefs-card__body">
                    For example: “What is overdue for me this week?” or “Create a task to review the
                    homepage copy.”
                  </span>
                </span>
              </li>
            </ol>
            <p className="tm-prefs-card__note">
              TManage does not charge for AI and does not send your work to an AI company. Your own
              assistant does the thinking, under your own account with that company.
            </p>
          </section>

          <section className="tm-prefs-card" aria-labelledby="tm-ai-connect-heading">
            <h2 id="tm-ai-connect-heading" className="tm-prefs-card__title">
              Connection details
            </h2>

            <div className="tm-ai-detail">
              <span className="tm-prefs-field__label" id="tm-ai-address-label">
                TManage address
              </span>
              <span className="tm-ai-detail__row">
                <code className="tm-prefs-secret" aria-labelledby="tm-ai-address-label">
                  {address}
                </code>
                <CopyButton text={address} label="Copy address" />
              </span>
            </div>

            <div className="tm-ai-tabs" role="tablist" aria-label="Choose your assistant">
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
                  {option.label}
                </button>
              ))}
            </div>

            <AssistantPanel assistant={assistant} address={address} token={tokenForSnippet} />

            {created === null ? (
              <p className="tm-prefs-card__note">
                When you create a key, it is filled in here for you.
              </p>
            ) : null}
          </section>
        </div>

        <div className="tm-prefs__side">
          <section
            className="tm-prefs-card tm-prefs-card--tight"
            aria-labelledby="tm-ai-status-heading"
          >
            <h2 id="tm-ai-status-heading" className="tm-prefs-eyebrow">
              Status
            </h2>
            {tokens.isPending ? (
              <LoadingRegion label="Loading the connection status">
                <Skeleton />
              </LoadingRegion>
            ) : tokens.isError ? (
              <InlineAlert tone="danger" title="We could not load your keys">
                {errorMessage(tokens.error)}
              </InlineAlert>
            ) : (
              <p className="tm-ai-status" data-testid="tm-ai-status">
                <span className={`tm-prefs-dot ${STATUS_DOT[status.kind]}`} aria-hidden="true" />
                <span className="tm-ai-status__text">
                  <span className="tm-prefs-card__lead">{STATUS_LABEL[status.kind]}</span>
                  <span className="tm-prefs-card__body">{statusDetail(status)}</span>
                </span>
              </p>
            )}
          </section>

          <form
            className="tm-prefs-card"
            aria-labelledby="tm-ai-create-heading"
            onSubmit={(event) => {
              event.preventDefault();
              setCreated(null);
              create.mutate();
            }}
          >
            <h2 id="tm-ai-create-heading" className="tm-prefs-card__title">
              Create a key
            </h2>
            <div className="tm-prefs-field">
              <label className="tm-prefs-field__label" htmlFor="tm-ai-key-name">
                Name
              </label>
              <input
                id="tm-ai-key-name"
                className="tm-prefs-field__control"
                type="text"
                value={name}
                maxLength={190}
                placeholder="e.g. Claude on my laptop"
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>

            {create.isError ? (
              <InlineAlert tone="danger" title="We could not create the key">
                {errorMessage(create.error)}
              </InlineAlert>
            ) : null}

            {created ? (
              <InlineAlert tone="success" title="Key created. Copy it now">
                <p>
                  This is the only time the key is shown. It is already filled in the connection
                  settings. If you lose it, switch it off and create a new one.
                </p>
                <code className="tm-prefs-secret" data-testid="tm-ai-secret">
                  {created.token}
                </code>
                <CopyButton text={created.token} label="Copy key" />
              </InlineAlert>
            ) : null}

            <div>
              <button
                type="submit"
                className="tm-prefs-capsule tm-prefs-capsule--ink"
                disabled={create.isPending || name.trim() === ''}
              >
                {create.isPending ? 'Creating…' : 'Create key'}
              </button>
            </div>
          </form>

          <section className="tm-prefs-card" aria-labelledby="tm-ai-keys-heading">
            <h2 id="tm-ai-keys-heading" className="tm-prefs-card__title">
              Your keys
            </h2>
            {tokens.isSuccess && active.length === 0 ? (
              <p className="tm-prefs-card__body">You have no active keys.</p>
            ) : null}
            {active.length > 0 ? (
              <ul className="tm-prefs-tokens">
                {active.map((token) => (
                  <li key={token.id} className="tm-prefs-token">
                    <span className="tm-prefs-token__text">
                      <span className="tm-prefs-token__name">{token.name}</span>
                      <span className="tm-prefs-token__meta">
                        {token.lastUsedAt
                          ? `Last used ${formatDate(token.lastUsedAt)}`
                          : 'Not used yet'}
                        {token.expiresAt ? ` · expires ${formatDate(token.expiresAt)}` : ''}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="tm-prefs-capsule"
                      aria-label={`Revoke ${token.name}`}
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(token.id)}
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {revoke.isError ? (
              <InlineAlert tone="danger" title="We could not revoke that key">
                {errorMessage(revoke.error)}
              </InlineAlert>
            ) : null}
            <p className="tm-prefs-card__note">
              Revoking a key disconnects the assistant using it straight away. All your keys,
              including revoked ones, are listed under{' '}
              <Link href={`/${organizationSlug}/settings/security`}>Access tokens</Link>.
            </p>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

// ── Assistants ────────────────────────────────────────────────────────────

type AssistantId = 'claude-desktop' | 'claude-code' | 'chatgpt' | 'other';

const ASSISTANTS: readonly { id: AssistantId; label: string }[] = [
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'other', label: 'Other assistants' },
];

export const TOKEN_PLACEHOLDER = 'paste-your-key-here';

/** The hosted MCP endpoint of a TManage deployment: `<origin>/mcp`. */
export function connectorAddress(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/mcp`;
}

function AssistantPanel({
  assistant,
  address,
  token,
}: {
  assistant: AssistantId;
  address: string;
  token: string;
}) {
  const panel = assistantPanel(assistant, address, token);
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
          <CopyButton text={panel.snippet} label="Copy settings" />
        </>
      )}
    </div>
  );
}

function assistantPanel(
  assistant: AssistantId,
  address: string,
  token: string,
): { steps: readonly string[]; snippet: string | null } {
  const header = `Authorization: Bearer ${token}`;
  switch (assistant) {
    case 'claude-desktop':
      return {
        steps: [
          'In Claude Desktop open Settings, then Developer, then Edit Config.',
          'Paste the settings below, save, and restart Claude Desktop. They connect Claude to your TManage address with your key.',
          'The TManage tools appear under the tools icon in a new chat.',
        ],
        snippet: JSON.stringify(
          {
            mcpServers: {
              tmanage: {
                command: 'npx',
                args: ['-y', 'mcp-remote', address, '--header', `Authorization:Bearer ${token}`],
              },
            },
          },
          null,
          2,
        ),
      };
    case 'claude-code':
      return {
        steps: ['Run this once in a terminal. Claude Code then has the TManage tools.'],
        snippet: [
          `claude mcp add --transport http tmanage ${address} \\`,
          `  --header "${header}"`,
        ].join('\n'),
      };
    case 'chatgpt':
      return {
        steps: [
          `ChatGPT connects to your TManage address: ${address}`,
          'In ChatGPT open Settings, then Connectors, turn on developer mode and add a connector with that address.',
          'When ChatGPT asks how to sign in, give it your key as a bearer token.',
        ],
        snippet: null,
      };
    case 'other':
      return {
        steps: [
          'Any assistant that supports MCP over Streamable HTTP can connect. Give it this address and this header:',
        ],
        snippet: [`URL: ${address}`, header].join('\n'),
      };
  }
}

// ── Status ────────────────────────────────────────────────────────────────

type ConnectionStatus =
  | { kind: 'connected'; lastUsedAt: string; tokenName: string }
  | { kind: 'waiting' }
  | { kind: 'off' };

const STATUS_LABEL: Record<ConnectionStatus['kind'], string> = {
  connected: 'Connected',
  waiting: 'Waiting for your assistant',
  off: 'Not connected',
};

const STATUS_DOT: Record<ConnectionStatus['kind'], string> = {
  connected: 'tm-prefs-dot--lime',
  waiting: 'tm-prefs-dot--warn',
  off: 'tm-prefs-dot--empty',
};

function statusDetail(status: ConnectionStatus): string {
  switch (status.kind) {
    case 'connected':
      return `Last used ${formatDateTime(status.lastUsedAt)} with “${status.tokenName}”.`;
    case 'waiting':
      return 'You have a key, but no assistant has used it yet.';
    case 'off':
      return 'Create a key to connect an assistant.';
  }
}

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

/** The API origin assistants call. Same-origin deployments serve the API from the web origin. */
function deploymentAddress(): string {
  let base = '';
  try {
    base = apiBaseUrl();
  } catch {
    base = '';
  }
  if (base !== '') return base;
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function CopyButton({ text, label }: { text: string; label: string }) {
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
      {copied ? 'Copied' : label}
    </button>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
