'use client';

import Link from 'next/link';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import type { ChatConfirmedRoute, CopilotChatView } from '../../lib/api/ai-chat';
import type { AiCreditsView } from '../../lib/api/ai-credits';
import { AiChangeCard } from './AiChangeCard';
import {
  answerParts,
  inAppHref,
  readLinks,
  stopNotice,
  type AtOncePhase,
  type CardPhase,
  type ChatEntry,
} from './ai-chat-model';
import { FileIcon, LayersIcon } from './icons';
import { useAiText, type AiTextKey } from './use-ai-text';

const TIER_KEY: Readonly<Record<string, AiTextKey>> = {
  help: 'AiChat.tier.help',
  low: 'AiChat.tier.low',
  medium: 'AiChat.tier.medium',
  medium_high: 'AiChat.tier.medium_high',
  high: 'AiChat.tier.high',
};

export interface TurnActions {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly credits: AiCreditsView | null;
  readonly busy: boolean;
  readonly onContinue: (entryId: string, route: ChatConfirmedRoute, readScan: boolean) => void;
  readonly onSettle: (entryId: string) => void;
  readonly onRetry: (entryId: string) => void;
  readonly onCard: (entryId: string, phase: CardPhase) => void;
  readonly onAtOnce: (entryId: string, phase: AtOncePhase) => void;
  readonly onEdit: (text: string) => void;
  readonly onUndoAtOnce: (entryId: string, taskId: string) => void;
  readonly onRequestPack: () => void;
  readonly packRequested: boolean;
}

/** One entry of the conversation: the member's words, a reply in any of its states, or a failure. */
export function AiChatTurn({
  entry,
  actions,
}: {
  readonly entry: ChatEntry;
  readonly actions: TurnActions;
}) {
  const text = useAiText();
  const { t } = text;

  switch (entry.kind) {
    case 'member':
      return <MemberBubble text={entry.text} />;
    case 'past':
      return entry.role === 'member' ? (
        <MemberBubble text={entry.text} />
      ) : (
        <Answer text={entry.text} organizationSlug={actions.organizationSlug} />
      );
    case 'pending':
      return (
        <p className="tm-aic-reading" role="status">
          <span className="tm-aic-reading__dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          {t('AiChat.reading')}
        </p>
      );
    case 'failed':
      return (
        <div className="tm-aic-stop">
          <InlineAlert tone="danger" live>
            {entry.reason === 'offline' ? t('AiChat.offline') : t('AiChat.failed')}
          </InlineAlert>
          <div className="tm-aic-actions">
            <Button
              tone="outline"
              size="compact"
              className="tm-aic-touch"
              disabled={actions.busy}
              onClick={() => actions.onRetry(entry.id)}
            >
              {t('AiChat.tryAgain')}
            </Button>
          </div>
        </div>
      );
    case 'reply':
      return <Reply entry={entry} actions={actions} />;
  }
}

function MemberBubble({ text }: { readonly text: string }) {
  return (
    <div className="tm-aic-you">
      <p className="tm-aic-you__bubble" dir="auto">
        {text}
      </p>
    </div>
  );
}

