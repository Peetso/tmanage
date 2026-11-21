'use client';

import { useId, useState } from 'react';
import { Badge, Button, Field, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  confirmChatCard,
  undoChatTask,
  type AiConfirmView,
  type CardItem,
  type ChatCardView,
} from '../../lib/api/ai-chat';
import { reauthenticate } from '../../lib/api/passkeys';
import { useFormCheck } from '../../lib/forms/form-check';
import type { AiSensitivity } from '../../lib/api/ai-chat';
import type { CardPhase } from './ai-chat-model';
import { parseTypedAmount } from './ai-chat-model';
import { LockIcon, PencilIcon } from './icons';
import { useAiText, type AiTextKey } from './use-ai-text';

/** Items shown before "Show N more changes" (Figma 767:44214 shows two). */
const SHOWN_ITEMS = 2;

const SENSITIVITY_BADGE: Readonly<Record<AiSensitivity, AiTextKey | null>> = {
  money: 'AiChat.card.money',
  hr: 'AiChat.card.hr',
  external: 'AiChat.card.external',
  destructive: 'AiChat.card.destructive',
  none: null,
};

/** A `Field` error prop only when there is one (exactOptionalPropertyTypes). */
function errorProp(message: string | undefined): { error?: string } {
  return message === undefined ? {} : { error: message };
}

/** "dueDate" → "Due date": the API names fields by their key (see the lane report's gap list). */
export function fieldLabel(field: string): string {
  const words = field
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface AiChangeCardProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly card: ChatCardView;
  readonly phase: CardPhase;
  readonly onPhase: (phase: CardPhase) => void;
  /** "Edit request": the member's words go back into the message box. */
  readonly onEdit: () => void;
}

/**
 * The preview card of an AI change — Figma G5 (767:44213; fixes 782:47004) and G6 v2 money/HR
 * (783:47898). Nothing on it has run. Confirm sends the signed card back; money items need the
 * amount typed again and every money/HR item a fresh password step-up (`x-reauth-token`). The
 * undo sentence and the Undo button come only from the server's `undoUntil` / `cannotBeUndone`
 * (Fable fix 34). Sensitive cards are confirmed by tap only, never by voice.
 */
