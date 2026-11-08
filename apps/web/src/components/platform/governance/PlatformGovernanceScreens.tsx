'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Select, Switch } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { listPlatformCompanies } from '../../../lib/api/platform-admin';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import {
  PLATFORM_APPROVALS_QUERY_KEY,
  PLATFORM_OWNER_NOTICES_QUERY_KEY,
  confirmPlatformAccess,
  decidePlatformApproval,
  fetchPlatformAccessReview,
  fetchPlatformApprovals,
  listPlatformOwnerNotices,
  platformAccessReviewQueryKey,
  recentQuarters,
  sendPlatformOwnerNotice,
  setPlatformTwoPersonPolicy,
} from '../../../lib/api/platform-governance';
import type {
  OwnerNoticeInput,
  PlatformAccessReviewRow,
  PlatformApprovalView,
} from '../../../lib/api/platform-governance';
import { updatePlatformAdmin } from '../../../lib/api/platform-team';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { ChipGroup } from '../settings/settings-kit';
import { PlatformGate, formatMoment } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformTable } from '../shared/PlatformTable';
import { ReasonDialog, platformErrorText } from '../shared/ReasonDialog';
import { useT } from '../../../lib/i18n/use-t';

/**
 * 56-21 (R46 L2) — Platform admin governance, as drawn in Figma section 587:33239:
 * - Approvals (`/platform/approvals`): the two-person switch and the requests waiting for a
 *   second admin (approve / reject; your own request cannot be decided by you);
 * - Owner notice (`/platform/owner-notices`): send one message to a company owner;
 * - Access review (`/platform/team/access-review`): each quarter, confirm or revoke every person
 *   on the platform team, with their rights and two-step state.
 */

type TOr = ReturnType<typeof useTOr>;
type GovernancePage = 'approvals' | 'notices' | 'review';

const NAV: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)' };
const ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--s2)',
  alignItems: 'center',
};

export function GovernanceSubNav({ active }: { active: GovernancePage }) {
  const tOr = useTOr();
  const pages: readonly { id: GovernancePage; href: string; text: string }[] = [
    {
      id: 'approvals',
      href: '/platform/approvals',
      text: tOr('PlatformGovernance.navApprovals', 'Approvals'),
    },
    {
      id: 'notices',
      href: '/platform/owner-notices',
      text: tOr('PlatformGovernance.navNotices', 'Owner notices'),
    },
    {
      id: 'review',
      href: '/platform/team/access-review',
      text: tOr('PlatformGovernance.navReview', 'Access review'),
    },
  ];
  return (
    <nav aria-label={tOr('PlatformGovernance.navLabel', 'Platform controls')} style={NAV}>
      {pages.map((page) => (
        <Link
          key={page.id}
          href={page.href}
          className={`tm-cc-pill${page.id === active ? ' tm-cc-pill--on' : ''}`}
          {...(page.id === active ? { 'aria-current': 'page' as const } : {})}
        >
          {page.text}
        </Link>
      ))}
    </nav>
  );
}

export function actionLabel(action: string, tOr: TOr): string {
  switch (action) {
    case 'company.suspend':
      return tOr('PlatformGovernance.actionSuspend', 'Suspend company');
    case 'company.delete':
      return tOr('PlatformGovernance.actionDelete', 'Delete company');
    case 'company.transfer_ownership':
      return tOr('PlatformGovernance.actionTransfer', 'Transfer ownership');
    default:
      return action;
  }
}

function statusLabel(status: PlatformApprovalView['status'], tOr: TOr): string {
  const labels: Record<PlatformApprovalView['status'], string> = {
    pending: tOr('PlatformGovernance.statusPending', 'Waiting'),
    approved: tOr('PlatformGovernance.statusApproved', 'Approved'),
    rejected: tOr('PlatformGovernance.statusRejected', 'Rejected'),
    used: tOr('PlatformGovernance.statusUsed', 'Used'),
    expired: tOr('PlatformGovernance.statusExpired', 'Expired'),
  };
  return labels[status];
}

// ── Approvals ───────────────────────────────────────────────────────────────

export function PlatformApprovalsScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  return (
    <PlatformGate
      api={api}
      section="team"
      crumbs={[
        tOr('PlatformGovernance.crumb', 'Platform controls'),
        tOr('PlatformGovernance.navApprovals', 'Approvals'),
      ]}
      title={tOr('PlatformGovernance.approvalsTitle', 'Approvals')}
      description={tOr(
        'PlatformGovernance.approvalsDescription',
        'Risky platform actions need a second platform admin to approve them before they run.',
      )}
    >
      {(me) => <ApprovalsBody api={api} me={me} />}
    </PlatformGate>
  );
}

