'use client';

import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { getMessageReceipts } from '../../../lib/api/receipts';
import type { ReceiptEntry } from '../../../lib/api/receipts';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useT } from '../../../lib/i18n/use-t';
import './status.css';
import { withNumerals } from '../../../lib/i18n/display-format';

/**
 * "Read by" and "Delivered to" lists for slice 4's message info sheet. Delivered lists only the
 * people who have not read it yet, so nobody appears twice.
 */
export function MessageInfoReceipts({
  organizationSlug,
  conversationId,
  messageId,
  client,
}: {
  readonly organizationSlug: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly client?: ApiClient;
}): ReactElement {
  const t = useT();
  const locale = useActiveLocale();
  const api = client ?? browserApiClient();
  const receipts = useQuery({
    queryKey: ['message-receipts', organizationSlug, conversationId, messageId],
    queryFn: () => getMessageReceipts(api, organizationSlug, conversationId, messageId),
  });
  if (receipts.isError) {
    return <p className="tm-receipts__empty">{t('ChatStatus.receiptsError')}</p>;
  }
  const readBy = receipts.data?.readBy ?? [];
  const readIds = new Set(readBy.map((entry) => entry.userId));
  const delivered = (receipts.data?.deliveredTo ?? []).filter((e) => !readIds.has(e.userId));
  const list = (title: string, entries: readonly ReceiptEntry[], state: string) => (
    <section className="tm-receipts__group" data-state={state}>
      <h3 className="tm-receipts__title">{title}</h3>
      {entries.length === 0 ? (
        <p className="tm-receipts__empty">{t('ChatStatus.nobodyYet')}</p>
      ) : (
        <ul className="tm-receipts__list">
          {entries.map((entry) => (
            <li key={entry.userId} className="tm-receipts__row">
              <span className="tm-receipts__name">{entry.displayName}</span>
              <time className="tm-receipts__at" dateTime={entry.at}>
                {new Date(entry.at).toLocaleString(withNumerals(locale), {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
  return (
    <div className="tm-receipts" aria-busy={receipts.isPending}>
      {list(t('ChatStatus.readBy'), readBy, 'read')}
      {list(t('ChatStatus.deliveredTo'), delivered, 'delivered')}
    </div>
  );
}
