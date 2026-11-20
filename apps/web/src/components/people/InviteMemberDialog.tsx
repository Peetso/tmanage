'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { issueInvitation } from '../../lib/api/invitations';
import type { IssuedInvitation } from '../../lib/api/invitations';
import { isMemberRoleChoice, listBuiltInRoles } from '../../lib/api/member-role';
import type { MemberRoleChoice } from '../../lib/api/member-role';
import { listProjects } from '../../lib/api/projects';
import { useTOr } from '../../lib/i18n/use-t-or';
import { fill, RoleChoiceCards, useCustomRoles } from './ChangeRoleDialog';

/** The API refuses a longer note (`invitations.note` is VARCHAR(500)). */
const MAX_NOTE = 500;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * **r-invite** (Figma 374:1985) — "Invite a team member".
 *
 * Email, the same four role cards as Change role (Owner only for an owner, which the API's
 * `assignable` flag says) and — F1 (Figma 389:4911) — the organization's custom roles below them, "Add to projects (optional)" — the projects the person joins when they
 * accept, nothing before — and "Personal note (optional)". Sends `POST invitations` with
 * `projectIds` and `note`.
 *
 * When the email went out the dialog closes. When it did not (no mail transport, or the transport
 * refused) the one-time link is shown to copy, because the response is the only copy of it.
 */