export function AiChangeCard({
  api,
  organizationSlug,
  card,
  phase,
  onPhase,
  onEdit,
}: AiChangeCardProps) {
  const text = useAiText();
  const { t } = text;
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  const [amounts, setAmounts] = useState<Readonly<Record<number, string>>>({});
  const [password, setPassword] = useState('');
  const [fault, setFault] = useState<'amount' | 'step_up' | 'error' | null>(null);
  const [undoFault, setUndoFault] = useState(false);
  const check = useFormCheck();

  const items = card.items;
  const money = items.filter((item) => item.typedAmount);
  const needsStepUp = items.some((item) => item.stepUp);
  const destructive = items.some((item) => item.sensitivity === 'destructive');
  const cannotUndo = items.some((item) => item.cannotBeUndone);
  const sensitive = items.find((item) => item.sensitivity !== 'none');
  const badgeKey = sensitive ? SENSITIVITY_BADGE[sensitive.sensitivity] : null;

  async function confirm() {
    setFault(null);
    const typed: Record<number, number> = {};
    for (const item of money) {
      const value = parseTypedAmount(amounts[item.index] ?? '');
      if (value === null || value !== item.amount) {
        setFault('amount');
        return;
      }
      typed[item.index] = value;
    }
    onPhase({ kind: 'confirming' });
    let reauthToken: string | undefined;
    try {
      if (needsStepUp) reauthToken = await reauthenticate(api, { password });
    } catch {
      setFault('step_up');
      onPhase({ kind: 'preview' });
      return;
    }
    try {
      const result = await confirmChatCard(api, organizationSlug, {
        card: card.token,
        amounts: typed,
        ...(reauthToken === undefined ? {} : { reauthToken }),
      });
      onPhase({ kind: 'done', result });
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 409 || error.status === 404)) {
        onPhase({ kind: 'ended' });
        return;
      }
      if (
        error instanceof ApiRequestError &&
        error.status === 403 &&
        error.code === 'reauthentication_required'
      ) {
        setFault('step_up');
      } else if (
        error instanceof ApiRequestError &&
        error.status === 400 &&
        error.details.some((detail) => detail.field.startsWith('amounts'))
      ) {
        setFault('amount');
      } else {
        setFault('error');
      }
      onPhase({ kind: 'preview' });
    }
  }

  async function undo(result: AiConfirmView) {
    setUndoFault(false);
    onPhase({ kind: 'undoing', result });
    try {
      onPhase({ kind: 'undone', undo: await undoChatTask(api, organizationSlug, result.taskId) });
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 409 || error.status === 404)) {
        onPhase({ kind: 'undo_refused', result });
        return;
      }
      setUndoFault(true);
      onPhase({ kind: 'done', result });
    }
  }

  if (phase.kind === 'cancelled') {
    return <p className="tm-aic-note">{t('AiChat.card.cancelled')}</p>;
  }
  if (phase.kind === 'ended') {
    return (
      <InlineAlert tone="neutral" live>
        {t('AiChat.card.ended')}
      </InlineAlert>
    );
  }
  if (phase.kind === 'undone') {
    return (
      <div className="tm-aic-result" role="status">
        <span className="tm-aic-result__title">{t('AiChat.card.undone')}</span>
        <span className="tm-aic-note">
          {phase.undo.refundedCredits > 0
            ? t('AiChat.card.refunded', { credits: text.credits(phase.undo.refundedCredits) })
            : t('AiChat.card.notRefunded')}
        </span>
      </div>
    );
  }
  if (phase.kind === 'undo_refused') {
    return (
      <InlineAlert tone="warning" live>
        {t('AiChat.card.undoRefused')}
      </InlineAlert>
    );
  }
  if (phase.kind === 'done' || phase.kind === 'undoing') {
    return (
      <DoneResult
        result={phase.result}
        items={items}
        undoing={phase.kind === 'undoing'}
        undoFault={undoFault}
        onUndo={() => void undo(phase.result)}
      />
    );
  }

  const shown = expanded ? items : items.slice(0, SHOWN_ITEMS);
  const hidden = items.length - shown.length;
  const confirming = phase.kind === 'confirming';
  const single = items.length === 1 ? items[0] : undefined;
  const title = single
    ? single.subject
      ? `${single.title}: ${single.subject}`
      : single.title
    : t('AiChat.card.manyTitle', { count: text.number(items.length) });
  const primary =
    single && sensitive
      ? single.title
      : items.length === 1
        ? t('AiChat.card.confirm')
        : t('AiChat.card.confirmMany', { count: text.number(items.length) });

  return (
    <section
      className="tm-aic-card"
      aria-labelledby={titleId}
      data-sensitivity={sensitive?.sensitivity ?? 'none'}
    >
      <div className="tm-aic-card__head">
        <span className="tm-aic-card__mark">{sensitive ? <LockIcon /> : <PencilIcon />}</span>
        <h3 id={titleId} className="tm-aic-card__title">
          {title}
        </h3>
        <Badge>{badgeKey ? t(badgeKey) : t('AiChat.card.preview')}</Badge>
      </div>

      <ul className="tm-aic-card__items">
        {shown.map((item) => (
          <li key={item.index} className="tm-aic-item">
            {single ? null : <p className="tm-aic-item__title">{item.subject ?? item.title}</p>}
            <dl className="tm-aic-item__changes">
              {item.changes.map((change) => (
                <div key={change.field} className="tm-aic-change">
                  <dt>{fieldLabel(change.field)}</dt>
                  <dd>
                    {change.before !== null && change.before !== change.after ? (
                      <>
                        <del className="tm-aic-change__before">{change.before}</del>
                        <span className="tm-aic-change__arrow" aria-hidden="true">
                          →
                        </span>
                        <span className="tm-visually-hidden">{t('AiChat.card.becomes')}</span>
                      </>
                    ) : null}
                    <span className="tm-aic-change__after">{change.after}</span>
                  </dd>
                </div>
              ))}
            </dl>
            {item.warnings.some((warning) => warning.code === 'possible_duplicate') ? (
              <InlineAlert tone="warning">{t('AiChat.card.duplicate')}</InlineAlert>
            ) : null}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button type="button" className="tm-aic-link" onClick={() => setExpanded(true)}>
          {t('AiChat.card.showMore', { count: text.number(hidden) })}
        </button>
      ) : null}

      {destructive ? (
        <InlineAlert tone="danger">{t('AiChat.card.deleteWarning')}</InlineAlert>
      ) : cannotUndo ? (
        <InlineAlert tone="warning">{t('AiChat.card.cannotUndo')}</InlineAlert>
      ) : null}

      <form noValidate className="tm-aic-card__form" {...check.handlers(() => void confirm())}>
        {money.map((item) => (
          <Field
            key={item.index}
            label={t('AiChat.card.typeAmount')}
            hint={t('AiChat.card.typeAmountHint', {
              amount: item.amount === null ? '' : text.number(item.amount),
            })}
            inputMode="decimal"
            autoComplete="off"
            dir="ltr"
            required
            value={amounts[item.index] ?? ''}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setAmounts((current) => ({ ...current, [item.index]: value }));
            }}
            name={`amount-${item.index}`}
            {...errorProp(
              fault === 'amount'
                ? t('AiChat.card.wrongAmount')
                : check.error(`amount-${item.index}`),
            )}
          />
        ))}

        {needsStepUp ? (
          <div className="tm-aic-stepup">
            <p className="tm-aic-stepup__title">{t('AiChat.card.stepUpTitle')}</p>
            <p className="tm-aic-note">{t('AiChat.card.stepUpBody')}</p>
            <Field
              label={t('AiChat.card.password')}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              {...errorProp(
                fault === 'step_up' ? t('AiChat.card.stepUpFailed') : check.error('password'),
              )}
            />
          </div>
        ) : null}

        <p className="tm-aic-note">
          {t('AiChat.card.expires', { time: text.time(card.expiresAt) })}{' '}
          {cannotUndo ? null : t('AiChat.card.undoNote')}
        </p>

        {fault === 'error' ? (
          <InlineAlert tone="danger" live>
            {t('AiChat.failed')}
          </InlineAlert>
        ) : null}

        <div
          className={['tm-aic-actions', destructive ? 'tm-aic-actions--apart' : null]
            .filter(Boolean)
            .join(' ')}
        >
          <Button
            type="submit"
            tone={destructive ? 'destructive' : 'ink'}
            size="compact"
            loading={confirming}
            className="tm-aic-touch"
          >
            {primary}
          </Button>
          {single && sensitive ? null : (
            <Button
              tone="outline"
              size="compact"
              className="tm-aic-touch"
              onClick={onEdit}
              disabled={confirming}
            >
              {t('AiChat.card.edit')}
            </Button>
          )}
          {destructive ? <span className="tm-aic-actions__spacer" /> : null}
          <Button
            tone="text"
            size="compact"
            className="tm-aic-touch"
            disabled={confirming}
            onClick={() => onPhase({ kind: 'cancelled' })}
          >
            {t('AiChat.cancel')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function DoneResult({
  result,
  items,
  undoing,
  undoFault,
  onUndo,
}: {
  readonly result: AiConfirmView;
  readonly items: readonly CardItem[];
  readonly undoing: boolean;
  readonly undoFault: boolean;
  readonly onUndo: () => void;
}) {
  const text = useAiText();
  const { t } = text;
  const done = result.items.filter((item) => item.outcome === 'done').length;
  const total = result.items.length;
  const partly = done < total;
  const titleOf = (index: number) => {
    const item = items.find((candidate) => candidate.index === index);
    return item?.subject ?? item?.title ?? '';
  };
  const canUndo = !result.cannotBeUndone && result.undoUntil !== null && done > 0;

  return (
    <div className="tm-aic-result" role="status">
      <div className="tm-aic-result__head">
        <span
          className="tm-aic-result__dot"
          data-tone={partly ? 'warning' : 'success'}
          aria-hidden="true"
        />
        <span className="tm-aic-result__title">
          {partly
            ? t('AiChat.card.partly', { done: text.number(done), total: text.number(total) })
            : t('AiChat.card.done', { count: text.number(done) })}
        </span>
        {canUndo ? (
          <Button
            tone="outline"
            size="compact"
            className="tm-aic-touch"
            loading={undoing}
            onClick={onUndo}
          >
            {partly
              ? t('AiChat.card.undoSome', { count: text.number(done) })
              : t('AiChat.card.undo')}
          </Button>
        ) : null}
      </div>
      {partly ? (
        <ul className="tm-aic-result__items">
          {result.items.map((item) => (
            <li key={item.index} data-outcome={item.outcome}>
              <span>{titleOf(item.index)}</span>
              <span className="tm-aic-note">
                {item.outcome === 'done'
                  ? t('AiChat.card.itemDone')
                  : item.outcome === 'failed'
                    ? t('AiChat.card.itemFailed')
                    : t('AiChat.card.itemNotRun')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <span className="tm-aic-note">
        {canUndo && result.undoUntil
          ? t('AiChat.card.undoUntil', { time: text.time(result.undoUntil) })
          : t('AiChat.card.doneNoUndo')}
      </span>
      {undoFault ? (
        <InlineAlert tone="danger" live>
          {t('AiChat.failed')}
        </InlineAlert>
      ) : null}
    </div>
  );
}
