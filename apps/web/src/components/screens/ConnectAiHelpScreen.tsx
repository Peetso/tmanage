'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useHydrated } from '../../lib/use-hydrated';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useOrganizationName } from '../../lib/use-organization-names';
import {
  connectorAddress,
  deploymentAddress,
  openApiAddress,
} from '../../lib/ai-connector-address';
import '../../styles/screens/connect-ai-help.css';

export interface ConnectAiHelpScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** This deployment's API origin. Defaults to the browser's; assistants connect to `<it>/mcp`. */
  serverUrl?: string;
  /** The signed-in account shown at the end of the top bar, when the caller knows it. */
  accountLabel?: string;
}

/** The Claude Code command (plan section 5). OAuth: run it, then `/mcp` signs in. */
export function claudeCodeCommand(address: string): string {
  return `claude mcp add --transport http tmanage ${address}`;
}

/** The entry for `mcpServers` in Cursor's or VS Code's `mcp.json`. No headers: OAuth signs in. */
export function cursorEntry(address: string): string {
  return `"tmanage": { "url": "${address}" }`;
}

/**
 * **Connect an AI to TManage** — the S0-4 help page (Figma 360:1214 EN, 360:1333 AR).
 *
 * One copyable workspace address, the steps for each AI app (Claude, Claude Code, ChatGPT,
 * Cursor / VS Code, any other MCP client), and the OpenAPI fallback for apps without MCP. Every
 * address is this deployment's own, read after hydration, so what a person copies is what works.
 * Arabic is the same page through the catalog; the layout mirrors through the document's `dir`.
 */
