'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AppShell } from '../../../../../components/shell/AppShell';
import { browserApiClient } from '../../../../../lib/api/browser-client';
import { groupKeys, joinGroupInvite, previewGroupInvite } from '../../../../../lib/api/chat-groups';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';
import { useTOr } from '../../../../../lib/i18n/use-t-or';
import '../../../../../components/chat/groups.css';

/**
 * R7 slice 3 — a group invite link opened by a team member: the group's name and member count,
 * and Join. A client contact is refused by the API (clients are added by an admin, never by link).
 */
export default function GroupInvitePage({
  params,
}: {
  params: Promise<{ orgSlug: string; token: string }>;
}) {
  const { orgSlug, token } = use(params);
  const tOr = useTOr();
  const router = useRouter();
  const api = browserApiClient();
  const preview = useQuery({
    queryKey: groupKeys.invite(orgSlug, token),
    queryFn: () => previewGroupInvite(api, orgSlug, token),
    retry: false,
  });
  const join = useMutation({
    mutationFn: () => joinGroupInvite(api, orgSlug, token),
    onSuccess: (id) => router.push(`/${orgSlug}/chat/${encodeURIComponent(id)}`),
  });
  const group = preview.data;

  return (
    <AppShell
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      activeNavigationId="chat"
      title={tOr('ChatGroups.inviteTitle', 'Group invite')}
    >
      <section className="tm-chatgroup-sheet" aria-busy={preview.isPending}>
        {preview.isError ? (
          <p className="tm-chatgroup__error" role="alert">
            {tOr('ChatGroups.inviteInvalid', 'This invite link is no longer valid.')}
          </p>
        ) : null}
        {group ? (
          <>
            <h2 className="tm-chatgroup-sheet__title">{group.name}</h2>
            <p className="tm-chatgroup__hint">
              {tOr('ChatGroups.memberCount', 'Group · {count} members').replace(
                '{count}',
                String(group.memberCount),
              )}
            </p>
            <div className="tm-chatgroup-sheet__actions">
              <button
                type="button"
                className="tm-chatgroup__btn tm-chatgroup__btn--primary"
                disabled={join.isPending}
                onClick={() => join.mutate()}
              >
                {group.alreadyMember
                  ? tOr('ChatGroups.openGroup', 'Open group')
                  : tOr('ChatGroups.join', 'Join group')}
              </button>
            </div>
          </>
        ) : null}
      </section>
    </AppShell>
  );
}
