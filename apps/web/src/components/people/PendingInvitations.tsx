'use client';

import { Fragment, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { reissueInvitation, revokeInvitation } from '../../lib/api/admin-invitations';
import type { AdminInvitationsView } from '../../lib/api/admin-invitations';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { IssuedInvitation } from '../../lib/api/invitations';
import { isMemberRoleChoice, listBuiltInRoles } from '../../lib/api/member-role';
import type { MemberRoleChoice } from '../../lib/api/member-role';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { fill, RoleChoiceCards, useCustomRoles } from './ChangeRoleDialog';
import { NotDeliveredChip, StoppedInvitationNotice } from './StoppedInvitationNotice';
import type { CustomRoleOption } from './ChangeRoleDialog';

/**
 * Pending invitations on Members and roles — Figma "People · Members with pending invitations
 * (2026-10-31 live-test fix)" (446:35593), with "Revoke invitation — confirm" (446:35821) and
 * "Change invitation role" (446:35866).
 *
 * The live test found invitations counted in the header but listed nowhere, with no way to revoke
 * one or change its role. Each row now shows the address, when it was sent, the role offered (a chip
 * that opens Change invitation role), who invited them, when it expires, and a menu: Change role,
 * Resend invitation, and the red Revoke invitation. A role change and a resend are both the API's
 * re-issue (`POST invitations/:id/reissues`): the old link stops working and a new one is mailed.
 */

export type PendingInvitation = AdminInvitationsView['invitations'][number];

/**
 * R38 G4: the names of the projects an invitation is tagged with, joined for its row ("" for none).
 * Tolerates a row from an API that predates the field.
 */
export function invitationProjectNames(invitation: {
  readonly projects?: readonly { readonly name: string }[];
}): string {
  return (invitation.projects ?? []).map((project) => project.name).join(', ');
}

/** "HN" for hana@northstar.studio: the first letter of the name and of the domain. */
export function initialsOfEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const letters = `${local.charAt(0)}${domain.charAt(0)}`.toUpperCase();
  return letters === '' ? '@' : letters;
}

function useShortDate(): (iso: string | undefined) => string {
  const locale = useActiveLocale();
  return (iso) => {
    const at = iso ? new Date(iso) : null;
    if (!at || Number.isNaN(at.getTime())) return '—';
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(at);
  };
}

