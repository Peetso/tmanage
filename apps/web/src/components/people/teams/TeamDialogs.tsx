'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, IconButton } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import type { TeamListRowView } from '../../../lib/api/people-teams';
import { useT } from '../../../lib/i18n/use-t';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { pluralPhrase } from '../../../lib/i18n/plural';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { VoiceControl } from '../../voice/VoiceControl';
import { useVoiceInput } from '../../voice/use-voice-language';
import { CloseIcon } from '../../work/work-icons';
import { PeopleCombobox, type ComboOption } from './PeopleCombobox';
import {
  addChosen,
  faceInitials,
  pickable,
  teamWriteProblem,
  type Candidate,
  type TeamWriteProblem,
} from './teams-model';
import type { CreatedTeam } from './use-teams';

/**
 * The Teams page's modal frame: the native `<dialog>` opened with `showModal()`, which gives the
 * WAI-ARIA APG "Dialog (Modal)" behaviour from the platform (inert page behind, Escape closes,
 * focus held inside); focus goes back to the opener on close. A phone shows it as a bottom sheet
 * (Figma `WV2-09` delete-team, phone).
 */
function TeamDialogFrame({
  labelledBy,
  onClose,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    if (node && !node.open) {
      // A DOM without the modal API (jsdom) still shows it, so the dialog is never invisible.
      if (typeof node.showModal === 'function') node.showModal();
      else node.setAttribute('open', '');
    }
    // showModal() focuses the first focusable control (the close ×); the dialog names where the
    // person starts instead: the name in New team, Cancel in a delete (APG: the least
    // destructive action).
    node?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => previous?.focus?.();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="tm-team-dialog"
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}

function DialogHead({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const t = useT();
  return (
    <div className="tm-team-dialog__head">
      <h2 id={id} className="tm-team-dialog__title">
        {title}
      </h2>
      <IconButton
        label={t('TeamsScreen.close')}
        icon={<CloseIcon />}
        className="tm-team-dialog__close"
        onClick={onClose}
      />
    </div>
  );
}

export interface NewTeamDialogProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly teams: readonly TeamListRowView[];
  readonly candidates: readonly Candidate[] | undefined;
  readonly candidatesLoading: boolean;
  readonly onWantCandidates: () => void;
  readonly peopleOf: (teamId: string) => Promise<readonly Candidate[]>;
  readonly onCreate: (name: string, people: readonly Candidate[]) => Promise<CreatedTeam>;
  readonly onCreated: (created: CreatedTeam) => void;
  readonly onClose: () => void;
  /** Stories: open with a name and people already in, as Figma `WV2-06` draws it. */
  readonly initialName?: string;
  readonly initialPeople?: readonly Candidate[];
}

/**
 * **New team** (Figma `WV2-06`): a name with voice naming (the shared mic and language chip, review
 * fix 10), then the people as chips with "Add people or a team…", then Cancel and Create team
 * (Size Large, review fix 7). A taken name is said under the name; the dialog stays open.
 */
export function NewTeamDialog({
  api,
  organizationSlug,
  teams,
  candidates,
  candidatesLoading,
  onWantCandidates,
  peopleOf,
  onCreate,
  onCreated,
  onClose,
  initialName = '',
  initialPeople = [],
}: NewTeamDialogProps) {
  const t = useT();
  const titleId = useId();
  const nameId = useId();
  const peopleId = useId();
  const problemId = useId();
  const [name, setName] = useState(initialName);
  const [chosen, setChosen] = useState<readonly Candidate[]>(initialPeople);
  const [problem, setProblem] = useState<TeamWriteProblem | null>(null);
  const [saving, setSaving] = useState(false);
  const voice = useVoiceInput({
    api,
    organizationSlug,
    value: name,
    onChange: (next) => setName(next.slice(0, 120)),
  });

  const taken = new Set(chosen.map((person) => person.membershipId));
  const options = (query: string): readonly ComboOption[] => {
    const needle = query.trim().toLocaleLowerCase();
    const teamRows = teams
      .filter((team) => team.memberCount > 0)
      .filter((team) => needle === '' || team.name.toLocaleLowerCase().includes(needle))
      .map((team) => ({ id: team.id, label: team.name, kind: 'team' as const }));
    const people = pickable(candidates ?? [], taken, query).map((person) => ({
      id: person.membershipId,
      label: person.displayName,
      kind: 'person' as const,
    }));
    return [...teamRows, ...people];
  };

  const onPick = async (option: ComboOption) => {
    if (option.kind === 'person') {
      const person = candidates?.find((candidate) => candidate.membershipId === option.id);
      if (person) setChosen((now) => addChosen(now, [person]));
      return;
    }
    try {
      const people = await peopleOf(option.id);
      setChosen((now) => addChosen(now, people));
    } catch {
      setProblem('writeFailed');
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') {
      setProblem('nameNeeded');
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const created = await onCreate(name.trim(), chosen);
      onCreated(created);
    } catch (failure) {
      setProblem(teamWriteProblem(failure));
      setSaving(false);
    }
  };

  return (
    <TeamDialogFrame labelledBy={titleId} onClose={onClose}>
      <form className="tm-team-dialog__form" noValidate onSubmit={(event) => void submit(event)}>
        <DialogHead id={titleId} title={t('TeamsScreen.newTeam')} onClose={onClose} />

        <div className="tm-team-dialog__field">
          <label htmlFor={nameId} className="tm-team-dialog__label">
            {t('TeamsScreen.nameShort')}
          </label>
          <div className="tm-team-name" data-invalid={problem === 'nameTaken' || undefined}>
            <input
              id={nameId}
              className="tm-team-name__input"
              value={name}
              maxLength={120}
              dir="auto"
              required
              placeholder={t('TeamsScreen.namePlaceholder')}
              data-autofocus
              aria-invalid={problem === 'nameTaken' || problem === 'nameNeeded' || undefined}
              {...(problem ? { 'aria-describedby': problemId } : {})}
              onChange={(event) => setName(event.target.value)}
            />
            <VoiceControl input={voice} />
          </div>
        </div>

        <div className="tm-team-dialog__field">
          <span id={peopleId} className="tm-team-dialog__label">
            {t('TeamsScreen.people')}
          </span>
          <PeopleCombobox
            variant="chips"
            labelledBy={peopleId}
            placeholder={t('TeamsScreen.peoplePlaceholder')}
            options={options}
            onPick={(option) => void onPick(option)}
            onOpen={onWantCandidates}
            loading={candidatesLoading}
            loadingText={t('TeamsScreen.loading')}
            emptyText={t('TeamsScreen.pickerNone')}
            teamTag={t('TeamsScreen.teamOption')}
            before={chosen.map((person) => (
              <span key={person.membershipId} className="tm-team-chip">
                <span className="tm-team-face" aria-hidden="true">
                  {faceInitials(person.displayName)}
                </span>
                <bdi className="tm-team-chip__name">{person.displayName}</bdi>
                <button
                  type="button"
                  className="tm-team-chip__remove"
                  aria-label={t('TeamsScreen.removeChip').replace('{name}', person.displayName)}
                  onClick={() =>
                    setChosen((now) => now.filter((p) => p.membershipId !== person.membershipId))
                  }
                >
                  <CloseIcon />
                </button>
              </span>
            ))}
          />
        </div>

        {problem ? (
          <p id={problemId} className="tm-team-dialog__problem" role="alert">
            {t(`TeamsScreen.${problem}`)}
          </p>
        ) : null}

        <div className="tm-team-dialog__actions">
          <Button type="button" tone="text" size="large" onClick={onClose}>
            {t('TeamsScreen.cancel')}
          </Button>
          <Button type="submit" tone="lime" size="large" loading={saving}>
            {t('TeamsScreen.create')}
          </Button>
        </div>
      </form>
    </TeamDialogFrame>
  );
}

export interface DeleteTeamDialogProps {
  readonly team: { readonly id: string; readonly name: string; readonly people: number };
  readonly onDelete: (teamId: string) => Promise<void>;
  readonly onDeleted: () => void;
  readonly onClose: () => void;
}

/**
 * **Delete the team** (Figma `WV2-09` delete-team): says the people stay and keep their work, and
 * only the team goes (the API's delete removes the grouping, never a membership or a work item).
 */
export function DeleteTeamDialog({ team, onDelete, onDeleted, onClose }: DeleteTeamDialogProps) {
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const confirm = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await onDelete(team.id);
      onDeleted();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <TeamDialogFrame labelledBy={titleId} onClose={onClose}>
      <div className="tm-team-dialog__form">
        <DialogHead
          id={titleId}
          title={t('TeamsScreen.deleteTitle').replace('{name}', team.name)}
          onClose={onClose}
        />
        <p className="tm-team-dialog__body">
          {pluralPhrase(tOr, locale, 'TeamsScreen.deleteBody', team.people, {
            one: 'The 1 person stays in TManage and keeps their work. Only the team is removed.',
            other:
              'The {count} people stay in TManage and keep their work. Only the team is removed.',
          })}
        </p>
        {failed ? (
          <p className="tm-team-dialog__problem" role="alert">
            {t('TeamsScreen.writeFailed')}
          </p>
        ) : null}
        <div className="tm-team-dialog__actions">
          <Button type="button" tone="text" size="large" data-autofocus onClick={onClose}>
            {t('TeamsScreen.cancel')}
          </Button>
          <Button
            type="button"
            tone="destructive"
            size="large"
            loading={busy}
            onClick={() => void confirm()}
          >
            {t('TeamsScreen.deleteTeam')}
          </Button>
        </div>
      </div>
    </TeamDialogFrame>
  );
}
