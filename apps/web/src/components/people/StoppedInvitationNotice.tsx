'use client';

import { useMutation } from '@tanstack/react-query';
import { Badge, Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { clearMailBounce } from '../../lib/api/mail-bounces';
import { useTOr } from '../../lib/i18n/use-t-or';
import { withIsolates } from '../../lib/i18n/with-isolates';
import { useShellCapability } from '../shell/use-shell-capability';

/**
 * 56-26 (B1) — a pending invitation whose address TManage stopped mailing, because mail to it
 * keeps coming back (Figma 678:37661: 678:37662 owner/admin, 678:37694 member, AR 678:37716).
 *
 * The chip sits beside the address; the notice sits under the row. It names the address in a bidi
 * isolate (it stays whole inside an Arabic sentence) and is announced as a status. "Check the
 * address" opens the screen's own invite path with the address filled in. "Send to it again" is
 * drawn only for `org.security.manage` — the server decides — and starts sending to the address
 * again, then runs the screen's existing resend.
 */

const K = 'StoppedInvitation';

export function NotDeliveredChip() {
  const tr = useTOr();
  return <Badge tone="client">{tr(`${K}.chip`, 'Not delivered')}</Badge>;
}

export function StoppedInvitationNotice({
  api,
  organizationSlug,
  email,
  busy,
  onCheckAddress,
  onResend,
}: {
  api: ApiClient;
  organizationSlug: string;
  email: string;
  /** A resend is already running for this invitation. */
  busy: boolean;
  onCheckAddress: () => void;
  /** The screen's existing resend (re-issue) for this invitation. */
  onResend: () => void;
}) {
  const tr = useTOr();
  const canUse = useShellCapability(organizationSlug, api);
  const clear = useMutation({
    mutationFn: () => clearMailBounce(api, organizationSlug, email),
    onSuccess: () => onResend(),
  });

  return (
    <div className="tm-stack tm-stopped-invite">
      <InlineAlert tone="warning" live>
        {withIsolates(
          tr(
            `${K}.notice`,
            "The invitation to {address} didn't arrive. Mail to this address keeps coming back, so TManage stopped sending to it.",
          ),
          { address: email },
        )}
      </InlineAlert>
      {clear.isError ? (
        <InlineAlert tone="danger" live>
          {tr(`${K}.clearError`, 'We could not start sending to this address again. Try again.')}
        </InlineAlert>
      ) : null}
      <div className="tm-row tm-stopped-invite__actions">
        <Button tone="outline" size="accessible" onClick={onCheckAddress}>
          {tr(`${K}.check`, 'Check the address')}
        </Button>
        {canUse('org.security.manage') ? (
          <Button
            tone="text"
            size="accessible"
            disabled={busy || clear.isPending}
            onClick={() => clear.mutate()}
          >
            {tr(`${K}.sendAgain`, 'Send to it again')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
