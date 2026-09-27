'use client';

import { Badge, Button } from '@tmanage/ui';
import type { ItemLabel } from '../../lib/api/work-labels';

export interface WorkItemLabelChipsProps {
  /** The labels currently on the work item. */
  labels: readonly ItemLabel[];
  /** When present, each chip shows a remove control that calls this with the label id. */
  onRemove?: (labelId: string) => void;
  /** Disable the remove controls while a mutation is in flight. */
  busy?: boolean;
}

/**
 * **x233 — a work item's label chips.** (Work module 7.)
 *
 * The read-side of work labels: the labels assigned to one work item, rendered as small chips. It is
 * purely presentational — it renders exactly the {@link ItemLabel} shape the API returns and never
 * fetches — so it drops into the work-item detail screen or the labels screen alike. When `onRemove`
 * is given, each chip carries an accessible remove control; without it the chips are read-only.
 */
export function WorkItemLabelChips({ labels, onRemove, busy = false }: WorkItemLabelChipsProps) {
  if (labels.length === 0) {
    return <p className="tm-muted">No labels yet.</p>;
  }

  return (
    <ul className="tm-row tm-row--wrap" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {labels.map((label) => (
        <li key={label.id} data-color={label.color}>
          <Badge tone="neutral">
            {label.name}
            {onRemove ? (
              <Button
                type="button"
                tone="text"
                size="compact"
                disabled={busy}
                onClick={() => onRemove(label.labelId)}
                aria-label={`Remove label ${label.name}`}
              >
                ×
              </Button>
            ) : null}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
