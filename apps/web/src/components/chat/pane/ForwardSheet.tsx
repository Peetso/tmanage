'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import {
  MAX_FORWARD_TARGETS,
  forwardMessage,
  listConversations,
} from '../../../lib/api/conversations';
import type { ForwardMessageResult } from '../../../lib/api/conversations';
import { fill } from '../../../lib/privacy-presentation';
import { useTOr } from '../../../lib/i18n/use-t-or';
import './pane.css';
import { channelLabel } from '../../../lib/text/channel-label';

export interface ForwardSheetProps {
  api: ApiClient;
  organizationSlug: string;
  conversationId: string;
  messageId: string;
  /** Called once the copies are made, with what the API answered. */
  onDone: (result: ForwardMessageResult) => void;
  onClose: () => void;
}

/**
 * R7 slice 4 — "Forward to…": pick up to five conversations and send. The API posts each copy
 * through the target's own write gate, so a target the caller cannot write to comes back in
 * `refused` and is reported, never silently dropped.
 */
export function ForwardSheet({
  api,
  organizationSlug,
  conversationId,
  messageId,
  onDone,
  onClose,
}: ForwardSheetProps) {
  const tOr = useTOr();
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [search, setSearch] = useState('');
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const targets = useQuery({
    queryKey: ['conversations', organizationSlug, 'forward-targets'],
    queryFn: () => listConversations(api, organizationSlug),
  });
  const send = useMutation({
    mutationFn: () => forwardMessage(api, organizationSlug, conversationId, messageId, picked),
    onSuccess: onDone,
  });

  const needle = search.trim().toLowerCase();
  const rows = (Array.isArray(targets.data) ? targets.data : []).filter(
    (row) => row.archivedAt === null && (needle === '' || row.name.toLowerCase().includes(needle)),
  );
  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : current.length >= MAX_FORWARD_TARGETS
          ? current
          : [...current, id],
    );

  return (
    <div className="tm-pane-sheet">
      <div
        className="tm-pane-sheet__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tm-forward-title"
      >
        <h2 id="tm-forward-title" className="tm-pane-sheet__title" tabIndex={-1} ref={titleRef}>
          {tOr('ChatMessages.forwardTitle', 'Forward to…')}
        </h2>
        <p className="tm-pane-bubble__meta">
          {fill(tOr('ChatMessages.forwardHint', 'Up to {count} conversations'), {
            count: MAX_FORWARD_TARGETS,
          })}
        </p>
        <input
          type="search"
          className="tm-input"
          aria-label={tOr('ChatMessages.forwardSearch', 'Search conversations')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <ul className="tm-pane-sheet__list">
          {rows.map((row) => (
            <li key={row.id}>
              <label className="tm-pane-sheet__row">
                <input
                  type="checkbox"
                  checked={picked.includes(row.id)}
                  disabled={!picked.includes(row.id) && picked.length >= MAX_FORWARD_TARGETS}
                  onChange={() => toggle(row.id)}
                />
                {row.kind === 'project_channel' ? channelLabel(row.name) : row.name}
              </label>
            </li>
          ))}
        </ul>
        {send.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('ChatMessages.forwardFailed', 'Not forwarded')}
            live
          >
            {tOr('ChatMessages.tryAgain', 'Please try again.')}
          </InlineAlert>
        ) : null}
        <div className="tm-pane-sheet__actions">
          <Button tone="outline" onClick={onClose}>
            {tOr('ChatMessages.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={picked.length === 0}
            loading={send.isPending}
            loadingLabel={tOr('ChatMessages.forwarding', 'Forwarding…')}
            onClick={() => send.mutate()}
          >
            {tOr('ChatMessages.forwardSend', 'Forward')}
          </Button>
        </div>
      </div>
    </div>
  );
}
