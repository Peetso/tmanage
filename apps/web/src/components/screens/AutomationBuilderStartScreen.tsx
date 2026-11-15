'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import './automation-builder.css';
import { browserApiClient } from '../../lib/api/browser-client';
import type { WorkflowTriggerKind } from '../../lib/api/automations';
import { createBranchingRule } from '../../lib/api/automation-flow';
import { ApiRequestError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { TRIGGERS, triggerLabel } from './automation-labels';

export interface AutomationBuilderStartScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const TRIGGER_KINDS = Object.keys(TRIGGERS) as WorkflowTriggerKind[];

/**
 * **New branching automation — empty state (58-C1, Figma 607:34484 / 607:34501).** Pick what kicks
 * the rule off; "Choose a trigger" creates the rule (off, no steps yet) and opens it in the builder.
 */
export function AutomationBuilderStartScreen({
  organizationSlug,
  organizationName,
  client,
}: AutomationBuilderStartScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const router = useRouter();
  const [trigger, setTrigger] = useState<WorkflowTriggerKind | null>(null);

  const create = useMutation({
    mutationFn: (kind: WorkflowTriggerKind) =>
      createBranchingRule(api, organizationSlug, kind, triggerLabel(tOr, kind)),
    onSuccess: (templateId) => {
      router.push(
        `/${organizationSlug}/automations/templates/${encodeURIComponent(templateId)}/builder`,
      );
    },
  });

  return (
    <SettingsShell
      section="automations"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={tOr('AutomationBuilder.eyebrow', 'Automations')}
      title={tOr('AutomationBuilder.newTitle', 'New automation')}
    >
      <section className="tm-afb-empty" aria-labelledby="tm-afb-empty-title">
        <p className="tm-afb-empty__eyebrow">
          {tOr('AutomationBuilder.newTitle', 'New automation')}
        </p>
        <h2 className="tm-afb-empty__title" id="tm-afb-empty-title">
          {tOr('AutomationBuilder.emptyTitle', 'Start with what should kick this off')}
        </h2>
        <p className="tm-afb-empty__body">
          {tOr(
            'AutomationBuilder.emptyBody',
            'Pick a trigger. Then add conditions with Yes and No paths, and the steps TManage should do for you.',
          )}
        </p>
        <div className="tm-afb-empty__chips">
          {TRIGGER_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className="tm-afb-chip"
              aria-pressed={trigger === kind}
              onClick={() => setTrigger(kind)}
            >
              {triggerLabel(tOr, kind)}
            </button>
          ))}
        </div>
        <Button
          type="button"
          tone="ink"
          disabled={trigger === null}
          loading={create.isPending}
          onClick={() => {
            if (trigger !== null) create.mutate(trigger);
          }}
        >
          {tOr('AutomationBuilder.chooseTrigger', 'Choose a trigger')}
        </Button>
        {create.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('AutomationBuilder.createFailed', 'Could not start the automation')}
            live
          >
            {create.error instanceof ApiRequestError
              ? create.error.message
              : tOr('AutomationBuilder.genericError', 'Something went wrong.')}
          </InlineAlert>
        ) : null}
      </section>
    </SettingsShell>
  );
}
