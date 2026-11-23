'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { Button, IconButton } from '@tmanage/ui';
import type { TeamDetailView } from '../../../lib/api/people-teams';
import { useT } from '../../../lib/i18n/use-t';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { pluralPhrase } from '../../../lib/i18n/plural';
import { withNumerals } from '../../../lib/i18n/display-format';
import { useDismiss } from '../../work/use-dismiss';
import { CloseIcon, ForwardIcon, MoreIcon, PencilIcon } from '../../work/work-icons';
import { PeopleCombobox } from './PeopleCombobox';
import {
  faceInitials,
  openTotal,
  pickable,
  teamWriteProblem,
  type Candidate,
  type TeamWriteProblem,
} from './teams-model';

export interface TeamPanelProps {
  readonly organizationSlug: string;
  readonly team: TeamDetailView;
  /** `org.manage`: rename, delete, add and remove are drawn only for a role the API allows. */
  readonly mayManage: boolean;
  readonly candidates: readonly Candidate[] | undefined;
  readonly candidatesLoading: boolean;
  readonly onWantCandidates: () => void;
  readonly onRename: (name: string) => Promise<void>;
  readonly onAdd: (people: readonly Candidate[]) => Promise<void>;
  readonly onRemove: (membershipId: string) => Promise<void>;
  readonly onDelete: () => void;
  /** The phone's "‹ Teams" (Figma `WV2-06` team page): back to the list. */
  readonly onBack: () => void;
}

/**
 * **One team** (Figma `WV2-05` right half; `WV2-06` phone team page, edited in place): the name
 * with a rename pencil, how many people, "Open their work" (the Works list with this team's
 * filter), the ⋯ menu, "Add people to …", and the members as Name · Open work · Remove (review
 * fix 17: no Role column, the data has none).
 */
