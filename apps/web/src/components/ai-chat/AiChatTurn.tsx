'use client';

import Link from 'next/link';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import type {
  AiUnavailableReason,
  ChatConfirmedRoute,
  CopilotChatView,
} from '../../lib/api/ai-chat';
import type { AiCreditsView } from '../../lib/api/ai-credits';
import { AiChangeCard } from './AiChangeCard';
import { ReadAloudIcon, ReadingBar, spokenText } from './AiVoice';
import {
  answerParts,
  inAppHref,
  readLinks,
  stopNotice,
  type AtOncePhase,
  type CardPhase,
  type ChatEntry,
} from './ai-chat-model';
import { useOrganizationRole } from '../../lib/use-organization-names';
import { FileIcon, LayersIcon } from './icons';
import { OwnAiPointer } from './OwnAiPointer';
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
        <div className="tm-aic-reply">
          <Answer text={entry.text} organizationSlug={actions.organizationSlug} />
          <ReadingBar id={entry.id} />
          <ReadAloudRow
            id={entry.id}
            text={entry.text}
            organizationSlug={actions.organizationSlug}
          />
        </div>
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
      if (typeof entry.reason === 'object') {
        return (
          <Unavailable
            reason={entry.reason.unavailable}
            organizationSlug={actions.organizationSlug}
            busy={actions.busy}
            onRetry={() => actions.onRetry(entry.id)}
          />
        );
      }
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

/** The owner's line and where to fix it, per reason; `fix: null` = nothing for the owner to do. */
const OWNER_UNAVAILABLE: Readonly<
  Record<
    AiUnavailableReason,
    { readonly message: AiTextKey; readonly fix: { path: string; label: AiTextKey } | null }
  >
> = {
  not_on_test_list: { message: 'AiChat.unavailable.ownerNotListed', fix: null },
  flag_off: {
    message: 'AiChat.unavailable.ownerFlagOff',
    fix: { path: 'admin/feature-flags', label: 'AiChat.unavailable.openFlags' },
  },
  ai_off: {
    message: 'AiChat.unavailable.ownerAiOff',
    fix: { path: 'admin/ai', label: 'AiChat.unavailable.openSettings' },
  },
  no_key: { message: 'AiChat.unavailable.ownerNoKey', fix: null },
};

/**
 * AI-TWO-WAYS: TManage AI cannot answer here (404 `ai_unavailable`). The owner reads the cause and
 * where to switch it on; a member reads that it is not here yet. Both keep Try again and the other
 * direction, their own AI. The role only picks the wording; the API decides everything.
 */
function Unavailable({
  reason,
  organizationSlug,
  busy,
  onRetry,
}: {
  readonly reason: AiUnavailableReason;
  readonly organizationSlug: string;
  readonly busy: boolean;
  readonly onRetry: () => void;
}) {
  const { t } = useAiText();
  const owner = useOrganizationRole(organizationSlug).role === 'owner';
  const said = owner ? OWNER_UNAVAILABLE[reason] : null;
  return (
    <div className="tm-aic-stop">
      <InlineAlert tone="neutral" live>
        {t(said?.message ?? 'AiChat.unavailable.member')}
      </InlineAlert>
      <div className="tm-aic-actions">
        {said?.fix ? (
          <Link
            href={`/${encodeURIComponent(organizationSlug)}/${said.fix.path}`}
            className="tm-button tm-button--outline tm-button--compact tm-aic-touch"
          >
            {t(said.fix.label)}
          </Link>
        ) : null}
        <Button
          tone="outline"
          size="compact"
          className="tm-aic-touch"
          disabled={busy}
          onClick={onRetry}
        >
          {t('AiChat.tryAgain')}
        </Button>
      </div>
      <OwnAiPointer organizationSlug={organizationSlug} />
    </div>
  );
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
        ) : part.kind === 'strong' ? (
          <strong key={index}>{part.text}</strong>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </div>
  );
}

function Receipt({
  view,
  speak,
}: {
  readonly view: CopilotChatView;
  /** The answer to offer read aloud on this line (62-16), with the entry it belongs to. */
  readonly speak?: { readonly id: string; readonly text: string; readonly slug: string };
}) {
  const text = useAiText();
  const tier = view.tier ? text.t(TIER_KEY[view.tier] ?? 'AiChat.tier.low') : null;
  const credits =
    view.tier === 'help' && view.chargedCredits === 0
      ? text.t('AiChat.receiptFree')
      : text.credits(view.chargedCredits);
  const line = <p className="tm-aic-receipt">{tier ? `${credits} · ${tier}` : credits}</p>;
  if (!speak) return line;
  return (
    <div className="tm-aic-receipt-row">
      {line}
      <ReadAloudIcon id={speak.id} text={spokenText(answerParts(speak.text, speak.slug))} />
    </div>
  );
}

/** A past answer has no receipt: the speaker sits on its own line. */
function ReadAloudRow({
  id,
  text,
  organizationSlug,
}: {
  readonly id: string;
  readonly text: string;
  readonly organizationSlug: string;
}) {
  return (
    <div className="tm-aic-receipt-row">
      <span />
      <ReadAloudIcon id={id} text={spokenText(answerParts(text, organizationSlug))} />
    </div>
  );
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
      <ReadingBar id={entry.id} />
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
      <Receipt view={view} speak={{ id: entry.id, text: answer, slug }} />
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
