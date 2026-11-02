'use client';

import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { addWorkComment, listWorkComments, type WorkComment } from '../../lib/api/work-items';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDictation } from '../voice/useDictation';
import { MicButton, MicNotice } from '../voice/VoiceControls';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { appLocale } from '../../lib/i18n/app-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useMembers } from '../../lib/use-members';
import {
  MentionPicker,
  findMentionQuery,
  insertMention,
  memberRoleLabel,
  type MentionOption,
} from '../chat/MentionPicker';

export interface WorkCommentsPanelProps {
  organizationSlug: string;
  workItemId: string;
  api: ApiClient;
}

const MAX_BODY_LENGTH = 5000;
const MAX_MENTION_OPTIONS = 8;

function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(appLocale());
}

/**
 * **x147 — a work item's comments / activity.** (Work module 7; TM-13's "activity / discussion"
 * section.)
 *
 * The smallest useful unit of the activity trail the work-item detail screen named but had not
 * built: add an internal comment, see the list oldest-first. Edit, delete, mentions and reactions
 * are NS-13; this panel does add / list only, matching the append-only route behind it.
 *
 * It is mounted additively beside the rest of the detail screen (and disjoint from x145's
 * checklist), reads its own query, and invalidates that query on every write so the list reflects
 * the server rather than an optimistic guess. Comments are internal-only.
 */
export function WorkCommentsPanel({ organizationSlug, workItemId, api }: WorkCommentsPanelProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const queries = useQueryClient();
  const queryKey = ['work-item-comments', organizationSlug, workItemId] as const;
  const bodyId = useId();
  const [body, setBody] = useState('');
  const dictation = useDictation({
    value: body,
    onChange: (next) => setBody(next.slice(0, MAX_BODY_LENGTH)),
  });
  const [failure, setFailure] = useState<string | undefined>(undefined);

  // A19 (2026-11-02 live test): typing "@" here offered nobody — the box had no people source at
  // all. The organization's member directory (the same cached `useMembers` the owner field reads)
  // now feeds the chat mention picker; the pick is written into the text as "@Name".
  const tOr = useTOr();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pickerId = useId();
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const directory = useMembers(api, organizationSlug, mention?.query ?? '');
  const needle = (mention?.query ?? '').toLocaleLowerCase();
  const mentionOptions: MentionOption[] = mention
    ? directory.members
        .filter(
          (member) =>
            member.status !== 'suspended' &&
            member.status !== 'offboarded' &&
            member.displayName.toLocaleLowerCase().includes(needle),
        )
        .slice(0, MAX_MENTION_OPTIONS)
        .map((member) => {
          const subtitle = memberRoleLabel(member.role, tOr);
          return {
            userId: member.userId,
            displayName: member.displayName,
            mention: `@${member.displayName}`,
            group: 'others' as const,
            ...(subtitle ? { subtitle } : {}),
          };
        })
    : [];
  const safeActive = Math.min(activeIndex, Math.max(mentionOptions.length - 1, 0));

  function refreshMention(text: string, caret: number | null) {
    const next = caret === null ? null : findMentionQuery(text, caret);
    setMention(next);
    if (next?.query !== mention?.query) setActiveIndex(0);
  }

  function pickMention(option: MentionOption) {
    const box = textRef.current;
    if (!mention || !box) return;
    const caret = box.selectionStart ?? body.length;
    const next = insertMention(body, mention.start, caret, option.displayName);
    setBody(next.text.slice(0, MAX_BODY_LENGTH));
    setMention(null);
    requestAnimationFrame(() => {
      box.focus();
      box.setSelectionRange(next.caret, next.caret);
    });
  }

  function onBodyKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!mention) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setMention(null);
      return;
    }
    if (mentionOptions.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((safeActive + 1) % mentionOptions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((safeActive - 1 + mentionOptions.length) % mentionOptions.length);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const option = mentionOptions[safeActive];
      if (option) pickMention(option);
    }
  }

  const comments = useQuery({
    queryKey,
    queryFn: () => listWorkComments(api, organizationSlug, workItemId),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const add = useMutation({
    mutationFn: (nextBody: string) =>
      addWorkComment(api, organizationSlug, workItemId, { body: nextBody }),
    onSuccess: () => {
      setBody('');
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = body.trim();
    if (trimmed === '') return;
    add.mutate(trimmed);
  }

  const items: readonly WorkComment[] = comments.data ?? [];

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-work-comments">
      <h2 id="tm-work-comments" className="tm-eyebrow">
        {t('WorkCommentsPanel.heading')}
      </h2>

      {comments.isPending ? (
        <LoadingRegion label={t('WorkCommentsPanel.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {comments.isError ? (
        <InlineAlert tone="danger" title={t('WorkCommentsPanel.loadError')} live>
          {describe(comments.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title={t('WorkCommentsPanel.submitError')} live>
          {failure}
        </InlineAlert>
      ) : null}

      {comments.data ? (
        items.length === 0 ? (
          <p className="tm-prose">{t('WorkCommentsPanel.empty')}</p>
        ) : (
          <ul className="tm-list" aria-label={t('WorkCommentsPanel.listLabel')}>
            {items.map((comment) => (
              <li key={comment.id} className="tm-stack">
                <p className="tm-prose">{comment.body}</p>
                <time className="tm-eyebrow" dateTime={comment.createdAt}>
                  {formatWhen(comment.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <form className="tm-stack" noValidate onSubmit={submit}>
        <div className="tm-field">
          <label className="tm-field__label" htmlFor={bodyId}>
            {t('WorkCommentsPanel.addLabel')}
          </label>
          <div style={{ position: 'relative' }}>
            <textarea
              ref={textRef}
              id={bodyId}
              className="tm-field__control"
              value={body}
              rows={3}
              maxLength={MAX_BODY_LENGTH}
              role={mention ? 'combobox' : undefined}
              aria-expanded={mention ? true : undefined}
              aria-controls={mention ? pickerId : undefined}
              aria-autocomplete={mention ? 'list' : undefined}
              aria-activedescendant={
                mention && mentionOptions.length > 0 ? `${pickerId}-${safeActive}` : undefined
              }
              onChange={(event) => {
                setBody(event.target.value);
                refreshMention(event.target.value, event.target.selectionStart);
              }}
              onKeyDown={onBodyKeyDown}
              onClick={(event) =>
                refreshMention(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              onBlur={() => setMention(null)}
            />
            {mention ? (
              <MentionPicker
                id={pickerId}
                options={mentionOptions}
                activeIndex={safeActive}
                onPick={pickMention}
                onHover={setActiveIndex}
                othersHeading={t('MentionPicker.label')}
                query={mention.query}
              />
            ) : null}
          </div>
          <span className="tm-field__hint">{t('WorkCommentsPanel.hint')}</span>
        </div>
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel={t('WorkCommentsPanel.adding')}
            disabled={body.trim() === ''}
          >
            {t('WorkCommentsPanel.add')}
          </Button>
          <MicButton dictation={dictation} compact />
        </div>
        <MicNotice dictation={dictation} />
      </form>
    </section>
  );
}