export function PendingInvitationsSection({
  api,
  organizationSlug,
  invitations,
  roleLabel,
  onChangeRole,
  onResend,
  onRevoke,
  onCheckAddress,
  busyId,
}: {
  api: ApiClient;
  organizationSlug: string;
  invitations: readonly PendingInvitation[];
  roleLabel: (role: string) => string;
  onChangeRole: (invitation: PendingInvitation) => void;
  onResend: (invitation: PendingInvitation) => void;
  onRevoke: (invitation: PendingInvitation) => void;
  /** 56-26 (B1): "Check the address" on a stopped invitation — the invite path, address filled in. */
  onCheckAddress: (invitation: PendingInvitation) => void;
  /** The invitation a resend is running for; its menu stays closed and its row reads busy. */
  busyId: string | null;
}) {
  const tr = useTOr();
  const headingId = useId();
  if (invitations.length === 0) return null;
  return (
    <section className="ppl-invites" aria-labelledby={headingId}>
      <h2 id={headingId} className="ppl-mono ppl-invites__eyebrow">
        {fill(tr('PendingInvitations.eyebrow', 'Invitations waiting · {count}'), {
          count: String(invitations.length),
        })}
      </h2>
      <div className="ppl-members-card">
        <table className="ppl-members" aria-labelledby={headingId}>
          <thead>
            <tr>
              <th scope="col">{tr('PendingInvitations.colEmail', 'Email')}</th>
              <th scope="col">{tr('PendingInvitations.colRole', 'Role')}</th>
              <th scope="col">{tr('PendingInvitations.colInvitedBy', 'Invited by')}</th>
              <th scope="col">{tr('PendingInvitations.colExpires', 'Expires')}</th>
              <th scope="col">
                <span className="tm-visually-hidden">
                  {tr('PeopleDirectoryScreen.membersColActions', 'Actions')}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invitations.map((invitation) => (
              <Fragment key={invitation.id}>
                <InvitationRow
                  invitation={invitation}
                  roleLabel={roleLabel(invitation.role)}
                  busy={busyId === invitation.id}
                  onChangeRole={() => onChangeRole(invitation)}
                  onResend={() => onResend(invitation)}
                  onRevoke={() => onRevoke(invitation)}
                />
                {invitation.deliveryStopped ? (
                  <tr className="ppl-member ppl-member--stopped">
                    <td colSpan={5}>
                      <StoppedInvitationNotice
                        api={api}
                        organizationSlug={organizationSlug}
                        email={invitation.email}
                        busy={busyId === invitation.id}
                        onCheckAddress={() => onCheckAddress(invitation)}
                        onResend={() => onResend(invitation)}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function InvitationRow({
  invitation,
  roleLabel,
  busy,
  onChangeRole,
  onResend,
  onRevoke,
}: {
  invitation: PendingInvitation;
  roleLabel: string;
  busy: boolean;
  onChangeRole: () => void;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const tr = useTOr();
  const shortDate = useShortDate();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <tr className="ppl-member" aria-busy={busy || undefined}>
      <td>
        <span className="ppl-member__who">
          <span className="ppl-avatar ppl-avatar--40" aria-hidden="true">
            {initialsOfEmail(invitation.email)}
          </span>
          <span>
            <span className="ppl-member__name" dir="ltr">
              {invitation.email}
            </span>
            {invitation.deliveryStopped ? <NotDeliveredChip /> : null}
            <span className="ppl-member__email">
              {fill(tr('PendingInvitations.sent', 'Sent {date}'), {
                date: shortDate(invitation.createdAt),
              })}
            </span>
            {invitationProjectNames(invitation) !== '' ? (
              <span className="ppl-member__email">
                {fill(tr('PendingInvitations.projects', 'Projects: {names}'), {
                  names: invitationProjectNames(invitation),
                })}
              </span>
            ) : null}
          </span>
        </span>
      </td>
      <td>
        <button
          type="button"
          className="ppl-role-chip"
          aria-label={fill(
            tr('PendingInvitations.roleChip', 'Role offered to {email}: {role}. Change role'),
            { email: invitation.email, role: roleLabel },
          )}
          onClick={onChangeRole}
        >
          {roleLabel}
          <span className="ppl-role-chip__caret" aria-hidden="true" />
        </button>
      </td>
      <td className="ppl-member__cell">{invitation.invitedByName ?? '—'}</td>
      <td className="ppl-member__cell">
        {invitation.isExpired
          ? tr('PendingInvitations.expired', 'Expired')
          : shortDate(invitation.expiresAt)}
      </td>
      <td className="ppl-member__actions">
        <button
          ref={triggerRef}
          type="button"
          className="ppl-kebab"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={busy}
          aria-label={fill(tr('PendingInvitations.rowActions', 'Actions for {email}'), {
            email: invitation.email,
          })}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true">•••</span>
        </button>
        {open ? (
          <ul ref={menuRef} id={menuId} role="menu" className="ppl-row-menu">
            <li role="none">
              <button
                type="button"
                role="menuitem"
                className="ppl-row-menu__item"
                onClick={choose(onChangeRole)}
              >
                {tr('PeopleDirectoryScreen.menuChangeRole', 'Change role')}
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                className="ppl-row-menu__item"
                onClick={choose(onResend)}
              >
                {tr('PendingInvitations.menuResend', 'Resend invitation')}
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                className="ppl-row-menu__item ppl-row-menu__item--danger"
                onClick={choose(onRevoke)}
              >
                {tr('PendingInvitations.menuRevoke', 'Revoke invitation')}
              </button>
            </li>
          </ul>
        ) : null}
      </td>
    </tr>
  );
}

/** Shared dialog chrome: focus the first control on open, close on Escape. */
function useDialogChrome(onClose: () => void) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('input:not([disabled]), button')?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return panelRef;
}

function InvitationCard({ invitation, detail }: { invitation: PendingInvitation; detail: string }) {
  return (
    <div className="ppl-current">
      <span className="ppl-avatar ppl-avatar--40" aria-hidden="true">
        {initialsOfEmail(invitation.email)}
      </span>
      <span>
        <span className="ppl-current__name" dir="ltr">
          {invitation.email}
        </span>
        <span className="ppl-current__role">{detail}</span>
      </span>
    </div>
  );
}

/** Figma 446:35821 — "Revoke invitation?" with the red confirm. */
export function RevokeInvitationDialog({
  api,
  organizationSlug,
  invitation,
  roleLabel,
  onClose,
}: {
  api: ApiClient;
  organizationSlug: string;
  invitation: PendingInvitation;
  roleLabel: string;
  onClose: (revoked: boolean) => void;
}) {
  const tr = useTOr();
  const shortDate = useShortDate();
  const describeError = useDescribeApiError();
  const titleId = useId();
  const panelRef = useDialogChrome(() => onClose(false));
  const revoke = useMutation({
    mutationFn: () => revokeInvitation(api, organizationSlug, invitation.id),
    onSuccess: () => onClose(true),
  });

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
          {tr('PendingInvitations.revokeTitle', 'Revoke invitation?')}
        </h2>
        <div className="ppl-dialog__form">
          <p className="ppl-dialog__lede">
            {fill(
              tr(
                'PendingInvitations.revokeLede',
                '{email} can no longer join with the link we sent. You can invite them again at any time.',
              ),
              { email: invitation.email },
            )}
          </p>
          <InvitationCard
            invitation={invitation}
            detail={fill(
              tr('PendingInvitations.revokeDetail', 'Invited as {role} · expires {date}'),
              { role: roleLabel, date: shortDate(invitation.expiresAt) },
            )}
          />
          <p className="ppl-dialog__hint">
            {tr(
              'PendingInvitations.revokeHint',
              'Nothing else changes. The audit log records who revoked it.',
            )}
          </p>
          {revoke.isError ? (
            <InlineAlert tone="danger" live>
              {describeError(revoke.error)}
            </InlineAlert>
          ) : null}
          <div className="ppl-dialog__actions">
            <Button type="button" tone="outline" onClick={() => onClose(false)}>
              {tr('InviteMemberDialog.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              tone="destructive"
              loading={revoke.isPending}
              loadingLabel={tr('PendingInvitations.revoking', 'Revoking…')}
              onClick={() => {
                if (!revoke.isPending) revoke.mutate();
              }}
            >
              {tr('PendingInvitations.revokeConfirm', 'Revoke invitation')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

/** Figma 446:35866 — "Change invitation role": the role cards, then "Send new invitation". */
export function ChangeInvitationRoleDialog({
  api,
  organizationSlug,
  organizationName,
  invitation,
  roleLabel,
  onClose,
}: {
  api: ApiClient;
  organizationSlug: string;
  organizationName: string;
  invitation: PendingInvitation;
  roleLabel: string;
  onClose: (issued: IssuedInvitation | null) => void;
}) {
  const tr = useTOr();
  const describeError = useDescribeApiError();
  const titleId = useId();
  const groupName = useId();
  const panelRef = useDialogChrome(() => onClose(null));
  const customRoles = useCustomRoles(api, organizationSlug);
  const customList: readonly CustomRoleOption[] | undefined = customRoles.isSuccess
    ? customRoles.data
    : customRoles.isError
      ? []
      : undefined;
  const [picked, setPicked] = useState<string | null>(null);
  const choice = picked ?? invitation.role;

  const roles = useQuery({
    queryKey: ['built-in-roles', organizationSlug],
    queryFn: () => listBuiltInRoles(api, organizationSlug),
    staleTime: 60_000,
  });
  const assignable = (role: MemberRoleChoice) =>
    roles.data?.some((entry) => entry.role === role && entry.assignable) ?? false;
  const isCustom = (role: string) => customList?.some((entry) => entry.id === role) ?? false;

  const reissue = useMutation({
    mutationFn: (role: string) => reissueInvitation(api, organizationSlug, invitation.id, role),
    onSuccess: (issued) => onClose(issued),
  });

  const canConfirm =
    choice !== invitation.role &&
    (isMemberRoleChoice(choice) ? assignable(choice) : isCustom(choice)) &&
    !reissue.isPending;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canConfirm) reissue.mutate(choice);
  }

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
          {tr('PendingInvitations.changeTitle', 'Change invitation role')}
        </h2>
        <form className="ppl-dialog__form" onSubmit={submit} noValidate>
          <p className="ppl-dialog__lede">
            {fill(
              tr(
                'PendingInvitations.changeLede',
                'Pick a new role for {email}. We send a new invitation with this role and the old link stops working.',
              ),
              { email: invitation.email },
            )}
          </p>
          <InvitationCard
            invitation={invitation}
            detail={fill(tr('PendingInvitations.changeCurrent', 'Invited as: {role}'), {
              role: roleLabel,
            })}
          />
          {roles.isPending ? (
            <LoadingRegion label={tr('ChangeRoleDialog.rolesLoading', 'Loading roles')}>
              <Skeleton height="64px" />
              <Skeleton height="64px" />
            </LoadingRegion>
          ) : (
            <RoleChoiceCards
              name={groupName}
              legend={tr('InviteMemberDialog.role', 'Role')}
              value={choice}
              onChange={setPicked}
              assignable={assignable}
              organizationName={organizationName}
              customRoles={customList}
              createRoleHref={`/${encodeURIComponent(organizationSlug)}/admin/roles`}
            />
          )}
          <p className="ppl-dialog__hint">
            {tr('PendingInvitations.changeHint', 'The new invitation is valid for 14 days.')}
          </p>
          {reissue.isError ? (
            <InlineAlert tone="danger" live>
              {describeError(reissue.error)}
            </InlineAlert>
          ) : null}
          <div className="ppl-dialog__actions">
            <Button type="button" tone="outline" onClick={() => onClose(null)}>
              {tr('InviteMemberDialog.cancel', 'Cancel')}
            </Button>
            <Button
              type="submit"
              tone="ink"
              disabled={!canConfirm}
              loading={reissue.isPending}
              loadingLabel={tr('InviteMemberDialog.sending', 'Sending…')}
            >
              {tr('PendingInvitations.changeConfirm', 'Send new invitation')}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

/**
 * The re-issued invitation's one-time link, when the email did not go out — the same
 * "Invitation created" state Invite a team member draws (r-invite), because the response is the only
 * copy of the link.
 */
export function InvitationLinkDialog({
  issued,
  onClose,
}: {
  issued: IssuedInvitation;
  onClose: () => void;
}) {
  const tr = useTOr();
  const titleId = useId();
  const panelRef = useDialogChrome(onClose);
  const link =
    typeof window !== 'undefined' ? `${window.location.origin}/invitations/${issued.token}` : '';
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
            <Button type="button" tone="ink" onClick={onClose}>
              {tr('InviteMemberDialog.done', 'Done')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
