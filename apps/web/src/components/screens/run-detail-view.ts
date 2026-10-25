/**
 * AUT-04 "What it recorded": a run's stored detail as plain lines instead of raw JSON. Ids stay off
 * screen; kinds become words; a known reason becomes a sentence. Unknown keys are shown humanised so
 * nothing the run recorded is hidden.
 */
export interface RunDetailLine {
  readonly label: string;
  readonly value: string;
}

const LABELS: Record<string, string> = {
  triggerKind: 'Trigger',
  actionKind: 'Action',
  outcome: 'Outcome',
  effect: 'What it did',
  reason: 'Why',
};

const REASONS: Record<string, string> = {
  external_action_not_supported_in_app:
    'This action reaches outside TManage, and outside actions are not switched on yet.',
  action_not_available_yet: 'This action is not available yet, so nothing was done.',
  no_owner_to_notify: 'Nobody who owns this could be notified, so nothing was sent.',
  trigger_object_gone: 'What started the rule no longer exists, so nothing was done.',
  held_for_weekend: 'Held for the weekend. It is sent on Sunday morning instead.',
};

const OUTCOMES: Record<string, string> = {
  executed: 'Carried out',
  not_run: 'Not run',
};

/** Keys that are ids, not information a reader can use. */
const HIDDEN = new Set([
  'templateId',
  'runId',
  'organizationId',
  // Gap 10: what a weekend-held run needs to be sent on Sunday, and the held run a delivery closes.
  'heldEventId',
  'heldObjectType',
  'heldObjectId',
  'heldProjectId',
  'heldRunId',
]);

function words(value: string): string {
  const text = value.replace(/[_.]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function keyWords(key: string): string {
  return words(key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
}

export function describeRunDetail(detail: Record<string, unknown>): readonly RunDetailLine[] {
  const lines: RunDetailLine[] = [];
  for (const [key, raw] of Object.entries(detail)) {
    if (HIDDEN.has(key) || raw === null || raw === undefined) continue;
    const value =
      typeof raw === 'string'
        ? key === 'reason'
          ? (REASONS[raw] ?? words(raw))
          : key === 'outcome'
            ? (OUTCOMES[raw] ?? words(raw))
            : key === 'effect'
              ? raw
              : words(raw)
        : typeof raw === 'number' || typeof raw === 'boolean'
          ? String(raw)
          : JSON.stringify(raw);
    lines.push({ label: LABELS[key] ?? keyWords(key), value });
  }
  return lines;
}