export function InviteMemberDialog({
  api,
  organizationSlug,
  organizationName,
  onClose,
  initialEmail = '',
}: {
  api: ApiClient;
  organizationSlug: string;
  organizationName: string;
  onClose: (issued: IssuedInvitation | null) => void;
  /** 56-26 (B1): "Check the address" opens the dialog with the stopped address to correct. */
  initialEmail?: string | undefined;
}) {
  const tr = useTOr();
  const titleId = useId();
  const groupName = useId();
  const projectsId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const [email, setEmail] = useState(initialEmail);
  const [touched, setTouched] = useState(false);
  const [role, setRole] = useState<string | null>('member');
  const [projectIds, setProjectIds] = useState<readonly string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [note, setNote] = useState('');

  const roles = useQuery({
    queryKey: ['built-in-roles', organizationSlug],
    queryFn: () => listBuiltInRoles(api, organizationSlug),
    staleTime: 60_000,
  });
  const assignable = (choice: MemberRoleChoice) =>
    roles.data?.some((entry) => entry.role === choice && entry.assignable) ?? false;
  // F1: the organization's custom roles from Control > Roles, offered under the built-in four.
  const customRoles = useCustomRoles(api, organizationSlug);
  const customList = customRoles.isSuccess
    ? customRoles.data
    : customRoles.isError
      ? []
      : undefined;
  const allowed = (choice: string) =>
    isMemberRoleChoice(choice)
      ? assignable(choice)
      : (customList?.some((entry) => entry.id === choice) ?? false);

  const projects = useQuery({
    queryKey: ['invite-projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
    staleTime: 60_000,
  });
  const liveProjects = (Array.isArray(projects.data) ? projects.data : []).filter(
    (project) => project.archivedAt === null,
  );
  const chosenNames = liveProjects
    .filter((project) => projectIds.includes(project.id))
    .map((project) => project.name)
    .join(', ');

  const send = useMutation({
    mutationFn: () =>
      issueInvitation(api, organizationSlug, {
        email: email.trim(),
        role: role ?? 'member',
        projectIds,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: (issued) => {
      if (issued.delivery === 'sent') onClose(issued);
    },
  });

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('input')?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (pickerOpen) setPickerOpen(false);
      else onClose(send.data ?? null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, pickerOpen, send.data]);

  const emailInvalid = !EMAIL_SHAPE.test(email.trim());

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (emailInvalid || role === null || !allowed(role) || send.isPending) return;
    send.mutate();
  }

  function toggleProject(id: string) {
    setProjectIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  function errorText(error: unknown): string {
    if (error instanceof ApiRequestError) {
      // QA-FIX-P M7: the address already belongs to a member (the owner's own included).
      if (
        error.status === 409 &&
        error.details.some((detail) => detail.message === 'invitation_already_member')
      ) {
        return tr(
          'InviteMemberDialog.alreadyMember',
          'This person is already a member here. Change their role in the list instead.',
        );
      }
      if (error.status === 409) {
        return tr('InviteMemberDialog.duplicate', 'That address already has a pending invitation.');
      }
      if (error.status === 403) {
        return tr('InviteMemberDialog.notAllowed', "You can't invite with this role.");
      }
    }
    return tr('InviteMemberDialog.genericError', 'The invitation was not sent. Try again.');
  }

  const issued = send.data;
  const link =
    issued && issued.delivery !== 'sent' && typeof window !== 'undefined'
      ? `${window.location.origin}/invitations/${issued.token}`
      : null;

  return (
    <div className="ppl-dialog-scrim">
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="ppl-dialog"
      >
        <h2 id={titleId} className="ppl-dialog__title">
          {tr('InviteMemberDialog.title', 'Invite a team member')}
        </h2>

        {link && issued ? (
          <div className="ppl-dialog__form">
            <InlineAlert
              tone="warning"
              title={tr('InviteMemberDialog.linkTitle', 'Invitation created')}
              live
            >
              {fill(
                tr(
                  'InviteMemberDialog.linkBody',
                  'The email could not be sent. Copy this link and send it to {email} yourself.',
                ),
                { email: issued.invitation.email },
              )}
            </InlineAlert>
            <Field
              label={tr('InviteMemberDialog.linkLabel', 'Invitation link')}
              value={link}
              readOnly
              dir="ltr"
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="ppl-dialog__actions">
              <Button type="button" tone="ink" onClick={() => onClose(issued)}>
                {tr('InviteMemberDialog.done', 'Done')}
              </Button>
            </div>
          </div>
        ) : (
          <form className="ppl-dialog__form" onSubmit={submit} noValidate>
            <p className="ppl-dialog__lede">
              {fill(tr('InviteMemberDialog.lede', 'They join {org} with the role you choose.'), {
                org: organizationName,
              })}
            </p>

            <Field
              label={tr('InviteMemberDialog.email', 'Email')}
              type="email"
              autoComplete="off"
              dir="ltr"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onBlur={() => setTouched(true)}
              error={
                touched && emailInvalid
                  ? tr('InviteMemberDialog.emailError', 'Enter an email address.')
                  : undefined
              }
              required
            />

            <div className="ppl-dialog__group">
              <p className="ppl-dialog__label" aria-hidden="true">
                {tr('InviteMemberDialog.role', 'Role')}
              </p>
              <RoleChoiceCards
                name={groupName}
                legend={tr('InviteMemberDialog.role', 'Role')}
                value={role}
                onChange={setRole}
                assignable={assignable}
                organizationName={organizationName}
                customRoles={customList}
                createRoleHref={`/${encodeURIComponent(organizationSlug)}/admin/roles`}
              />
              <p className="ppl-dialog__hint">
                {tr('InviteMemberDialog.ownerHint', 'Only an owner can invite another owner.')}
              </p>
            </div>

            <div className="ppl-dialog__group ppl-picker">
              <p className="ppl-dialog__label" id={`${projectsId}-label`}>
                {tr('InviteMemberDialog.projects', 'Add to projects (optional)')}
              </p>
              <button
                type="button"
                className="ppl-picker__field"
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                aria-labelledby={`${projectsId}-label ${projectsId}-value`}
                onClick={() => setPickerOpen((open) => !open)}
              >
                <span
                  id={`${projectsId}-value`}
                  className={chosenNames === '' ? 'ppl-picker__placeholder' : undefined}
                >
                  {chosenNames === ''
                    ? tr('InviteMemberDialog.projectsPlaceholder', 'Choose projects')
                    : chosenNames}
                </span>
              </button>
              {pickerOpen ? (
                <ul
                  className="ppl-picker__list"
                  role="listbox"
                  aria-multiselectable="true"
                  aria-labelledby={`${projectsId}-label`}
                >
                  {liveProjects.length === 0 ? (
                    <li className="ppl-picker__empty" role="presentation">
                      {tr('InviteMemberDialog.projectsEmpty', 'No projects yet.')}
                    </li>
                  ) : (
                    liveProjects.map((project) => {
                      const selected = projectIds.includes(project.id);
                      return (
                        <li
                          key={project.id}
                          role="option"
                          aria-selected={selected}
                          tabIndex={0}
                          className="ppl-picker__option"
                          onClick={() => toggleProject(project.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              toggleProject(project.id);
                            }
                          }}
                        >
                          <span className="ppl-picker__check" aria-hidden="true">
                            {selected ? '✓' : ''}
                          </span>
                          {project.name}
                        </li>
                      );
                    })
                  )}
                </ul>
              ) : null}
            </div>

            <Field
              label={tr('InviteMemberDialog.note', 'Personal note (optional)')}
              placeholder={tr('InviteMemberDialog.notePlaceholder', 'Add a short welcome message')}
              value={note}
              maxLength={MAX_NOTE}
              onChange={(event) => setNote(event.target.value)}
            />

            {send.isError ? (
              <InlineAlert tone="danger" live>
                {errorText(send.error)}
              </InlineAlert>
            ) : null}

            <div className="ppl-dialog__actions">
              <Button type="button" tone="outline" onClick={() => onClose(null)}>
                {tr('InviteMemberDialog.cancel', 'Cancel')}
              </Button>
              <Button
                type="submit"
                tone="ink"
                loading={send.isPending}
                loadingLabel={tr('InviteMemberDialog.sending', 'Sending…')}
              >
                {tr('InviteMemberDialog.send', 'Send invitation')}
              </Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
