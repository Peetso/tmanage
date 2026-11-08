'use client';

import { Badge, StatusDot } from '@tmanage/ui';
import { useTOr } from '../../lib/i18n/use-t-or';

/**
 * 53-16. The "Pending" mark on a change made offline and not yet sent (Figma R39
 * L1-53-16-offline, "Pending badge"). A conflict reads "Not sent" instead.
 */
export function PendingBadge({ conflict = false }: { conflict?: boolean }) {
  const tOr = useTOr();
  return (
    <Badge>
      <StatusDot tone={conflict ? 'danger' : 'warning'}>
        {conflict ? tOr('OfflineMode.notSent', 'Not sent') : tOr('OfflineMode.pending', 'Pending')}
      </StatusDot>
    </Badge>
  );
}
