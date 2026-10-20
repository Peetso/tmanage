'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Checkbox, InlineAlert, Select } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import { bulkAssignRole, type MemberBulkRoleView } from '../../lib/api/admin-member-bulk-role';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

/** One member the bar can assign a role to — named by its membership id (the id the API takes). */
export interface BulkRoleAssignMember {
  readonly membershipId: string;
  readonly displayName: string;
}

/** One assignable custom role. */
export interface BulkRoleAssignRole {
  readonly id: string;
  readonly name: string;
}

export interface BulkRoleAssignBarProps {
  organizationSlug: string;
  members: readonly BulkRoleAssignMember[];
  roles: readonly BulkRoleAssignRole[];
  client?: ApiClient;
}

/**
 * **Bulk role-assign bar (Administration module 18, x222).**
 *
 * `22-SCREEN-BY-SCREEN` §Administration (members). A distinct file from x195's role edit screen: this bar
 * assigns one existing custom role to a **batch** of members at once, the flow the audit named absent
 * after assignment was built one-at-a-time. It is a faithful reader of the API — the roles it offers are
 * the ones passed in, and every rule that matters (a caller may not hand out a role beyond what they hold
 * themselves; a member outside this tenant is reported not-found, never written) is enforced server-side.
 * The bar only carries the request and renders the per-id outcome the API returns; it never decides who
 * may be assigned what.
 */
export function BulkRoleAssignBar({
  organizationSlug,
  members,
  roles,
  client,
}: BulkRoleAssignBarProps) {
  const api = client ?? browserApiClient();
  const t = useT();

  const [roleId, setRoleId] = useState<string>(roles[0]?.id ?? '');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const membershipIds = useMemo(() => [...selected], [selected]);

  const assign = useMutation<MemberBulkRoleView>({
    mutationFn: () => bulkAssignRole(api, organizationSlug, { roleId, membershipIds }),
    onSuccess: () => setSelected(new Set()),
  });

  function toggle(membershipId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(membershipId)) next.delete(membershipId);
      else next.add(membershipId);
      return next;
    });
  }

  const assignedCount =
    assign.data?.assignments.filter((a) => a.outcome === 'assigned').length ?? 0;
  const notFoundCount =
    assign.data?.assignments.filter((a) => a.outcome === 'not_found').length ?? 0;
  const canSubmit = roleId !== '' && membershipIds.length > 0 && !assign.isPending;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-bulk-role-heading">
      <h2 id="tm-bulk-role-heading" className="tm-eyebrow">
        {t('BulkRoleAssignBar.heading')}
      </h2>

      {roles.length === 0 ? (
        <InlineAlert tone="neutral" title={t('BulkRoleAssignBar.noRolesTitle')}>
          {t('BulkRoleAssignBar.noRolesBody')}
        </InlineAlert>
      ) : (
        <form
          className="tm-stack"
          noValidate
          aria-label={t('BulkRoleAssignBar.heading')}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canSubmit) assign.mutate();
          }}
        >
          <Select
            label={t('BulkRoleAssignBar.roleLabel')}
            name="bulk-role"
            value={roleId}
            onChange={(event) => setRoleId(event.target.value)}
            hint={t('BulkRoleAssignBar.roleHint')}
          >
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>

          <fieldset className="tm-stack tm-fieldset">
            <legend>{t('BulkRoleAssignBar.membersLegend')}</legend>
            {members.length === 0 ? (
              <p>{t('BulkRoleAssignBar.noMembers')}</p>
            ) : (
              members.map((member) => (
                <Checkbox
                  key={member.membershipId}
                  label={member.displayName}
                  name={`member-${member.membershipId}`}
                  checked={selected.has(member.membershipId)}
                  onChange={() => toggle(member.membershipId)}
                />
              ))
            )}
          </fieldset>

          {assign.isError ? (
            <InlineAlert tone="danger" title={t('BulkRoleAssignBar.errorTitle')} live>
              {describeError(assign.error, t)}
            </InlineAlert>
          ) : null}
          {assign.isSuccess && !assign.isPending ? (
            <InlineAlert
              tone={notFoundCount > 0 ? 'neutral' : 'success'}
              title={t('BulkRoleAssignBar.successTitle')}
              live
            >
              {`${t('BulkRoleAssignBar.assignedTo')} ${assignedCount} ${assignedCount === 1 ? t('BulkRoleAssignBar.memberWord') : t('BulkRoleAssignBar.membersWord')}.`}
              {notFoundCount > 0
                ? ` ${notFoundCount} ${t('BulkRoleAssignBar.couldNotBeFound')}`
                : ''}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              disabled={!canSubmit}
              loading={assign.isPending}
              loadingLabel={t('BulkRoleAssignBar.assigningLabel')}
            >
              {t('BulkRoleAssignBar.submit')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function describeError(error: unknown, t: ReturnType<typeof useT>): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('BulkRoleAssignBar.apiNoAnswer');
  return t('BulkRoleAssignBar.genericError');
}
