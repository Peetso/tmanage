'use client';

import Link from 'next/link';
import { withIsolates } from '../../lib/i18n/with-isolates';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/client-filter.css';

/**
 * D6 — the line a hub (Files, Invoices) shows when the client page opened it narrowed to one
 * company: "Only Cedar Foods · Show all". Without it a filtered list would read as the whole list.
 */
export function ClientFilterNote({
  name,
  showAllHref,
}: {
  /** The company's name; `undefined` while it loads (the line then waits). */
  readonly name: string | undefined;
  readonly showAllHref: string;
}) {
  const tOr = useTOr();
  if (name === undefined) return null;
  return (
    <p className="tm-client-filter">
      <span>{withIsolates(tOr('ClientFilter.only', 'Only {name}'), { name })}</span>
      {' · '}
      <Link href={showAllHref}>{tOr('ClientFilter.showAll', 'Show all')}</Link>
    </p>
  );
}
