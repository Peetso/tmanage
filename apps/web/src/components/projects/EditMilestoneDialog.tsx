'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@tmanage/ui';
import {
  createMilestone,
  deleteMilestone,
  editMilestone,
  type MilestoneDetail,
} from '../../lib/api/project-milestones';
import type { MemberSummary } from '../../lib/api/members';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import './templates-milestones.css';
import { appDateLocale } from '../../lib/i18n/app-locale';

/* ── Shared by the A9 dialogs ───────────────────────────────────────────────────────── */

export type TOr = (key: string, english: string) => string;

/** "Fri 14 Nov" / "الجمعة 14 نوفمبر" — a calendar day, Latin digits in both languages. */
export function shortDay(day: string, locale: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, date));
  if (Number.isNaN(parsed.getTime())) return day;
  const arabic = locale.toLowerCase().startsWith('ar');
  const parts = new Intl.DateTimeFormat(appDateLocale(arabic ? locale : 'en-GB'), {
    weekday: arabic ? 'long' : 'short',
    day: 'numeric',
    month: arabic ? 'long' : 'short',
    timeZone: 'UTC',
  }).formatToParts(parsed);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')}`;
}

/** Initials for an avatar orb; one letter for an Arabic name, as the Arabic frames show. */
export function orbInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (/[؀-ۿ]/.test(name)) return words[0]?.[0] ?? '·';
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '·';
}

/** A thrown value as a sentence a person can act on. */
export function describeA9Error(error: unknown, tOr: TOr): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 409) {
      return tOr(
        'EditMilestone.inUse',
        'This milestone is linked to other work, so it can’t be deleted.',
      );
    }
    return error.message;
  }
  if (error instanceof NetworkError) {
    return tOr('EditMilestone.offline', 'We couldn’t reach TManage. Check your connection.');
  }
  return tOr('EditMilestone.failed', 'Something went wrong. Try again.');
}

/** Escape closes a dialog. */
export function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
}

/** A labelled chip ("Client / Atlas Hospitality ▾") over a native `<select>`. */
export function ChipSelect({
  label,
  value,
  display,
  orb,
  onChange,
  children,
}: {
  label: string;
  value: string;
  display: string;
  orb?: string | null;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="tm-a9-chip">
      {orb ? (
        <span className="tm-a9-orb" aria-hidden="true">
          {orb}
        </span>
      ) : null}
      <span className="tm-a9-chip__text" aria-hidden="true">
        <span className="tm-a9-chip__label">{label}</span>
        <span className="tm-a9-chip__value">{display}</span>
      </span>
      <span className="tm-a9-chip__caret" aria-hidden="true">
        ▾
      </span>
      <select
        id={id}
        className="tm-a9-chip__control"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </div>
  );
}

/** A labelled chip ("Due / Fri 14 Nov ▾") over a native date input. */
export function ChipDate({
  label,
  value,
  display,
  onChange,
}: {
  label: string;
  value: string;
  display: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="tm-a9-chip">
      <span className="tm-a9-chip__text" aria-hidden="true">
        <span className="tm-a9-chip__label">{label}</span>
        <span className="tm-a9-chip__value">{display}</span>
      </span>
      <span className="tm-a9-chip__caret" aria-hidden="true">
        ▾
      </span>
      <input
        type="date"
        className="tm-a9-chip__control"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onClick={(event) => {
          try {
            event.currentTarget.showPicker();
          } catch {
            // Older browsers open the picker on their own; nothing to do.
          }
        }}
      />
    </div>
  );
}

/* ── Edit milestone ─────────────────────────────────────────────────────────────────── */

export interface EditMilestoneDialogProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly projectId: string;
  /** The milestone to edit; `null` adds a new one. */
  readonly milestone: MilestoneDetail | null;
  /** The client company that sees published milestones, or null for an internal project. */
  readonly clientName: string | null;
  readonly members: readonly MemberSummary[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}

/**
 * **Edit milestone** (Figma `fq6-edit-milestone`): Name, What is delivered, Due and Owner chips, the
 * "Show on the client timeline" toggle, a red "Delete milestone", Cancel / Save. With no milestone it
 * is the same form for "Add milestone", without Delete.
 */