function ApprovalsBody({ api, me }: { api: ApiClient; me: PlatformMeView }) {
  const t = useT();
  const tOr = useTOr();
  const queryClient = useQueryClient();
  const data = useQuery({
    queryKey: PLATFORM_APPROVALS_QUERY_KEY,
    queryFn: () => fetchPlatformApprovals(api),
  });
  const [policyTo, setPolicyTo] = useState<boolean | null>(null);
  const [deciding, setDeciding] = useState<{
    row: PlatformApprovalView;
    decision: 'approve' | 'reject';
  } | null>(null);
  const canPolicy = me.permissions.includes('platform.team.manage');
  const refresh = () => queryClient.invalidateQueries({ queryKey: PLATFORM_APPROVALS_QUERY_KEY });

  if (data.isPending)
    return <p className="tm-cc-note">{tOr('PlatformGovernance.loading', 'Loading…')}</p>;
  if (data.isError) {
    return (
      <InlineAlert
        tone="danger"
        title={tOr('PlatformGovernance.loadFailed', 'Could not load this page.')}
        live
      >
        {platformErrorText(data.error, t)}
      </InlineAlert>
    );
  }
  const enabled = data.data.policy.enabled;
  const pending = data.data.approvals.filter((row) => row.status === 'pending');
  const history = data.data.approvals.filter((row) => row.status !== 'pending');
  const columns = [
    {
      id: 'action',
      header: tOr('PlatformGovernance.colAction', 'Action'),
      cell: (row: PlatformApprovalView) => actionLabel(row.action, tOr),
    },
    {
      id: 'company',
      header: tOr('PlatformGovernance.colCompany', 'Company'),
      cell: (row: PlatformApprovalView) => row.targetLabel ?? row.targetId,
    },
    {
      id: 'by',
      header: tOr('PlatformGovernance.colAskedBy', 'Asked by'),
      cell: (row: PlatformApprovalView) => row.requestedByEmail ?? '—',
    },
    {
      id: 'reason',
      header: tOr('PlatformGovernance.colReason', 'Reason'),
      cell: (row: PlatformApprovalView) => row.reason,
    },
  ];

  return (
    <div className="tm-stack">
      <GovernanceSubNav active="approvals" />
      <section className="tm-cc-card tm-stack tm-stack--tight" aria-labelledby="two-person-policy">
        <h2 id="two-person-policy" className="tm-cc-card__title">
          {tOr('PlatformGovernance.policyTitle', 'Two-person approval')}
        </h2>
        <Switch
          label={
            enabled
              ? tOr('PlatformGovernance.policyOn', 'On')
              : tOr('PlatformGovernance.policyOff', 'Off')
          }
          hint={tOr(
            'PlatformGovernance.policyHelp',
            'Suspend company, delete company and transfer ownership wait for a second person.',
          )}
          checked={enabled}
          disabled={!canPolicy}
          onChange={(event) => setPolicyTo(event.target.checked)}
        />
      </section>
      <section className="tm-stack tm-stack--tight" aria-labelledby="approvals-pending">
        <h2 id="approvals-pending" className="tm-cc-card__title">
          {tOr('PlatformGovernance.pendingTitle', 'Waiting for approval')}
        </h2>
        {pending.length === 0 ? (
          <p className="tm-cc-note">
            {tOr('PlatformGovernance.pendingEmpty', 'Nothing is waiting for approval.')}
          </p>
        ) : (
          <PlatformTable<PlatformApprovalView>
            label={tOr('PlatformGovernance.pendingTitle', 'Waiting for approval')}
            rows={pending}
            rowKey={(row) => row.id}
            columns={[
              ...columns,
              {
                id: 'decide',
                header: tOr('PlatformGovernance.colDecide', 'Decision'),
                cell: (row) =>
                  row.mine ? (
                    <span className="tm-cc-note">
                      {tOr(
                        'PlatformGovernance.ownRequest',
                        'You asked for this one. Another admin must approve it.',
                      )}
                    </span>
                  ) : (
                    <div style={ROW}>
                      <Button
                        type="button"
                        tone="lime"
                        size="compact"
                        onClick={() => setDeciding({ row, decision: 'approve' })}
                      >
                        {tOr('PlatformGovernance.approve', 'Approve')}
                      </Button>
                      <Button
                        type="button"
                        tone="destructive"
                        size="compact"
                        onClick={() => setDeciding({ row, decision: 'reject' })}
                      >
                        {tOr('PlatformGovernance.reject', 'Reject')}
                      </Button>
                    </div>
                  ),
              },
            ]}
          />
        )}
      </section>
      {history.length > 0 ? (
        <PlatformTable<PlatformApprovalView>
          label={tOr('PlatformGovernance.historyTitle', 'Decided requests')}
          rows={history}
          rowKey={(row) => row.id}
          isMuted={(row) => row.status === 'expired' || row.status === 'rejected'}
          columns={[
            ...columns,
            {
              id: 'status',
              header: tOr('PlatformGovernance.colStatus', 'Status'),
              cell: (row) => statusLabel(row.status, tOr),
            },
            {
              id: 'when',
              header: tOr('PlatformGovernance.colWhen', 'When'),
              cell: (row) => formatMoment(row.decidedAt ?? row.requestedAt),
            },
          ]}
        />
      ) : null}
      {policyTo !== null ? (
        <ReasonDialog
          title={
            policyTo
              ? tOr('PlatformGovernance.policyTurnOn', 'Turn on two-person approval?')
              : tOr('PlatformGovernance.policyTurnOff', 'Turn off two-person approval?')
          }
          reasonRequired
          destructive={!policyTo}
          confirmLabel={
            policyTo
              ? tOr('PlatformGovernance.turnOn', 'Turn on')
              : tOr('PlatformGovernance.turnOff', 'Turn off')
          }
          onConfirm={(reason) => setPlatformTwoPersonPolicy(api, policyTo, reason ?? '')}
          onClose={(done) => {
            setPolicyTo(null);
            if (done) void refresh();
          }}
        />
      ) : null}
      {deciding !== null ? (
        <ReasonDialog
          title={`${deciding.decision === 'approve' ? tOr('PlatformGovernance.approve', 'Approve') : tOr('PlatformGovernance.reject', 'Reject')}: ${actionLabel(deciding.row.action, tOr)} · ${deciding.row.targetLabel ?? deciding.row.targetId}`}
          body={deciding.row.reason}
          reasonRequired={false}
          destructive={deciding.decision === 'reject'}
          confirmLabel={
            deciding.decision === 'approve'
              ? tOr('PlatformGovernance.approve', 'Approve')
              : tOr('PlatformGovernance.reject', 'Reject')
          }
          onConfirm={(note) =>
            decidePlatformApproval(api, deciding.row.id, deciding.decision, note)
          }
          onClose={(done) => {
            setDeciding(null);
            if (done) void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

// ── Owner notices ───────────────────────────────────────────────────────────

type Severity = OwnerNoticeInput['severity'];

export function PlatformOwnerNoticesScreen({
  client,
  organizationId,
}: ScreenProps & { organizationId?: string }) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  return (
    <PlatformGate
      api={api}
      section="organizations"
      crumbs={[
        tOr('PlatformGovernance.crumb', 'Platform controls'),
        tOr('PlatformGovernance.navNotices', 'Owner notices'),
      ]}
      title={tOr('PlatformGovernance.noticeTitle', 'Notice to a company owner')}
      description={tOr(
        'PlatformGovernance.noticeDescription',
        'Send a message to the owner of one company. It goes to their email and is kept in the platform log.',
      )}
    >
      {(me) => <NoticesBody api={api} me={me} initialOrganizationId={organizationId ?? ''} />}
    </PlatformGate>
  );
}

function NoticesBody({
  api,
  me,
  initialOrganizationId,
}: {
  api: ApiClient;
  me: PlatformMeView;
  initialOrganizationId: string;
}) {
  const t = useT();
  const tOr = useTOr();
  const queryClient = useQueryClient();
  const companies = useQuery({
    queryKey: ['platform', 'companies', ''],
    queryFn: () => listPlatformCompanies(api),
  });
  const notices = useQuery({
    queryKey: PLATFORM_OWNER_NOTICES_QUERY_KEY,
    queryFn: () => listPlatformOwnerNotices(api),
  });
  const [organizationId, setOrganizationId] = useState(initialOrganizationId);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<Severity>('info');
  const [tried, setTried] = useState(false);
  const canSend = me.permissions.includes('platform.orgs.edit');
  const send = useMutation({
    mutationFn: () =>
      sendPlatformOwnerNotice(api, {
        organizationId,
        subject: subject.trim(),
        body: body.trim(),
        severity,
      }),
    onSuccess: () => {
      setSubject('');
      setBody('');
      setTried(false);
      void queryClient.invalidateQueries({ queryKey: PLATFORM_OWNER_NOTICES_QUERY_KEY });
    },
  });
  const missing = organizationId === '' || subject.trim() === '' || body.trim() === '';
  const required = tOr('PlatformGovernance.required', 'Required');
  const names = new Map((companies.data ?? []).map((company) => [company.id, company.name]));

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (missing || !canSend) return;
    send.mutate();
  }

  return (
    <div className="tm-stack">
      <GovernanceSubNav active="notices" />
      <form className="tm-cc-card tm-stack tm-stack--tight" onSubmit={submit} noValidate>
        <Select
          label={tOr('PlatformGovernance.fieldCompany', 'Company')}
          value={organizationId}
          onChange={(event) => setOrganizationId(event.target.value)}
          {...(tried && organizationId === '' ? { error: required } : {})}
        >
          <option value="">{tOr('PlatformGovernance.pickCompany', 'Choose a company')}</option>
          {(companies.data ?? []).map((company) => (
            <option key={company.id} value={company.id}>
              {company.ownerEmail ? `${company.name} · ${company.ownerEmail}` : company.name}
            </option>
          ))}
        </Select>
        <Field
          label={tOr('PlatformGovernance.fieldSubject', 'Subject')}
          value={subject}
          maxLength={190}
          onChange={(event) => setSubject(event.target.value)}
          {...(tried && subject.trim() === '' ? { error: required } : {})}
        />
        <label className="tm-content-textarea">
          <span className="tm-content-textarea__label">
            {tOr('PlatformGovernance.fieldMessage', 'Message')}
          </span>
          <textarea
            value={body}
            rows={5}
            maxLength={5000}
            aria-invalid={tried && body.trim() === ''}
            onChange={(event) => setBody(event.target.value)}
          />
          {tried && body.trim() === '' ? <span className="tm-cc-note">{required}</span> : null}
        </label>
        <ChipGroup<Severity>
          label={tOr('PlatformGovernance.fieldLevel', 'Level')}
          value={severity}
          onChange={setSeverity}
          options={[
            { value: 'info', label: tOr('PlatformGovernance.levelInfo', 'Info') },
            { value: 'warning', label: tOr('PlatformGovernance.levelWarning', 'Warning') },
            { value: 'critical', label: tOr('PlatformGovernance.levelCritical', 'Critical') },
          ]}
        />
        {send.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('PlatformGovernance.sendFailed', 'The notice was not sent.')}
            live
          >
            {platformErrorText(send.error, t)}
          </InlineAlert>
        ) : null}
        {send.isSuccess ? (
          <InlineAlert tone="success" title={tOr('PlatformGovernance.sent', 'Notice sent.')} live>
            {send.data.delivery === 'sent' || send.data.delivery === 'queued'
              ? tOr('PlatformGovernance.sentMail', 'It is on its way to the owner.')
              : tOr(
                  'PlatformGovernance.sentNoMail',
                  'It was saved, but no email went out from this server.',
                )}
          </InlineAlert>
        ) : null}
        <div>
          <Button type="submit" tone="lime" disabled={!canSend || send.isPending}>
            {tOr('PlatformGovernance.send', 'Send notice')}
          </Button>
        </div>
      </form>
      <PlatformTable
        label={tOr('PlatformGovernance.sentTitle', 'Sent notices')}
        rows={notices.data ?? []}
        rowKey={(row) => row.id}
        columns={[
          {
            id: 'company',
            header: tOr('PlatformGovernance.colCompany', 'Company'),
            cell: (row) => names.get(row.organizationId) ?? row.organizationId,
          },
          {
            id: 'subject',
            header: tOr('PlatformGovernance.fieldSubject', 'Subject'),
            cell: (row) => row.subject,
          },
          {
            id: 'by',
            header: tOr('PlatformGovernance.colSentBy', 'Sent by'),
            cell: (row) => row.sentByEmail ?? '—',
          },
          {
            id: 'when',
            header: tOr('PlatformGovernance.colWhen', 'When'),
            cell: (row) => formatMoment(row.createdAt),
          },
        ]}
      />
    </div>
  );
}

// ── Access review ───────────────────────────────────────────────────────────

export function PlatformAccessReviewScreen({ client, now }: ScreenProps & { now?: Date }) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  return (
    <PlatformGate
      api={api}
      section="team"
      crumbs={[
        tOr('PlatformGovernance.crumb', 'Platform controls'),
        tOr('PlatformGovernance.navReview', 'Access review'),
      ]}
      title={tOr('PlatformGovernance.reviewTitle', 'Access review')}
      description={tOr(
        'PlatformGovernance.reviewDescription',
        'Every quarter, confirm who on the platform team still needs access, or revoke it.',
      )}
    >
      {() => <ReviewBody api={api} now={now ?? new Date()} />}
    </PlatformGate>
  );
}

function ReviewBody({ api, now }: { api: ApiClient; now: Date }) {
  const t = useT();
  const tOr = useTOr();
  const queryClient = useQueryClient();
  const quarters = recentQuarters(now);
  const [quarter, setQuarter] = useState(quarters[0] ?? '');
  const review = useQuery({
    queryKey: platformAccessReviewQueryKey(quarter),
    queryFn: () => fetchPlatformAccessReview(api, quarter),
  });
  const [revoking, setRevoking] = useState<PlatformAccessReviewRow | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: platformAccessReviewQueryKey(quarter) });
  const confirm = useMutation({
    mutationFn: (userId: string) => confirmPlatformAccess(api, quarter, userId),
    onSuccess: () => void refresh(),
  });

  return (
    <div className="tm-stack">
      <GovernanceSubNav active="review" />
      <ChipGroup<string>
        label={tOr('PlatformGovernance.quarter', 'Quarter')}
        value={quarter}
        onChange={setQuarter}
        options={quarters.map((value) => ({ value, label: value.replace('-', ' ') }))}
      />
      {review.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('PlatformGovernance.loadFailed', 'Could not load this page.')}
          live
        >
          {platformErrorText(review.error, t)}
        </InlineAlert>
      ) : null}
      {review.isSuccess && review.data.withoutTwoStep > 0 ? (
        <InlineAlert
          tone="warning"
          title={tOr('PlatformGovernance.noTwoStepTitle', 'Two-step sign-in missing')}
        >
          {tOr(
            'PlatformGovernance.noTwoStepBody',
            'People without two-step sign-in cannot open Platform admin until they turn it on.',
          )}{' '}
          ({review.data.withoutTwoStep})
        </InlineAlert>
      ) : null}
      {confirm.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('PlatformGovernance.confirmFailed', 'Could not confirm.')}
          live
        >
          {platformErrorText(confirm.error, t)}
        </InlineAlert>
      ) : null}
      <PlatformTable<PlatformAccessReviewRow>
        label={tOr('PlatformGovernance.reviewTable', 'Platform team access')}
        rows={review.data?.admins ?? []}
        rowKey={(row) => row.userId ?? row.email}
        isMuted={(row) => row.status !== 'active'}
        columns={[
          {
            id: 'person',
            header: tOr('PlatformGovernance.colPerson', 'Person'),
            cell: (row) => row.displayName ?? row.email,
          },
          {
            id: 'role',
            header: tOr('PlatformGovernance.colRole', 'Role'),
            cell: (row) => row.preset ?? '—',
          },
          {
            id: 'rights',
            header: tOr('PlatformGovernance.colRights', 'Rights'),
            kind: 'mono',
            cell: (row) => String(row.permissions?.length ?? 0),
          },
          {
            id: 'twoStep',
            header: tOr('PlatformGovernance.colTwoStep', 'Two-step'),
            cell: (row) =>
              row.twoStep
                ? tOr('PlatformGovernance.on', 'On')
                : tOr('PlatformGovernance.off', 'Off'),
          },
          {
            id: 'review',
            header: tOr('PlatformGovernance.colReview', 'Review'),
            cell: (row) => (
              <div style={ROW}>
                {row.confirmed ? (
                  <span className="tm-cc-pill tm-cc-pill--on">
                    {tOr('PlatformGovernance.confirmed', 'Confirmed')}
                  </span>
                ) : row.userId !== null && row.status === 'active' ? (
                  <Button
                    type="button"
                    tone="outline"
                    size="compact"
                    disabled={confirm.isPending}
                    onClick={() => confirm.mutate(row.userId ?? '')}
                  >
                    {tOr('PlatformGovernance.confirm', 'Confirm')}
                  </Button>
                ) : null}
                {row.adminId && row.status === 'active' ? (
                  <Button
                    type="button"
                    tone="destructive"
                    size="compact"
                    onClick={() => setRevoking(row)}
                  >
                    {tOr('PlatformGovernance.revoke', 'Revoke')}
                  </Button>
                ) : null}
              </div>
            ),
          },
        ]}
      />
      {revoking !== null && revoking.adminId ? (
        <ReasonDialog
          title={`${tOr('PlatformGovernance.revoke', 'Revoke')}: ${revoking.displayName ?? revoking.email}`}
          reasonRequired
          destructive
          confirmLabel={tOr('PlatformGovernance.revoke', 'Revoke')}
          onConfirm={(reason) =>
            updatePlatformAdmin(api, revoking.adminId ?? '', {
              status: 'disabled',
              reason: reason ?? '',
            })
          }
          onClose={(done) => {
            setRevoking(null);
            if (done) void refresh();
          }}
        />
      ) : null}
    </div>
  );
}