export function TeamPanel({
  organizationSlug,
  team,
  mayManage,
  candidates,
  candidatesLoading,
  onWantCandidates,
  onRename,
  onAdd,
  onRemove,
  onDelete,
  onBack,
}: TeamPanelProps) {
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const headingId = useId();
  const [renaming, setRenaming] = useState(false);
  const [problem, setProblem] = useState<TeamWriteProblem | null>(null);
  const count = (base: string, value: number, one: string, other: string) =>
    pluralPhrase(tOr, locale, base, value, { one, other });
  const people = count(
    'TeamsScreen.peopleCount',
    team.members.length,
    '1 person',
    '{count} people',
  );
  const open = count(
    'TeamsScreen.openCount',
    openTotal(team.members),
    '{count} open',
    '{count} open',
  );
  const workHref = `/${organizationSlug}/work?team=${encodeURIComponent(team.id)}`;
  const inTeam = new Set(team.members.map((member) => member.membershipId));

  const write = async (action: () => Promise<void>) => {
    setProblem(null);
    try {
      await action();
    } catch (failure) {
      setProblem(teamWriteProblem(failure));
    }
  };

  return (
    <section className="tm-team-panel" aria-labelledby={headingId}>
      <div className="tm-team-panel__back">
        <button
          type="button"
          className="tm-team-panel__back-link"
          aria-label={t('TeamsScreen.back')}
          onClick={onBack}
        >
          <span className="tm-team-panel__back-icon" aria-hidden="true">
            <ForwardIcon />
          </span>
          {t('TeamsScreen.title')}
        </button>
      </div>

      <div className="tm-team-panel__head">
        {renaming ? (
          <RenameForm
            initial={team.name}
            onCancel={() => setRenaming(false)}
            onSave={async (name) => {
              await onRename(name);
              setRenaming(false);
            }}
          />
        ) : (
          <>
            <h2 id={headingId} className="tm-team-panel__title">
              <bdi>{team.name}</bdi>
            </h2>
            {mayManage ? (
              <IconButton
                label={t('TeamsScreen.rename')}
                icon={<PencilIcon />}
                className="tm-team-round"
                onClick={() => setRenaming(true)}
              />
            ) : null}
            <span className="tm-team-panel__meta" data-size="desktop">
              {people}
            </span>
          </>
        )}
        <span className="tm-team-panel__end">
          <Link href={workHref} className="tm-team-panel__work" data-size="desktop">
            {t('TeamsScreen.openWork')}
          </Link>
          {mayManage ? <TeamMenu onRename={() => setRenaming(true)} onDelete={onDelete} /> : null}
        </span>
      </div>
      <p className="tm-team-panel__meta" data-size="phone">
        {people} · {open}
      </p>

      {mayManage ? (
        <PeopleCombobox
          variant="field"
          placeholder={t('TeamsScreen.addPeopleTo').replace('{name}', team.name)}
          options={(query) =>
            pickable(candidates ?? [], inTeam, query).map((person) => ({
              id: person.membershipId,
              label: person.displayName,
              kind: 'person' as const,
            }))
          }
          onPick={(option) => {
            const person = candidates?.find((c) => c.membershipId === option.id);
            if (person) void write(() => onAdd([person]));
          }}
          onOpen={onWantCandidates}
          loading={candidatesLoading}
          loadingText={t('TeamsScreen.loading')}
          emptyText={t(
            (candidates ?? []).length > 0 && pickable(candidates ?? [], inTeam, '').length === 0
              ? 'TeamsScreen.pickerAllIn'
              : 'TeamsScreen.pickerNone',
          )}
          teamTag={t('TeamsScreen.teamOption')}
        />
      ) : null}

      {problem ? (
        <p className="tm-team-panel__problem" role="alert">
          {t(`TeamsScreen.${problem}`)}
        </p>
      ) : null}

      {team.members.length === 0 ? (
        <div className="tm-team-empty" data-kind="members">
          <p className="tm-team-empty__text">{t('TeamsScreen.noMembers')}</p>
        </div>
      ) : (
        <div className="tm-team-table">
          <div className="tm-team-table__head" aria-hidden="true">
            <span className="tm-team-table__name">{t('TeamsScreen.colName')}</span>
            <span className="tm-team-table__open">{t('TeamsScreen.colOpen')}</span>
            <span className="tm-team-table__remove" />
          </div>
          <ul
            className="tm-team-table__rows"
            aria-label={t('TeamsScreen.membersOf').replace('{name}', team.name)}
          >
            {team.members.map((member) => (
              <li key={member.membershipId} className="tm-team-table__row">
                <span className="tm-team-table__name">
                  <span className="tm-team-face" aria-hidden="true">
                    {faceInitials(member.displayName)}
                  </span>
                  <span className="tm-team-table__who">
                    <Link
                      href={`/${organizationSlug}/people/${encodeURIComponent(member.membershipId)}`}
                      className="tm-team-table__link"
                    >
                      <bdi>{member.displayName}</bdi>
                    </Link>
                    <span className="tm-team-table__sub">
                      {count(
                        'TeamsScreen.openCount',
                        member.openWorkCount,
                        '{count} open',
                        '{count} open',
                      )}
                    </span>
                  </span>
                </span>
                <span className="tm-team-table__open">
                  <span className="tm-visually-hidden">{t('TeamsScreen.colOpen')}: </span>
                  {member.openWorkCount.toLocaleString(withNumerals(locale))}
                </span>
                <span className="tm-team-table__remove">
                  {mayManage ? (
                    <IconButton
                      label={t('TeamsScreen.remove').replace('{name}', member.displayName)}
                      icon={<CloseIcon />}
                      className="tm-team-round"
                      onClick={() => void write(() => onRemove(member.membershipId))}
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Link href={workHref} className="tm-team-panel__work" data-size="phone">
        {t('TeamsScreen.openWork')}
      </Link>
    </section>
  );
}

/** Rename in place (Figma `WV2-06` "edit in place"): the name becomes a box with Save and Cancel. */
function RenameForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const inputId = useId();
  const problemId = useId();
  const [name, setName] = useState(initial);
  const [problem, setProblem] = useState<TeamWriteProblem | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = name.trim();
    if (next === '') return setProblem('nameNeeded');
    if (next === initial) return onCancel();
    setSaving(true);
    try {
      await onSave(next);
    } catch (failure) {
      setProblem(teamWriteProblem(failure));
      setSaving(false);
    }
  };

  return (
    <form className="tm-team-rename" noValidate onSubmit={(event) => void submit(event)}>
      <label htmlFor={inputId} className="tm-visually-hidden">
        {t('TeamsScreen.nameLabel')}
      </label>
      <input
        id={inputId}
        className="tm-team-rename__input"
        value={name}
        maxLength={120}
        dir="auto"
        // Rename was asked for: the box is where the person types next.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        aria-invalid={problem !== null || undefined}
        {...(problem ? { 'aria-describedby': problemId } : {})}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <Button type="submit" tone="lime" size="header" loading={saving}>
        {t('TeamsScreen.save')}
      </Button>
      <Button type="button" tone="text" size="header" onClick={onCancel}>
        {t('TeamsScreen.cancel')}
      </Button>
      {problem ? (
        <p id={problemId} className="tm-team-panel__problem" role="alert">
          {t(`TeamsScreen.${problem}`)}
        </p>
      ) : null}
    </form>
  );
}

/** The ⋯ menu (WAI-ARIA APG "Menu Button"): Rename and Delete team; arrows move, Escape closes. */
function TeamMenu({ onRename, onDelete }: { onRename: () => void; onDelete: () => void }) {
  const t = useT();
  const menuId = useId();
  const box = useRef<HTMLSpanElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  useDismiss(open, box, () => setOpen(false));
  useEffect(() => {
    if (open) items.current[0]?.focus();
  }, [open]);

  const onKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const list = items.current.filter((item): item is HTMLButtonElement => item !== null);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    }
  };
  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <span ref={box} className="tm-team-menu">
      <IconButton
        label={t('TeamsScreen.actions')}
        icon={<MoreIcon />}
        className="tm-team-round"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((now) => !now)}
      />
      {open ? (
        <ul id={menuId} role="menu" className="tm-team-menu__list" onKeyDown={onKey}>
          <li role="none">
            <button
              ref={(node) => {
                items.current[0] = node;
              }}
              type="button"
              role="menuitem"
              className="tm-team-menu__item"
              onClick={() => choose(onRename)}
            >
              {t('TeamsScreen.rename')}
            </button>
          </li>
          <li role="none">
            <button
              ref={(node) => {
                items.current[1] = node;
              }}
              type="button"
              role="menuitem"
              className="tm-team-menu__item"
              data-tone="danger"
              onClick={() => choose(onDelete)}
            >
              {t('TeamsScreen.deleteTeam')}
            </button>
          </li>
        </ul>
      ) : null}
    </span>
  );
}