export function EditMilestoneDialog({
  api,
  organizationSlug,
  projectId,
  milestone,
  clientName,
  members,
  onClose,
  onSaved,
}: EditMilestoneDialogProps) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const titleId = useId();
  const toggleTitleId = useId();
  const toggleHintId = useId();
  useEscape(onClose);

  const [title, setTitle] = useState(milestone?.title ?? '');
  const [description, setDescription] = useState(milestone?.description ?? '');
  const [dueOn, setDueOn] = useState(milestone?.dueOn ?? '');
  const [ownerUserId, setOwnerUserId] = useState(milestone?.ownerUserId ?? '');
  const [published, setPublished] = useState(milestone?.published ?? clientName !== null);

  const save = useMutation({
    mutationFn: async () => {
      const details = {
        description: description.trim() === '' ? null : description.trim(),
        ownerUserId: ownerUserId === '' ? null : ownerUserId,
      };
      if (milestone === null) {
        const id = await createMilestone(api, organizationSlug, projectId, {
          title: title.trim(),
          dueOn: dueOn === '' ? null : dueOn,
          published,
        });
        if (details.description !== null || details.ownerUserId !== null) {
          await editMilestone(api, organizationSlug, projectId, id, details);
        }
        return;
      }
      await editMilestone(api, organizationSlug, projectId, milestone.id, {
        title: title.trim(),
        dueOn: dueOn === '' ? null : dueOn,
        published,
        ...details,
      });
    },
    onSuccess: onSaved,
  });

  const remove = useMutation({
    mutationFn: () => deleteMilestone(api, organizationSlug, projectId, milestone?.id ?? ''),
    onSuccess: onSaved,
  });

  const owner = members.find((member) => member.userId === ownerUserId);
  const canSave = title.trim() !== '' && !save.isPending && !remove.isPending;
  const error = save.error ?? remove.error;

  return (
    <div className="tm-command-palette__backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="tm-a9-dialog tm-a9-dialog--narrow"
      >
        <h2 id={titleId} className="tm-a9-dialog__title">
          {milestone === null
            ? tOr('EditMilestone.addTitle', 'Add milestone')
            : tOr('EditMilestone.title', 'Edit milestone')}
        </h2>

        <form
          noValidate
          className="tm-a9-form"
          aria-labelledby={titleId}
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) save.mutate();
          }}
        >
          <label className="tm-a9-field">
            <span className="tm-a9-label">{tOr('EditMilestone.name', 'Name')}</span>
            <input
              className="tm-a9-input"
              name="title"
              value={title}
              maxLength={300}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label className="tm-a9-field">
            <span className="tm-a9-label">
              {tOr('EditMilestone.delivered', 'What is delivered')}
            </span>
            <input
              className="tm-a9-input"
              name="description"
              value={description}
              maxLength={2000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>

          <div className="tm-a9-chips">
            <ChipDate
              label={tOr('EditMilestone.due', 'Due')}
              value={dueOn}
              display={
                dueOn === '' ? tOr('EditMilestone.noDate', 'No date') : shortDay(dueOn, locale)
              }
              onChange={setDueOn}
            />
            <ChipSelect
              label={tOr('EditMilestone.owner', 'Owner')}
              value={ownerUserId}
              display={owner?.displayName ?? tOr('EditMilestone.noOwner', 'No owner')}
              orb={owner ? orbInitials(owner.displayName) : null}
              onChange={setOwnerUserId}
            >
              <option value="">{tOr('EditMilestone.noOwner', 'No owner')}</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.displayName}
                </option>
              ))}
            </ChipSelect>
          </div>

          <div className="tm-a9-toggle">
            <div>
              <p id={toggleTitleId} className="tm-a9-toggle__title">
                {tOr('EditMilestone.showOnTimeline', 'Show on the client timeline')}
              </p>
              <p id={toggleHintId} className="tm-a9-toggle__hint">
                {clientName === null
                  ? tOr('EditMilestone.clientSeesGeneric', 'Your client sees the name and date.')
                  : tOr('EditMilestone.clientSees', '{client} sees the name and date.').replace(
                      '{client}',
                      clientName,
                    )}
              </p>
            </div>
            <input
              type="checkbox"
              role="switch"
              className="tm-switch"
              aria-labelledby={toggleTitleId}
              aria-describedby={toggleHintId}
              checked={published}
              onChange={(event) => setPublished(event.target.checked)}
            />
          </div>

          {error ? (
            <p className="tm-a9-error" role="alert">
              {describeA9Error(error, tOr)}
            </p>
          ) : null}

          <div className={`tm-a9-footer${milestone === null ? '' : ' tm-a9-footer--split'}`}>
            {milestone === null ? null : (
              <button
                type="button"
                className="tm-a9-delete"
                disabled={remove.isPending || save.isPending}
                onClick={() => remove.mutate()}
              >
                {tOr('EditMilestone.delete', 'Delete milestone')}
              </button>
            )}
            <div className="tm-a9-footer__end">
              <Button
                type="button"
                tone="outline"
                size="feature"
                className="tm-a9-btn"
                onClick={onClose}
              >
                {tOr('EditMilestone.cancel', 'Cancel')}
              </Button>
              <Button
                type="submit"
                tone="ink"
                size="feature"
                className="tm-a9-btn"
                disabled={!canSave}
                loading={save.isPending}
                loadingLabel={tOr('EditMilestone.saving', 'Saving…')}
              >
                {tOr('EditMilestone.save', 'Save')}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
