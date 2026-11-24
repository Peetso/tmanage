'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@tmanage/ui';
import { listProjectMembers } from '../../lib/api/project-members';
import type { AiMemberMark } from '../../lib/api/members';
import type { ApiClient } from '../../lib/api/client';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import { useA6T, WorkDialogFrame } from './DueDatePicker';

/** One person the picker offers: a project member, named from the member directory. */
export interface OwnerCandidate {
  readonly userId: string;
  readonly displayName: string;
  /** The line under the name — the person's role on the project (an AI employee's job). */
  readonly subtitle?: string;
  /** 60-08: a person or an AI employee (absent: a person). */
  readonly kind?: 'human' | 'ai';
  /** 60-08: an AI employee's state, for the picker's AI section. */
  readonly ai?: AiMemberMark;
}

export interface OwnerPickerDialogProps {
  readonly projectName: string;
  readonly candidates: readonly OwnerCandidate[];
  /** The owner today, or `null`. Opens selected. */
  readonly value: string | null;
  readonly loading?: boolean;
  readonly saving?: boolean;
  readonly onAssign: (userId: string) => void;
  readonly onClose: () => void;
}

const ROLE_KEY: Record<string, string> = {
  lead: 'OwnerPicker.roleLead',
  manager: 'OwnerPicker.roleManager',
  member: 'OwnerPicker.roleMember',
  viewer: 'OwnerPicker.roleViewer',
};

/**
 * The people a project's work can be given to: the project's members, named from the member
 * directory. One query per project, shared by the picker and the edit dialog through the cache.
 */
export function useOwnerCandidates(
  api: ApiClient,
  organizationSlug: string,
  projectId: string,
  /**
   * 60-08: also offer the project's AI employees (the Work people pickers). Off for every other
   * owner field (decisions, requests): an AI employee is only ever a doer, chosen in Work.
   */
  options: { readonly withAi?: boolean } = {},
): { readonly candidates: readonly OwnerCandidate[]; readonly loading: boolean } {
  const t = useA6T();
  const directory = useMembers(api, organizationSlug);
  const members = useQuery({
    queryKey: ['project-members', organizationSlug, projectId],
    queryFn: () => listProjectMembers(api, organizationSlug, projectId),
    enabled: projectId !== '',
  });
  const candidates = (members.data ?? []).flatMap((member): OwnerCandidate[] => {
    const roleKey = ROLE_KEY[member.role];
    const entry = directory.members.find((row) => row.userId === member.userId);
    const displayName = memberDisplayName(member.userId, directory.members, directory.isPending);
    if (entry?.kind === 'ai') {
      // 60-08: an AI employee is offered with his job line and state (S7), and only where the
      // caller asks for AI employees. Without the mark nothing is known about him: not offered.
      if (options.withAi !== true || entry.ai === undefined) return [];
      return [
        {
          userId: member.userId,
          displayName,
          subtitle: entry.ai.jobTitle,
          kind: 'ai',
          ai: entry.ai,
        },
      ];
    }
    return [
      {
        userId: member.userId,
        displayName,
        ...(roleKey === undefined ? {} : { subtitle: t(roleKey) }),
      },
    ];
  });
  return { candidates, loading: members.isPending || directory.isPending };
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/**
 * **Choose an owner (A6, Figma fq7-owner-picker).**
 *
 * Only people on the project are listed, and the line under the title says so. A search box
 * narrows the list by name (⌘K focuses it); the chosen row is lime with a tick, and the primary
 * button names the person it will assign.
 */
export function OwnerPickerDialog({
  projectName,
  candidates,
  value,
  loading = false,
  saving = false,
  onAssign,
  onClose,
}: OwnerPickerDialogProps) {
  const t = useA6T();
  const titleId = useId();
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string | null>(value);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        search.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const needle = query.trim().toLowerCase();
  const shown =
    needle === ''
      ? candidates
      : candidates.filter((candidate) => candidate.displayName.toLowerCase().includes(needle));
  const picked = candidates.find((candidate) => candidate.userId === chosen);

  return (
    <WorkDialogFrame labelledBy={titleId} onClose={onClose}>
      <h2 id={titleId} className="tm-wk-dialog__title">
        {t('OwnerPicker.title')}
      </h2>
      <p className="tm-wk-dialog__lede">{t('OwnerPicker.onlyProject', { project: projectName })}</p>

      <label className="tm-wk-search">
        <span className="tm-wk-search__icon" aria-hidden="true">
          ⌕
        </span>
        <input
          ref={search}
          type="search"
          value={query}
          placeholder={t('OwnerPicker.search')}
          aria-label={t('OwnerPicker.search')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <kbd className="tm-wk-search__key" aria-hidden="true">
          ⌘K
        </kbd>
      </label>

      <ul className="tm-wk-people" aria-label={t('OwnerPicker.listLabel')} aria-busy={loading}>
        {shown.map((candidate) => (
          <li key={candidate.userId}>
            <button
              type="button"
              className="tm-wk-person"
              aria-pressed={candidate.userId === chosen}
              onClick={() => setChosen(candidate.userId)}
            >
              <span className="tm-wk-orb" aria-hidden="true">
                {initialsOf(candidate.displayName)}
              </span>
              <span className="tm-wk-person__text">
                <span className="tm-wk-person__name">{candidate.displayName}</span>
                {candidate.subtitle ? (
                  <span className="tm-wk-person__role">{candidate.subtitle}</span>
                ) : null}
              </span>
              {candidate.userId === chosen ? (
                <span className="tm-wk-person__tick" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
          </li>
        ))}
        {!loading && shown.length === 0 ? (
          <li className="tm-wk-people__empty">{t('OwnerPicker.none')}</li>
        ) : null}
      </ul>

      <div className="tm-wk-dialog__actions">
        <Button tone="outline" size="accessible" onClick={onClose}>
          {t('WorkA6.cancel')}
        </Button>
        <Button
          tone="ink"
          size="accessible"
          disabled={picked === undefined}
          loading={saving}
          loadingLabel={t('WorkA6.saving')}
          onClick={() => {
            if (picked) onAssign(picked.userId);
          }}
        >
          {picked
            ? t('OwnerPicker.assign', { name: firstNameOf(picked.displayName) })
            : t('OwnerPicker.assignNobody')}
        </Button>
      </div>
    </WorkDialogFrame>
  );
}
