'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert } from '@tmanage/ui';
import { createClientOrganization } from '../../lib/api/clients';
import type { ClientOrganization } from '../../lib/api/clients';
import { issueInvitation } from '../../lib/api/invitations';
import type { IssuedInvitation } from '../../lib/api/invitations';
import { listProjects } from '../../lib/api/projects';
import type { ApiClient } from '../../lib/api/client';
import { describePeopleError } from '../screens/peopleShared';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import type { MessageKey } from '../../lib/i18n/t';
import { MoreOptions, useMyUserId } from '../forms/MoreOptions';
import { useFormCheck } from '../../lib/forms/form-check';

/** The Clients keys arrive with the i18n-Q1 fragment; cast until it is merged into en.json. */
export type ClientsKey = `Clients.${string}`;

export function useClientsT(): (key: ClientsKey, vars?: Record<string, string | number>) => string {
  const t = useT();
  return (key, vars) => {
    let text = t(key as MessageKey);
    for (const [name, value] of Object.entries(vars ?? {})) {
      text = text.replace(`{${name}}`, String(value));
    }
    return text;
  };
}

export interface InviteClientDialogProps {
  api: ApiClient;
  organizationSlug: string;
  /** The active client companies, offered by name. */
  organizations: readonly ClientOrganization[];
  onClose: () => void;
  /** May return a promise (the list refresh); the dialog keeps "Sending" until it settles. */
  onIssued: (issued: IssuedInvitation) => void | Promise<unknown>;
  /** Prefills the company — "Invite person" on a client company's own page. */
  initialCompanyName?: string;
  /** 56-26 (B1): "Check the address" opens the dialog with the stopped address to correct. */
  initialEmail?: string;
}

type ClientRole = 'client_reviewer' | 'client_admin';

/**
 * **Invite a client** (Q1, Figma t5-b 370:3886 EN / 370:4207 AR).
 *
 * Email, the client company (an existing name, or a new one typed in — created first with
 * `POST client-organizations`), the role as two single-choice checkboxes, and the projects to share.
 * R38 G4 (Figma "R38 G4-invite-projects"): the projects are a searchable multi-select whose ids travel
 * on the invitation (`projectIds`); the API shares each one with the company when the person accepts,
 * not before. Sending issues `POST /invitations {email, role, clientOrganizationId, projectIds}`. The
 * personal note (optional, at most 500
 * characters) travels with the invitation as `note` — the 2026-10-31 live test found it drawn as a
 * disabled "coming soon" field although the invitation API already carries it (A1).
 */
