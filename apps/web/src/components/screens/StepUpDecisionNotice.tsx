'use client';

import { Button, InlineAlert } from '@tmanage/ui';
import { useTOr } from '../../lib/i18n/use-t-or';
import type { StepUpDecision } from '../../lib/step-up-decision';

/**
 * UX-23 loading / unknown states for a step-up form whose server decision is not known yet
 * (DC-2, AR-9). Renders nothing once the decision is known.
 */
export function StepUpDecisionNotice({
  decision,
  onRetry,
}: {
  decision: StepUpDecision;
  onRetry: () => void;
}) {
  const tr = useTOr();
  if (decision.kind === 'known') return null;
  if (decision.kind === 'loading') {
    return (
      <p role="status" data-testid="step-up-checking">
        {tr('StepUp.checking', 'Checking what this change needs…')}
      </p>
    );
  }
  return (
    <InlineAlert tone="warning" live>
      {tr('StepUp.unknown', 'We cannot reach TManage to check what this change needs.')}{' '}
      <Button type="button" tone="text" onClick={onRetry}>
        {tr('StepUp.retry', 'Try again')}
      </Button>
    </InlineAlert>
  );
}
