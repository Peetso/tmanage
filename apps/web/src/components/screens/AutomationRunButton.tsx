'use client';

import { useMutation } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { runWorkflowTemplate, type WorkflowRunSummary } from '../../lib/api/automations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

export interface AutomationRunButtonProps {
  organizationSlug: string;
  templateId: string;
  /** The template's name, for the button's accessible label. */
  templateName: string;
  client?: ApiClient;
}

/**
 * **Automations & integrations (module 17, x163).**
 *
 * Run control for one workflow template, dropped beside a template on the automations screen. It POSTs
 * the run and shows the last result inline. Nothing here decides whether the run is allowed: the API
 * gates the run on `org.manage`, refuses a disabled template with a 409, and executes only in-app
 * actions — this control renders whatever the server returned or refused.
 *
 * The result region is a polite live region so a screen reader announces the outcome after the button
 * is pressed, and the button carries an explicit accessible name naming the template it runs.
 */
export function AutomationRunButton({
  organizationSlug,
  templateId,
  templateName,
  client,
}: AutomationRunButtonProps) {
  const api = client ?? browserApiClient();
  const t = useT();

  const run = useMutation<WorkflowRunSummary, unknown, void>({
    mutationFn: () => runWorkflowTemplate(api, organizationSlug, templateId),
  });

  return (
    <div className="tm-stack tm-stack--tight tm-aut-run">
      <Button
        type="button"
        tone="lime"
        size="accessible"
        loading={run.isPending}
        loadingLabel={t('AutomationRunButton.running')}
        aria-label={`${t('AutomationRunButton.run')} ${templateName}`}
        onClick={() => run.mutate()}
      >
        {t('AutomationRunButton.run')}
      </Button>

      {run.isError ? (
        <InlineAlert tone="danger" title={t('AutomationRunButton.errorRunTitle')} live>
          {describeError(t, run.error)}
        </InlineAlert>
      ) : null}

      {run.isSuccess ? (
        <InlineAlert
          tone={run.data.status === 'succeeded' ? 'success' : 'warning'}
          title={
            run.data.status === 'succeeded'
              ? t('AutomationRunButton.runSucceeded')
              : t('AutomationRunButton.runNotComplete')
          }
          live
        >
          {describeOutcome(t, run.data)}
        </InlineAlert>
      ) : null}
    </div>
  );
}

function describeOutcome(t: ReturnType<typeof useT>, runResult: WorkflowRunSummary): string {
  const effect = runResult.detail['effect'];
  if (runResult.status === 'succeeded' && typeof effect === 'string') return effect;
  const reason = runResult.detail['reason'];
  if (runResult.status === 'failed' && typeof reason === 'string') {
    return t('AutomationRunButton.outcomeExternal');
  }
  return runResult.status === 'succeeded'
    ? t('AutomationRunButton.outcomeRan')
    : t('AutomationRunButton.outcomeNotRun');
}

function describeError(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('AutomationRunButton.errorApiUnreachable');
  return t('AutomationRunButton.errorGeneric');
}
