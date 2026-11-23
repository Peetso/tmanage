'use client';

import { useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { listWorkComments, type WorkComment } from '../../lib/api/work-items';
import { addCommentOrQueue } from '../../lib/offline/write-or-queue';
import { usePendingWrites } from '../../lib/offline/use-offline';
import { PendingBadge } from '../pwa/PendingBadge';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { MicNotice } from '../voice/VoiceControls';
import { VoiceControl } from '../voice/VoiceControl';
import { useVoiceInput } from '../voice/use-voice-language';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { appIntlLocale } from '../../lib/i18n/app-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useMembers } from '../../lib/use-members';
import {
  MentionPicker,
  decodeMentions,
  encodeMentions,
  findMentionQuery,
  insertMention,
  memberRoleLabel,
  type MentionOption,
} from '../chat/MentionPicker';
import { searchWorkMentionCandidates } from '../../lib/api/work-comment-mentions';

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
  return at.toLocaleString(appIntlLocale());
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
  // Work area v2: the member's own dictation language (the chip beside the mic), not only the
  // app language (WORK-AREA plan W-WEB-3).
  const voice = useVoiceInput({
    api,
    organizationSlug,
    value: body,
    onChange: (next) => setBody(next.slice(0, MAX_BODY_LENGTH)),
  });
  const dictation = voice.dictation;
  const [failure, setFailure] = useState<string | undefined>(undefined);

  // A19 (2026-11-02 live test): typing "@" here offered nobody — the box had no people source at
  // all. The organization's member directory (the same cached `useMembers` the owner field reads)
  // now feeds the chat mention picker; the pick is written into the text as "@Name".
  const tOr = useTOr();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pickerId = useId();
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const directory = useMembers(api, organizationSlug, '');
  // 53-11: the people offered are the server's answer — only those who can see this item — and a
  // pick is sent as its `@<userId>` token, so the person is notified (kind "mention"). The box
  // keeps showing "@Name"; `picked` maps each name back to its token at send time.
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(() => new Map());
  const candidates = useQuery({
    queryKey: ['work-item-mention-candidates', organizationSlug, workItemId, mention?.query ?? ''],
    queryFn: () =>
      searchWorkMentionCandidates(
        api,
        organizationSlug,
        workItemId,
        mention?.query ?? '',
        MAX_MENTION_OPTIONS,
      ),
    enabled: mention !== null,
    staleTime: 30_000,
  });
  const roleOf = useMemo(
    () => new Map(directory.members.map((member) => [member.userId, member.role])),
    [directory.members],
  );
  const mentionOptions: MentionOption[] = mention
    ? (candidates.data ?? []).slice(0, MAX_MENTION_OPTIONS).map((candidate) => {
        const subtitle = memberRoleLabel(roleOf.get(candidate.userId), tOr);
        return {
          userId: candidate.userId,
          displayName: candidate.displayName,
          mention: candidate.mention,
          group: 'others' as const,
          ...(subtitle ? { subtitle } : {}),
        };
      })
    : [];
  const nameOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const member of directory.members)
      names.set(member.userId.toLowerCase(), member.displayName);
    for (const [name, token] of picked) names.set(token.slice(1).toLowerCase(), name);
    return (userId: string) => names.get(userId.toLowerCase());
  }, [directory.members, picked]);
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
    setPicked((current) => new Map(current).set(option.displayName, option.mention));
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
    // 53-16: offline (or when the request never arrives) the comment is queued and shown below
    // with a Pending badge; it is sent, in order, when the connection is back.
    mutationFn: (nextBody: string) =>
      addCommentOrQueue(api, organizationSlug, workItemId, nextBody),
    onSuccess: () => {
      setBody('');
      setPicked(new Map());
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = body.trim();
    if (trimmed === '') return;
    add.mutate(encodeMentions(trimmed, picked).slice(0, MAX_BODY_LENGTH));
  }

  const items: readonly WorkComment[] = comments.data ?? [];
  const pendingComments = usePendingWrites(organizationSlug, workItemId, 'comment');

  return (
    <section className="tm-stack tm-wk-comments" aria-labelledby="tm-work-comments">
      {/* The Comments tab is the visible heading (Figma nice-to-have 2); this names the region. */}
      <h2 id="tm-work-comments" className="tm-visually-hidden">
        {t('WorkCommentsPanel.commentsHeading')}
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
                <p className="tm-prose" dir="auto">
                  {decodeMentions(comment.body, nameOf)}
                </p>
                <time className="tm-eyebrow" dateTime={comment.createdAt}>
                  {formatWhen(comment.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {pendingComments.length > 0 ? (
        <ul className="tm-list">
          {pendingComments.map((write) => (
            <li key={write.id} className="tm-pending-row">
              <p className="tm-prose" dir="auto">
                {decodeMentions(write.payload.body, nameOf)}
              </p>
              <PendingBadge conflict={write.status === 'conflict'} />
            </li>
          ))}
        </ul>
      ) : null}

      <form className="tm-wk-composer" noValidate onSubmit={submit}>
        <label className="tm-visually-hidden" htmlFor={bodyId}>
          {t('WorkCommentsPanel.addLabel')}
        </label>
        <div className="tm-wk-composer__box">
          <textarea
            ref={textRef}
            id={bodyId}
            className="tm-wk-composer__input"
            value={body}
            rows={1}
            dir="auto"
            maxLength={MAX_BODY_LENGTH}
            placeholder={t('WorkCommentsPanel.placeholder')}
            title={tOr(
              'WorkCommentsPanel.mentionHint',
              'Type @ to mention someone. Only people who can see this task are listed, and they get a notification.',
            )}
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
              othersHeading={tOr(
                'WorkCommentsPanel.mentionHeading',
                'People who can see this task',
              )}
              query={mention.query}
            />
          ) : null}
          <VoiceControl input={voice} placement="above" />
          <Button
            type="submit"
            tone="lime"
            size="header"
            loading={add.isPending}
            loadingLabel={t('WorkCommentsPanel.adding')}
            disabled={body.trim() === ''}
          >
            {t('WorkCommentsPanel.send')}
          </Button>
        </div>
        <MicNotice dictation={dictation} />
      </form>
    </section>
  );
}
