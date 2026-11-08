'use client';

import { useMutation } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { checkAuditIntegrity, type AuditIntegrityReport } from '../../lib/api/audit-integrity';
import { ApiRequestError } from '../../lib/api/errors';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useTOr } from '../../lib/i18n/use-t-or';

const K = 'AuditIntegrity';

/**
 * 56-11 — the owner's "Check integrity" action on the audit log (Figma 575:32648 EN, 575:32857 AR).
 *
 * One read of the chain verifier, on demand only: the walk can be long, so it never runs on page
 * load. The screen places the button in its header and the verdict above the list, so the state
 * lives in this hook and both halves read it.
 */
export function useAuditIntegrityCheck(api: ApiClient, organizationSlug: string) {
  return useMutation({ mutationFn: () => checkAuditIntegrity(api, organizationSlug) });
}

type Check = ReturnType<typeof useAuditIntegrityCheck>;

export function AuditIntegrityButton({ check }: { check: Check }) {
  const tr = useTOr();
  return (
    <Button
      tone="outline"
      size="compact"
      loading={check.isPending}
      loadingLabel={tr(`${K}.checking`, 'Checking…')}
      onClick={() => check.mutate()}
    >
      {tr(`${K}.check`, 'Check integrity')}
    </Button>
  );
}

/** The verdict, or nothing until the check has run. */
export function AuditIntegrityResult({ check }: { check: Check }) {
  const tr = useTOr();
  const describe = useDescribeApiError();

  if (check.isError) {
    const refused = check.error instanceof ApiRequestError && check.error.status === 403;
    return (
      <InlineAlert
        tone="danger"
        title={tr(`${K}.errorTitle`, 'Could not check the audit log')}
        live
      >
        {refused
          ? tr(
              `${K}.forbidden`,
              'Only owners and admins who can see the whole audit log can check it.',
            )
          : describe(check.error)}
      </InlineAlert>
    );
  }
  if (!check.data) return null;
  return <Verdict report={check.data} />;
}

function Verdict({ report }: { report: AuditIntegrityReport }) {
  const tr = useTOr();
  const count = report.checkedEvents.toLocaleString();

  if (report.status === 'not_started') {
    return (
      <InlineAlert tone="neutral" title={tr(`${K}.notStartedTitle`, 'Nothing to check yet')} live>
        {tr(`${K}.notStartedBody`, 'Integrity checks start with the next change that is recorded.')}
      </InlineAlert>
    );
  }
  if (report.status === 'broken' && report.firstBreak) {
    const position = report.firstBreak.chainSeq.toLocaleString();
    return (
      <InlineAlert tone="danger" title={tr(`${K}.brokenTitle`, 'Audit log changed')} live>
        {tr(
          `${K}.brokenBody`,
          'The first changed entry is #{position}. Entries after it cannot be trusted.',
        ).replace('{position}', position)}
      </InlineAlert>
    );
  }
  return (
    <InlineAlert tone="success" title={tr(`${K}.intactTitle`, 'Audit log intact')} live>
      {(report.complete
        ? tr(`${K}.intactBody`, '{count} entries checked. None has been changed.')
        : tr(
            `${K}.partialBody`,
            '{count} entries checked. None has been changed. The newest entries were past the limit of one check.',
          )
      ).replace('{count}', count)}
    </InlineAlert>
  );
}
