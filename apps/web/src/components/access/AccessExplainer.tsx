'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readOrganizationMe } from '../../lib/api/permission-matrix';
import type { ApiClient } from '../../lib/api/client';
import {
  explainAccess,
  fillReason,
  type AccessReason,
  type ItemAudience,
} from '../../lib/access/explain-access';
import { capabilityLabel } from '../../lib/capability-labels';
import { describeInternalRole } from '../../lib/roles';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/undo-and-access.css';

export interface AccessExplainerProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly audience: ItemAudience;
  readonly projectName: string;
  /** The item's owner, compared with the caller's own user id. */
  readonly ownerUserId: string | null;
  /** The capability editing this item needs. */
  readonly editCapability: string;
}

/**
 * 55-23 — "Why can I see this?" beside an item (Figma R50 L3, Product page `594:34380`): a small
 * popover that names the person's role, the project the item belongs to and who else can see it,
 * plus "Why can't I edit this?" when their role lacks the edit permission. Built from the
 * caller's own `…/me` and the item's sharing — see `lib/access/explain-access.ts`.
 */
export function AccessExplainer({
  api,
  organizationSlug,
  audience,
  projectName,
  ownerUserId,
  editCapability,
}: AccessExplainerProps) {
  const tOr = useTOr();
  const me = useQuery({
    queryKey: ['organization-me', organizationSlug],
    queryFn: () => readOrganizationMe(api, organizationSlug),
    retry: false,
    staleTime: 5 * 60_000,
  });
  if (!me.data || typeof me.data.role !== 'string') return null;

  const explanation = explainAccess({
    kind: me.data.kind,
    roleLabel: describeInternalRole(me.data.role).label,
    capabilities: me.data.capabilities ?? [],
    audience,
    projectName,
    isOwner: ownerUserId !== null && ownerUserId === me.data.userId,
    editCapability,
    editCapabilityLabel: capabilityLabel(editCapability),
  });
  const say = (reason: AccessReason) => fillReason(tOr(reason.key, reason.english), reason.vars);

  return (
    <span className="tm-access-row" data-testid="access-explainer">
      <Popover
        trigger={tOr('AccessExplainer.whySee', 'Why can I see this?')}
        title={tOr('AccessExplainer.whySeeTitle', 'Why you can see this item')}
        reasons={explanation.see.map(say)}
        foot={tOr('AccessExplainer.foot', 'Ask a workspace owner to change who can see it.')}
      />
      {explanation.canEdit ? null : (
        <Popover
          trigger={tOr('AccessExplainer.whyNotEdit', 'Why can’t I edit this?')}
          title={tOr('AccessExplainer.whyNotEditTitle', 'Why you cannot edit this item')}
          reasons={explanation.edit.map(say)}
        />
      )}
    </span>
  );
}

function Popover({
  trigger,
  title,
  reasons,
  foot,
}: {
  readonly trigger: string;
  readonly title: string;
  readonly reasons: readonly string[];
  readonly foot?: string;
}) {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const titleId = useId();
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <span className="tm-access" ref={root}>
      <button
        ref={button}
        type="button"
        className="tm-access__trigger"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen(!open)}
      >
        <LockGlyph />
        {trigger}
      </button>
      {open ? (
        <div id={popoverId} className="tm-access__popover" role="dialog" aria-labelledby={titleId}>
          <p id={titleId} className="tm-access__title">
            {title}
          </p>
          <ul className="tm-access__reasons">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {foot ? <p className="tm-access__foot">{foot}</p> : null}
        </div>
      ) : null}
    </span>
  );
}

function LockGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <rect x="2" y="5.5" width="8" height="5.5" rx="1" fill="none" stroke="currentColor" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" />
    </svg>
  );
}