export function ConnectAiHelpScreen({
  organizationSlug,
  organizationName,
  serverUrl,
  accountLabel,
}: ConnectAiHelpScreenProps) {
  const t = useT();
  const hydrated = useHydrated();
  const workspaceName = useOrganizationName(organizationSlug, organizationName);
  const origin = serverUrl ?? (hydrated ? deploymentAddress() : '');
  const address = origin === '' ? '' : connectorAddress(origin);
  const openApi = origin === '' ? '' : openApiAddress(origin);

  return (
    <div className="tm-aihelp">
      <header className="tm-aihelp-bar">
        <span className="tm-aihelp-bar__trail">
          <Link
            href={`/${organizationSlug}/home`}
            className="tm-aihelp-bar__orb"
            aria-label={t('shell.brand.home')}
          >
            <span className="tm-aihelp-bar__dot" aria-hidden="true" />
          </Link>
          <span className="tm-aihelp-mono">{t('ConnectAiHelp.breadcrumb')}</span>
        </span>
        <span className="tm-aihelp-mono" data-testid="tm-aihelp-account">
          {accountLabel ?? workspaceName}
        </span>
      </header>

      <main className="tm-aihelp-main">
        <div className="tm-aihelp-intro">
          <p className="tm-aihelp-mono">{t('ConnectAiHelp.eyebrow')}</p>
          <h1 className="tm-aihelp-title">{t('ConnectAiHelp.title')}</h1>
          <p className="tm-aihelp-lede">{t('ConnectAiHelp.description')}</p>
        </div>

        <section className="tm-aihelp-address" aria-labelledby="tm-aihelp-address-label">
          <div className="tm-aihelp-address__text">
            <h2 id="tm-aihelp-address-label" className="tm-aihelp-mono">
              {t('ConnectAiHelp.addressLabel')}
            </h2>
            <code className="tm-aihelp-address__value" data-testid="tm-aihelp-address" dir="ltr">
              {address}
            </code>
          </div>
          <CopyButton text={address} variant="lime" testId="tm-aihelp-copy-address" />
        </section>

        <h2 className="tm-aihelp-mono">{t('ConnectAiHelp.setUpHeading')}</h2>

        <div className="tm-aihelp-grid">
          <div className="tm-aihelp-col">
            <ClientCard
              glyph="C"
              name="Claude"
              subtitle={t('ConnectAiHelp.claudeSubtitle')}
              steps={[
                t('ConnectAiHelp.claudeStep1'),
                t('ConnectAiHelp.claudeStep2'),
                t('ConnectAiHelp.claudeStep3'),
              ]}
            />
            <ClientCard
              glyph="G"
              name="ChatGPT"
              subtitle={t('ConnectAiHelp.chatgptSubtitle')}
              steps={[
                t('ConnectAiHelp.chatgptStep1'),
                t('ConnectAiHelp.chatgptStep2'),
                `${t('ConnectAiHelp.chatgptStep3Prefix')} ${workspaceName}.`,
              ]}
            />
            <ClientCard
              glyph="•"
              name={t('ConnectAiHelp.otherTitle')}
              subtitle={t('ConnectAiHelp.otherSubtitle')}
              steps={[t('ConnectAiHelp.otherStep1'), t('ConnectAiHelp.otherStep2')]}
            />
          </div>
          <div className="tm-aihelp-col">
            <ClientCard
              glyph=">"
              name="Claude Code"
              subtitle={t('ConnectAiHelp.claudeCodeSubtitle')}
              steps={[t('ConnectAiHelp.claudeCodeStep1')]}
              snippet={address === '' ? '' : claudeCodeCommand(address)}
              snippetTestId="tm-aihelp-claude-code"
            />
            <ClientCard
              glyph="{}"
              name="Cursor / VS Code"
              subtitle={t('ConnectAiHelp.cursorSubtitle')}
              steps={[t('ConnectAiHelp.cursorStep1')]}
              snippet={address === '' ? '' : cursorEntry(address)}
              snippetTestId="tm-aihelp-cursor"
            />
          </div>
        </div>

        <section className="tm-aihelp-api" aria-labelledby="tm-aihelp-api-title">
          <p className="tm-aihelp-mono tm-aihelp-api__eyebrow">{t('ConnectAiHelp.apiEyebrow')}</p>
          <h2 id="tm-aihelp-api-title" className="tm-aihelp-api__title">
            {t('ConnectAiHelp.apiTitle')}
          </h2>
          <p className="tm-aihelp-api__body">{t('ConnectAiHelp.apiBody')}</p>
          <div className="tm-aihelp-api__row">
            <div className="tm-aihelp-code tm-aihelp-code--dark">
              <code className="tm-aihelp-code__text" data-testid="tm-aihelp-openapi" dir="ltr">
                {openApi}
              </code>
              <CopyButton text={openApi} variant="quiet" testId="tm-aihelp-copy-openapi" />
            </div>
            <a
              className="tm-aihelp-capsule"
              href={openApi === '' ? undefined : openApi}
              download="tmanage-ai.json"
              data-testid="tm-aihelp-download"
            >
              {t('ConnectAiHelp.downloadOpenApi')}
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}

function ClientCard({
  glyph,
  name,
  subtitle,
  steps,
  snippet,
  snippetTestId,
}: {
  glyph: string;
  name: string;
  subtitle: string;
  steps: readonly string[];
  snippet?: string;
  snippetTestId?: string;
}) {
  return (
    <section className="tm-aihelp-card" aria-label={name}>
      <div className="tm-aihelp-card__head">
        <span className="tm-aihelp-card__glyph" aria-hidden="true">
          {glyph}
        </span>
        <span className="tm-aihelp-card__names">
          <h3 className="tm-aihelp-card__name">{name}</h3>
          <span className="tm-aihelp-card__subtitle">{subtitle}</span>
        </span>
      </div>
      <ol className="tm-aihelp-steps">
        {steps.map((step, index) => (
          <li key={step} className="tm-aihelp-step">
            <span className="tm-aihelp-step__num" aria-hidden="true">
              {index + 1}
            </span>
            <span className="tm-aihelp-step__text">{step}</span>
          </li>
        ))}
      </ol>
      {snippet === undefined ? null : (
        <div className="tm-aihelp-code">
          <code className="tm-aihelp-code__text" data-testid={snippetTestId} dir="ltr">
            {snippet}
          </code>
          <CopyButton text={snippet} variant="quiet" testId={`${snippetTestId ?? 'tm'}-copy`} />
        </div>
      )}
    </section>
  );
}

function CopyButton({
  text,
  variant,
  testId,
}: {
  text: string;
  variant: 'lime' | 'quiet';
  testId: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const label: MessageKey = copied ? 'ConnectAiHelp.copied' : 'ConnectAiHelp.copy';
  return (
    <button
      type="button"
      className={variant === 'lime' ? 'tm-aihelp-capsule' : 'tm-aihelp-copy'}
      data-testid={testId}
      disabled={text === ''}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {t(label)}
    </button>
  );
}