function Answer({
  text,
  organizationSlug,
}: {
  readonly text: string;
  readonly organizationSlug: string;
}) {
  return (
    <div className="tm-aic-answer" dir="auto">
      {answerParts(text, organizationSlug).map((part, index) =>
        part.kind === 'link' ? (
          <Link key={index} href={part.href} className="tm-aic-answer__link">
            {part.text}
          </Link>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </div>
  );
}

function Receipt({ view }: { readonly view: CopilotChatView }) {
  const text = useAiText();
  const tier = view.tier ? text.t(TIER_KEY[view.tier] ?? 'AiChat.tier.low') : null;
  const credits =
    view.tier === 'help' && view.chargedCredits === 0
      ? text.t('AiChat.receiptFree')
      : text.credits(view.chargedCredits);
  return <p className="tm-aic-receipt">{tier ? `${credits} · ${tier}` : credits}</p>;
}

function Reply({
  entry,
  actions,
}: {
  readonly entry: Extract<ChatEntry, { kind: 'reply' }>;
  readonly actions: TurnActions;
}) {
  const text = useAiText();
  const { t } = text;
  const { view } = entry;
  const slug = actions.organizationSlug;

  if (view.state === 'estimate') {
    const tier = view.tier ? t(TIER_KEY[view.tier] ?? 'AiChat.tier.high') : '';
    const ceiling = view.ceilingCredits ?? 0;
    const scan = view.file?.readScan === true;
    return (
      <section className="tm-aic-card" aria-label={t('AiChat.estimate.title')}>
        <div className="tm-aic-card__head">
          <span className="tm-aic-card__mark">{scan ? <FileIcon /> : <LayersIcon />}</span>
          <h3 className="tm-aic-card__title">
            {scan ? t('AiChat.estimate.scanTitle') : t('AiChat.estimate.title')}
          </h3>
        </div>
        <dl className="tm-aic-rows">
          <div>
            <dt>{t('AiChat.estimate.level')}</dt>
            <dd>{tier}</dd>
          </div>
          <div>
            <dt>{t('AiChat.estimate.most')}</dt>
            <dd>{text.credits(ceiling)}</dd>
          </div>
          {actions.credits ? (
            <div>
              <dt>{t('AiChat.estimate.left')}</dt>
              <dd>
                {text.credits(
                  actions.credits.remainingCredits + actions.credits.packBalanceCredits,
                )}
              </dd>
            </div>
          ) : null}
        </dl>
        <hr className="tm-aic-divider" />
        <p className="tm-aic-note">
          {scan ? `${t('AiChat.estimate.scanNote')} ` : ''}
          {t('AiChat.estimate.note', { ceiling: text.number(ceiling) })}
        </p>
        {entry.settled ? null : (
          <div className="tm-aic-actions">
            <Button
              size="compact"
              className="tm-aic-touch"
              disabled={actions.busy || view.tier === null || view.domain === null}
              onClick={() => {
                if (view.tier === null || view.domain === null) return;
                actions.onContinue(entry.id, { tier: view.tier, domain: view.domain }, scan);
              }}
            >
              {t('AiChat.estimate.continue')}
            </Button>
            <Button
              tone="text"
              size="compact"
              className="tm-aic-touch"
              onClick={() => actions.onSettle(entry.id)}
            >
              {t('AiChat.cancel')}
            </Button>
          </div>
        )}
      </section>
    );
  }

  if (view.state === 'stopped') {
    return <Stopped entry={entry} actions={actions} />;
  }

  if (view.state === 'preview' && view.card) {
    return (
      <div className="tm-aic-reply">
        {view.answer ? <Answer text={view.answer} organizationSlug={slug} /> : null}
        <AiChangeCard
          api={actions.api}
          organizationSlug={slug}
          card={view.card}
          phase={entry.card}
          onPhase={(phase) => actions.onCard(entry.id, phase)}
          onEdit={() => actions.onEdit(entry.request.message)}
        />
        <Receipt view={view} />
      </div>
    );
  }

  if (view.state === 'navigate' && view.navigation) {
    const href = inAppHref(view.navigation.href, slug);
    return (
      <div className="tm-aic-reply">
        <Link href={href} className="tm-aic-go">
          {t('AiChat.goTo', { title: view.navigation.title })}
        </Link>
        <Receipt view={view} />
      </div>
    );
  }

  const answer = view.answer ?? '';
  const links = readLinks(answer, slug);
  return (
    <div className="tm-aic-reply">
      <Answer text={answer} organizationSlug={slug} />
      {view.withheldFigures > 0 ? (
        <InlineAlert tone="neutral">{t('AiChat.withheld')}</InlineAlert>
      ) : null}
      {view.truncated ? <p className="tm-aic-note">{t('AiChat.truncated')}</p> : null}
      {view.undo ? <AtOnce entry={entry} actions={actions} /> : null}
      {links.length > 0 ? (
        <nav className="tm-aic-read" aria-label={t('AiChat.whatIRead')}>
          <p className="tm-aic-read__title">{t('AiChat.whatIRead')}</p>
          <ul>
            {links.map((link) => (
              <li key={link.href}>
                <FileIcon />
                <Link href={link.href}>{link.text}</Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <Receipt view={view} />
    </div>
  );
}

/** Changes that ran at once (owner setting), with Undo for 15 minutes — Figma 767:44391. */
function AtOnce({
  entry,
  actions,
}: {
  readonly entry: Extract<ChatEntry, { kind: 'reply' }>;
  readonly actions: TurnActions;
}) {
  const text = useAiText();
  const { t } = text;
  const undo = entry.view.undo;
  if (!undo) return null;
  const phase = entry.atOnce;
  if (phase.kind === 'undone') {
    return (
      <p className="tm-aic-note" role="status">
        {t('AiChat.card.undone')}{' '}
        {phase.undo.refundedCredits > 0
          ? t('AiChat.card.refunded', { credits: text.credits(phase.undo.refundedCredits) })
          : t('AiChat.card.notRefunded')}
      </p>
    );
  }
  if (phase.kind === 'undo_refused') {
    return (
      <InlineAlert tone="warning" live>
        {t('AiChat.card.undoRefused')}
      </InlineAlert>
    );
  }
  const canUndo = !undo.cannotBeUndone && undo.until !== null;
  return (
    <div className="tm-aic-result">
      <div className="tm-aic-result__head">
        <span className="tm-aic-result__dot" data-tone="success" aria-hidden="true" />
        <span className="tm-aic-result__title">{t('AiChat.card.doneAtOnce')}</span>
        {canUndo ? (
          <Button
            tone="outline"
            size="compact"
            className="tm-aic-touch"
            loading={phase.kind === 'undoing'}
            onClick={() => actions.onUndoAtOnce(entry.id, undo.taskId)}
          >
            {t('AiChat.card.undo')}
          </Button>
        ) : null}
      </div>
      <span className="tm-aic-note">
        {canUndo && undo.until
          ? t('AiChat.card.undoUntil', { time: text.time(undo.until) })
          : t('AiChat.card.doneNoUndo')}
      </span>
    </div>
  );
}

/** A turn that stopped before any answer: Figma G7 v2 (789:51792), 62-14 limits (789:50184). */
function Stopped({
  entry,
  actions,
}: {
  readonly entry: Extract<ChatEntry, { kind: 'reply' }>;
  readonly actions: TurnActions;
}) {
  const text = useAiText();
  const { t } = text;
  const { view } = entry;
  const slug = actions.organizationSlug;
  const notice = stopNotice(view);
  const owner = actions.credits?.canRequestPack === true || actions.credits?.openRequest != null;
  const usageHref = `/${slug}/admin/ai/usage`;
  const resets = actions.credits ? text.day(actions.credits.resetsOn) : null;

  let tone: 'danger' | 'warning' | 'neutral' = 'neutral';
  let message: string;
  let buttons: React.ReactNode = null;

  switch (notice) {
    case 'credits_used':
      tone = 'danger';
      message = resets
        ? t('AiChat.stop.creditsUsed', { date: resets })
        : t('AiChat.stop.creditsUsedSoon');
      buttons = owner ? (
        <>
          {actions.credits?.canRequestPack && !actions.packRequested ? (
            <Button size="compact" className="tm-aic-touch" onClick={actions.onRequestPack}>
              {t('AiChat.stop.requestCredits')}
            </Button>
          ) : (
            <span className="tm-aic-note">{t('AiChat.stop.requestOpen')}</span>
          )}
          <Link
            href={usageHref}
            className="tm-button tm-button--outline tm-button--compact tm-aic-touch"
          >
            {t('AiChat.stop.seeUsage')}
          </Link>
        </>
      ) : null;
      break;
    case 'member_share':
      tone = 'warning';
      message = resets
        ? t('AiChat.stop.memberShare', { date: resets })
        : t('AiChat.stop.memberShareSoon');
      break;
    case 'platform_paused':
      message = t('AiChat.stop.paused');
      break;
    case 'provider':
      tone = 'warning';
      message = t('AiChat.stop.provider');
      buttons = (
        <Button
          tone="outline"
          size="compact"
          className="tm-aic-touch"
          disabled={actions.busy}
          onClick={() => actions.onRetry(entry.id)}
        >
          {t('AiChat.tryAgain')}
        </Button>
      );
      break;
    case 'sonnet':
      message = t('AiChat.stop.sonnet');
      buttons =
        view.domain === null ? null : (
          <>
            <Button
              size="compact"
              className="tm-aic-touch"
              disabled={actions.busy}
              onClick={() => {
                if (view.domain !== null)
                  actions.onContinue(entry.id, { tier: 'medium', domain: view.domain }, false);
              }}
            >
              {t('AiChat.stop.shorter')}
            </Button>
            <Button
              tone="text"
              size="compact"
              className="tm-aic-touch"
              disabled={actions.busy}
              onClick={() => actions.onRetry(entry.id)}
            >
              {t('AiChat.stop.waitRetry')}
            </Button>
          </>
        );
      break;
    case 'own_ai':
      message = t('AiChat.stop.ownAi');
      buttons = (
        <Link
          href={`/${slug}/settings/ai-assistant`}
          className="tm-button tm-button--outline tm-button--compact tm-aic-touch"
        >
          {t('AiChat.stop.ownAiLink')}
        </Link>
      );
      break;
    case 'rate_limited':
      tone = 'warning';
      message = t('AiChat.stop.rateLimited', {
        seconds: text.number(view.retryAfterSeconds ?? 60),
      });
      break;
    case 'free_help_used':
      message = t('AiChat.stop.freeHelpUsed');
      buttons = (
        <Link
          href={`/${slug}/help`}
          className="tm-button tm-button--outline tm-button--compact tm-aic-touch"
        >
          {t('AiChat.stop.helpPages')}
        </Link>
      );
      break;
    case 'not_understood':
      message = t('AiChat.stop.notUnderstood');
      break;
    case 'scan':
      message = t('AiChat.stop.scan');
      break;
    case 'tier':
      message = t('AiChat.stop.tier', {
        tier: view.suggestedTier ? t(TIER_KEY[view.suggestedTier] ?? 'AiChat.tier.high') : '',
      });
      break;
    case 'generic':
      message = t('AiChat.stop.generic');
      break;
  }

  return (
    <div className="tm-aic-stop">
      <InlineAlert tone={tone} live>
        {message}
      </InlineAlert>
      {buttons ? <div className="tm-aic-actions">{buttons}</div> : null}
      <Receipt view={view} />
    </div>
  );
}
