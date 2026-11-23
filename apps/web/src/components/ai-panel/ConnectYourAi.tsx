'use client';

import { useState } from 'react';
import Link from 'next/link';
import { InfoButton, StateCapsule } from '@tmanage/ui';
import { cursorEntry } from '../../lib/ai-connector-address';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { ConnectorAddress } from './AiPopovers';
import { useAiPanelT } from './use-ai-panel-t';

type AssistantId = 'claude' | 'chatgpt' | 'cursor' | 'other';

/**
 * The same assistants and paste paths as Settings › AI assistant (`AiAssistantScreen`, Figma
 * 715:39480); their words are that screen's shipped catalog keys, so the two never drift.
 */
const ASSISTANTS: readonly {
  readonly id: AssistantId;
  readonly label: string;
  readonly labelKey?: string;
  readonly pathKey: string;
  readonly pathEnglish: string;
}[] = [
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

function StepTitle({ number, children }: { readonly number: number; readonly children: string }) {
  return (
    <h4 className="tm-aip-step__title">
      <span className="tm-aip-step__num" aria-hidden="true">
        {number}
      </span>
      {children}
    </h4>
  );
}

/**
 * "Connect your AI" when nothing is connected (Figma 857:1285): pick the assistant, copy one line,
 * then wait for it to connect. The panel reads its connections again while it waits, and the tab
 * turns into the connected view on its own.
 */
export function ConnectYourAi({
  organizationSlug,
  address,
}: {
  readonly organizationSlug: string;
  readonly address: string;
}) {
  const t = useAiPanelT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const [assistant, setAssistant] = useState<AssistantId>('claude');
  const option = ASSISTANTS.find((entry) => entry.id === assistant) ?? ASSISTANTS[0]!;
  const name = option.labelKey === undefined ? option.label : tOr(option.labelKey, option.label);
  const line = assistant === 'cursor' && address !== '' ? cursorEntry(address) : address;

  return (
    <section className="tm-aip-section tm-aip-connect" aria-labelledby="tm-aip-connect">
      <div className="tm-aip-section__head">
        <h3 id="tm-aip-connect" className="tm-aip-connect__title">
          {t('AiPanel.connect.title')}
        </h3>
        <InfoButton title={t('AiPanel.connect.title')} label={t('AiPanel.connect.infoLabel')}>
          {tOr(
            'AiAssistantScreen.noChargeNote',
            'Connecting your own AI is free, and TManage sends no data to an AI company.',
          )}
        </InfoButton>
      </div>

      <div className="tm-aip-step">
        <StepTitle number={1}>{tOr('AiAssistantScreen.stepPick', 'Pick your assistant')}</StepTitle>
        <div className="tm-aip-chips" role="group" aria-label={t('AiPanel.connect.pick')}>
          {ASSISTANTS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="tm-aip-chip"
              aria-pressed={entry.id === assistant}
              onClick={() => setAssistant(entry.id)}
            >
              {entry.labelKey === undefined ? entry.label : tOr(entry.labelKey, entry.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="tm-aip-step">
        <StepTitle number={2}>{tOr('AiAssistantScreen.stepCopy', 'Copy one line')}</StepTitle>
        <ConnectorAddress address={line} />
        <p className="tm-aip-muted">{tOr(option.pathKey, option.pathEnglish)}</p>
        <Link
          className="tm-aip-link"
          href={`/${encodeURIComponent(organizationSlug)}/help/connect-ai`}
        >
          {tOr('AiAssistantScreen.helpLink', 'Setup steps for every AI app')}
        </Link>
      </div>

      <div className="tm-aip-step" aria-live="polite">
        <StepTitle number={3}>
          {tOr('AiAssistantScreen.stepCheck', 'Check the connection')}
        </StepTitle>
        <p className="tm-aip-wait">
          <StateCapsule state="waiting" className="tm-aip-capsule">
            {t('AiPanel.connect.waiting')}
          </StateCapsule>
          <span>{t('AiPanel.connect.waitingLine', { assistant: name })}</span>
        </p>
      </div>

      <Link
        className="tm-aip-link"
        href={locale.startsWith('ar') ? '/ar/help/ai-recipes' : '/help/ai-recipes'}
      >
        {tOr('AiAssistantScreen.recipesLink', 'Ready-made requests to try')}
      </Link>
    </section>
  );
}
