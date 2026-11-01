'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPendingInvitations, revokeInvitation } from '../../lib/api/admin-invitations';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { describeInternalRole } from '../../lib/roles';
import { useT } from '../../lib/i18n/use-t';
import { appLocale } from '../../lib/i18n/app-locale';

export interface AdminInvitationsViewProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Admin pending-invitation management** — Administration module 18 (x328; 22-SCREEN §Administration
 * members). It reads `GET …/admin/invitations` (gated on the server by `org.manage`) and lists the
 * organization's pending invitations, each with a Revoke action (`POST …/admin/invitations/:id/revoke`).
 *
 * The decisions are the sibling admin screens':
 * 1. **Authorization is the API's.** A caller without `org.manage` gets the ordinary 403, which
 *    `describeError` turns into a sentence in the panel's alert; the screen never guesses a capability.
 * 2. **No secret is shown.** The API returns metadata only — email, role, inviter, expiry — never the
 *    invitation token, so there is nothing here that could re-send or expose a live invitation link.
 * 3. **Revoke, not resend.** Resending an invitation email needs the email provider (handled
 *    separately); this screen only withdraws a pending invitation, and the revoke is idempotent.
 */
export function AdminInvitationsView({
  organizationSlug,
  organizationName,
  client,
}: AdminInvitationsViewProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const queryKey = ['admin-invitations', organizationSlug];

  const invitations = useQuery({
    queryKey,
    queryFn: () => fetchPendingInvitations(api, organizationSlug),
  });

  const revoke = useMutation({
    mutationFn: (invitationId: string) => revokeInvitation(api, organizationSlug, invitationId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const rows = invitations.data?.invitations ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      title={t('AdminInvitationsView.title')}
      description={t('AdminInvitationsView.description')}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-admin-invitations-heading">
        <h2 id="tm-admin-invitations-heading" className="tm-eyebrow">
          {t('AdminInvitationsView.heading')}
        </h2>

        {invitations.isError ? (
          <InlineAlert tone="danger" title={t('AdminInvitationsView.loadError')} live>
            {describeError(invitations.error)}
          </InlineAlert>
        ) : null}

        {invitations.isPending ? (
          <LoadingRegion label={t('AdminInvitationsView.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!invitations.isPending && !invitations.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title={t('AdminInvitationsView.emptyTitle')}>
            {t('AdminInvitationsView.emptyBody')}
          </InlineAlert>
        ) : null}

        {revoke.isError ? (
          <InlineAlert tone="danger" title={t('AdminInvitationsView.revokeError')} live>
            {describeError(revoke.error)}
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <ul className="tm-stack" aria-label={t('AdminInvitationsView.listLabel')}>
            {rows.map((invitation) => (
              <li key={invitation.id} className="tm-row">
                <strong>{invitation.email}</strong>
                <span className="tm-muted">{describeInternalRole(invitation.role).label}</span>
                <span>
                  {t('AdminInvitationsView.invitedByPrefix')} {invitation.invitedByName}
                </span>
                <span>
                  {t('AdminInvitationsView.expiresPrefix')} {formatMoment(invitation.expiresAt)}
                </span>
                {invitation.isExpired ? (
                  <Badge>{t('AdminInvitationsView.expiredBadge')}</Badge>
                ) : null}
                <Button
                  type="button"
                  tone="ink"
                  size="accessible"
                  loading={revoke.isPending && revoke.variables === invitation.id}
                  loadingLabel={t('AdminInvitationsView.revoking')}
                  onClick={() => {
                    if (!revoke.isPending) revoke.mutate(invitation.id);
                  }}
                >
                  {t('AdminInvitationsView.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </AppShell>
  );
}

/** Format an ISO timestamp following the browser's locale; an unparseable value is shown verbatim. */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(appLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    at,
  );
}
