'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import {
  endSupportSession,
  fetchSupportSession,
  supportSessionActivityHref,
} from '../../../lib/api/platform-support';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformDialog, PlatformDialogActions, platformErrorText } from '../shared/ReasonDialog';
import { forgetSupportSession, supportSessionQueryKey } from './support-session-memory';
import './support-mode.css';

/** How many recent actions the dialog lists before "+ N more" (437:18712). */
const SHOWN_ACTIONS = 3;

/**
 * "Exit Support mode?" (437:18712): the count of actions taken, the last few, a link to the
 * session in the action log, then Stay or Exit. Exit ends the session and returns to Platform admin.
 */
export function SupportExitDialog({
  sessionId,
  organizationSlug,
  organizationName,
  actionsCount,
  startedAt,
  onClose,
}: {
  sessionId: string;
  organizationSlug: string;
  organizationName: string;
  actionsCount: number;
  startedAt: string;
  onClose: () => void;
}) {
  const t = useT();
  const api = browserApiClient();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: supportSessionQueryKey(sessionId),
    queryFn: () => fetchSupportSession(api, sessionId),
    retry: false,
  });
  const exit = useMutation({
    mutationFn: () => endSupportSession(api, sessionId),
    onSuccess: async () => {
      forgetSupportSession(organizationSlug);
      await queryClient.invalidateQueries({ queryKey: ['support'] });
      window.location.assign('/platform');
    },
  });

  const count = detail.data?.session.actionsCount ?? actionsCount;
  const minutes = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 60_000));
  const actions = detail.data?.recentActions ?? [];
  const more = Math.max(0, count - Math.min(actions.length, SHOWN_ACTIONS));

  return (
    <PlatformDialog title={t('SupportMode.exitTitle')} onClose={onClose}>
      <p className="tm-cc-note">
        {t('SupportMode.exitBody')
          .replace('{count}', String(count))
          .replace('{org}', organizationName)
          .replace('{minutes}', String(minutes))}
      </p>
      {actions.length > 0 ? (
        <ul className="tm-support-dialog__actions-list">
          {actions.slice(0, SHOWN_ACTIONS).map((label, index) => (
            <li key={`${index}-${label}`}>{label}</li>
          ))}
          {more > 0 ? <li>{t('SupportMode.more').replace('{count}', String(more))}</li> : null}
        </ul>
      ) : null}
      <a className="tm-support-dialog__log-link" href={supportSessionActivityHref(sessionId)}>
        {t('SupportMode.openLog')}
      </a>
      {exit.isError ? (
        <InlineAlert tone="danger" title={t('SupportMode.exitFailed')} live>
          {platformErrorText(exit.error, t)}
        </InlineAlert>
      ) : null}
      <PlatformDialogActions>
        <Button type="button" tone="outline" onClick={onClose}>
          {t('SupportMode.stay')}
        </Button>
        <Button
          type="button"
          tone="destructive"
          onClick={() => exit.mutate()}
          disabled={exit.isPending}
        >
          {t('SupportMode.exitConfirm')}
        </Button>
      </PlatformDialogActions>
    </PlatformDialog>
  );
}