export function InviteClientDialog({
  api,
  organizationSlug,
  organizations,
  onClose,
  onIssued,
  initialCompanyName = '',
  initialEmail = '',
}: InviteClientDialogProps) {
  const t = useClientsT();
  const tr = useTOr();
  const myUserId = useMyUserId(api, organizationSlug);
  const titleId = useId();
  const listId = useId();
  const projectsHintId = useId();

  const [email, setEmail] = useState(initialEmail);
  const [companyName, setCompanyName] = useState(initialCompanyName);
  const [note, setNote] = useState('');
  const [role, setRole] = useState<ClientRole>('client_reviewer');
  const [projectIds, setProjectIds] = useState<readonly string[]>([]);
  const [projectQuery, setProjectQuery] = useState('');

  const projects = useQuery({
    queryKey: ['clients', organizationSlug, 'projects'],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const projectList = useMemo(
    () =>
      (Array.isArray(projects.data) ? projects.data : []).filter(
        (project) => project.archivedAt === null,
      ),
    [projects.data],
  );
  const shownProjects = filterProjects(projectList, projectQuery);
  const chosenProjects = projectList.filter((project) => projectIds.includes(project.id));
  const toggleProject = (id: string) =>
    setProjectIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  const send = useMutation({
    mutationFn: async () => {
      const name = companyName.trim();
      const existing = organizations.find(
        (company) => company.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      );
      const companyId = existing
        ? existing.id
        : (await createClientOrganization(api, organizationSlug, name)).id;
      const issued = await issueInvitation(api, organizationSlug, {
        email: email.trim(),
        role,
        clientOrganizationId: companyId,
        ...(projectIds.length > 0 ? { projectIds } : {}),
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
      });
      return issued;
    },
    onSuccess: (issued) => onIssued(issued),
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canSend = email.trim() !== '' && companyName.trim() !== '' && !send.isPending;
  // QA-FIX-S M2: the address is checked here, in the app's words, before a company is created.
  const check = useFormCheck();

  return (
    <div className="tm-command-palette__backdrop cl-backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="cl-dialog">
        <h2 id={titleId} className="cl-dialog__title">
          {t('Clients.dialogTitle')}
        </h2>
        <p className="cl-dialog__lead">{t('Clients.dialogLead')}</p>

        <form
          noValidate
          className="cl-dialog__form"
          {...check.handlers(() => {
            if (canSend) send.mutate();
          })}
        >
          <Field
            label={t('Clients.emailLabel')}
            type="email"
            name="email"
            error={check.error('email')}
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          <Field
            label={t('Clients.orgLabel')}
            hint={t('Clients.orgHint')}
            list={listId}
            autoComplete="off"
            name="company"
            error={check.error('company')}
            value={companyName}
            onChange={(event) => setCompanyName(event.target.value)}
            required
          />
          <datalist id={listId}>
            {organizations.map((company) => (
              <option key={company.id} value={company.name} />
            ))}
          </datalist>

          <fieldset className="tm-fieldset cl-projects" aria-describedby={projectsHintId}>
            <legend className="tm-field__label">
              {tr('Clients.projectsOptionalLabel', 'Projects to share (optional)')}
            </legend>
            <Field
              label={tr('Clients.projectsSearchLabel', 'Search projects')}
              type="search"
              autoComplete="off"
              placeholder={tr('Clients.projectsSearchPlaceholder', 'Type a project name')}
              value={projectQuery}
              onChange={(event) => setProjectQuery(event.target.value)}
              disabled={projects.isPending}
            />
            {chosenProjects.length > 0 ? (
              <ul
                className="cl-projects__chips"
                aria-label={tr('Clients.projectsChosen', 'Chosen projects')}
              >
                {chosenProjects.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className="cl-projects__chip"
                      aria-label={tr('Clients.projectsRemove', 'Remove {name}').replace(
                        '{name}',
                        project.name,
                      )}
                      onClick={() => toggleProject(project.id)}
                    >
                      {project.name}
                      <span aria-hidden="true"> ×</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="cl-projects__list">
              {shownProjects.length === 0 ? (
                <p className="cl-projects__empty">
                  {projectList.length === 0
                    ? t('Clients.projectsNone')
                    : tr('Clients.projectsNoMatch', 'No project matches that search.')}
                </p>
              ) : (
                shownProjects.map((project) => (
                  <Checkbox
                    key={project.id}
                    label={project.name}
                    checked={projectIds.includes(project.id)}
                    onChange={() => toggleProject(project.id)}
                  />
                ))
              )}
            </div>
            <p id={projectsHintId} className="cl-projects__hint">
              {tr(
                'Clients.projectsHint',
                'Each chosen project is shared with the client company when they accept.',
              )}
            </p>
          </fieldset>

          {/* 55-08: email, company and projects first; the role (reviewer by default) and the
              personal note sit behind "More options". */}
          <MoreOptions
            form="client"
            userId={myUserId}
            hint={tr('MoreOptions.clientHint', 'Role, personal note')}
          >
            <fieldset className="tm-fieldset cl-dialog__roles">
              <legend className="tm-field__label">{t('Clients.roleLabel')}</legend>
              <Checkbox
                label={t('Clients.roleReviewerOption')}
                checked={role === 'client_reviewer'}
                onChange={() => setRole('client_reviewer')}
              />
              <Checkbox
                label={t('Clients.roleAdminOption')}
                checked={role === 'client_admin'}
                onChange={() => setRole('client_admin')}
              />
            </fieldset>

            <Field
              label={t('Clients.noteLabel')}
              placeholder={t('Clients.notePlaceholder')}
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
            />
          </MoreOptions>

          {send.isError ? (
            <InlineAlert tone="danger" title={t('Clients.sendFailed')} live>
              {describePeopleError(send.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row tm-row--end">
            <Button type="button" tone="outline" size="accessible" onClick={onClose}>
              {t('Clients.cancel')}
            </Button>
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              disabled={!canSend}
              loading={send.isPending}
              loadingLabel={t('Clients.sending')}
            >
              {t('Clients.send')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** R38 G4: the projects whose name contains the search, case- and accent-insensitively. */
export function filterProjects<T extends { readonly name: string }>(
  projects: readonly T[],
  query: string,
): readonly T[] {
  const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  const needle = fold(query.trim());
  if (needle === '') return projects;
  return projects.filter((project) => fold(project.name).includes(needle));
}

/**
 * The one-time invitation link, shown when the email did not go out (`delivery !== 'sent'`). The
 * token exists nowhere else — the server keeps only its hash — so this is the issuer's only copy.
 */
export function IssuedLinkNotice({
  issued,
  onDone,
}: {
  issued: IssuedInvitation;
  onDone: () => void;
}) {
  const t = useClientsT();
  const linkId = useId();
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const link = `${origin}/invitations/${encodeURIComponent(issued.token)}`;

  return (
    <InlineAlert tone="client" title={t('Clients.linkTitle')} live>
      <span className="cl-link">
        <span>{t('Clients.linkBody')}</span>
        <label className="tm-field__label" htmlFor={linkId}>
          {t('Clients.linkLabel')}
        </label>
        <input
          id={linkId}
          className="tm-field__control cl-break"
          readOnly
          value={link}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button tone="outline" size="compact" onClick={onDone}>
          {t('Clients.done')}
        </Button>
      </span>
    </InlineAlert>
  );
}
