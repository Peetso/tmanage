'use client';

import Link from 'next/link';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import type { ApiClient } from '../../lib/api/client';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import { localizedOpTitle, subjectLine } from '../../lib/ai-approval-presentation';
import { appLocale } from '../../lib/i18n/app-locale';
import { useCatalogLookup } from '../../lib/i18n/use-catalog-lookup';
import { useTOr } from '../../lib/i18n/use-t-or';
import { usePendingAiApprovals } from '../ai-actions/pending-ai-actions';
import '../../styles/screens/preferences.css';
import '../../styles/screens/ai-assistant.css';

export interface AiActionsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **AI actions** (55-15p) — `/{org}/settings/ai-actions`, the menu entry under AI assistant that
 * carries the "2 waiting" capsule.
 *
 * Lists the member's own actions an assistant asked for that wait for approval, newest first.
 * Each opens the existing approve page (`/{org}/ai/approve/{id}`), where the decision is made; this
 * page decides nothing itself. Only the member's own requests are ever listed (the API filters by
 * membership and user, cookie session only).
 */
export function AiActionsScreen({
  organizationSlug,
  organizationName,
  client,
}: AiActionsScreenProps) {
  const tOr = useTOr();
  const lookup = useCatalogLookup();
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const pending = usePendingAiApprovals(organizationSlug, client);
  const items = pending.data ?? [];

  return (
    <SettingsShell
      section="ai-actions"
      {...(client ? { client } : {})}
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={tOr('AiAssistantScreen.navAiActions', 'AI actions')}
      description={tOr(
        'AiAssistantScreen.actionsLead',
        'What your assistant asked to change. Nothing runs until you approve it.',
      )}
    >
      <div className="tm-ai-connect">
        {pending.isPending ? (
          <LoadingRegion label={tOr('AiAssistantScreen.actionsLoading', 'Loading waiting actions')}>
            <Skeleton />
          </LoadingRegion>
        ) : pending.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('AiAssistantScreen.actionsLoadError', 'Could not load the waiting actions.')}
          >
            {errorMessage(pending.error)}
          </InlineAlert>
        ) : items.length === 0 ? (
          <section className="tm-prefs-card tm-ai-card" data-testid="tm-ai-actions-empty">
            <p className="tm-prefs-card__body">
              {tOr('AiAssistantScreen.actionsEmpty', 'Nothing is waiting for your approval.')}
            </p>
          </section>
        ) : (
          <ul
            className="tm-ai-actions"
            aria-label={tOr('AiAssistantScreen.navAiActions', 'AI actions')}
          >
            {items.map((item) => {
              // TESTUX P1 9: the row names the item ("Delete “Prepare concepts”"), in the reader's
              // language, with the action's kind under it; the op title alone when it is unnamed.
              const kind = localizedOpTitle(lookup, item.summary.opId, item.summary.title);
              const subject = subjectLine(lookup, item.summary.subject, item.summary.destructive);
              return (
                <li key={item.id} className="tm-prefs-card tm-ai-card">
                  <StateCapsule state="waiting">
                    {tOr('AiAssistantScreen.actionWaiting', 'Waiting for you')}
                  </StateCapsule>
                  <h2 className="tm-ai-card__title">{subject ?? kind}</h2>
                  {subject === null ? null : <p className="tm-prefs-card__body">{kind}</p>}
                  <p className="tm-prefs-card__note">
                    {tOr('AiAssistantScreen.actionFrom', 'From {client} · open until {when}')
                      .replace('{client}', item.clientName)
                      .replace('{when}', formatWhen(item.expiresAt))}
                  </p>
                  <div>
                    <Link
                      className="tm-button tm-button--ink tm-button--accessible"
                      href={`/${organizationSlug}/ai/approve/${encodeURIComponent(item.id)}`}
                    >
                      {tOr('AiAssistantScreen.review', 'Review')}
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </SettingsShell>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(appLocale(), {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}
