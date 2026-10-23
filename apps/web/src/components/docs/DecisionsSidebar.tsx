'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { listDecisions } from '../../lib/api/decisions';
import { useTOr } from '../../lib/i18n/use-t-or';
import './docs-shell.css';

export interface DecisionsSidebarProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  /** The project whose register is listed — the decision on screen's own project. */
  readonly projectId?: string;
  /** The decision on screen, inked in the list. */
  readonly activeDecisionId?: string;
}

/**
 * The decisions column of 384:3835: a find field, the black "New decision" button (to the
 * register, where a decision is recorded) and DECISIONS — the project's register, most recently
 * decided first (`GET …/decisions?projectId=`).
 */
export function DecisionsSidebar({
  api,
  organizationSlug,
  projectId,
  activeDecisionId,
}: DecisionsSidebarProps) {
  const tOr = useTOr();
  const [find, setFind] = useState('');

  const register = useQuery({
    queryKey: ['decisions', organizationSlug, projectId ?? ''],
    queryFn: () => listDecisions(api, organizationSlug, { projectId: projectId as string }),
    enabled: projectId !== undefined && projectId !== '',
  });

  const needle = find.trim().toLocaleLowerCase();
  const rows = (register.data ?? []).filter(
    (row) => needle === '' || row.title.toLocaleLowerCase().includes(needle),
  );

  return (
    <div className="tm-docside">
      <label className="tm-docside__find">
        <span className="tm-docside__find-glyph" aria-hidden="true">
          ⌕
        </span>
        <span className="tm-visually-hidden">
          {tOr('DecisionsSidebar.findLabel', 'Find a channel or person')}
        </span>
        <input
          type="search"
          value={find}
          onChange={(event) => setFind(event.target.value)}
          placeholder={tOr('DecisionsSidebar.findPlaceholder', 'Find a channel or person')}
        />
        <kbd className="tm-docside__kbd" aria-hidden="true">
          ⌘K
        </kbd>
      </label>

      <Link className="tm-docside__new" href={`/${organizationSlug}/decisions`}>
        {tOr('DecisionsSidebar.newDecision', 'New decision')}
      </Link>

      <section className="tm-docside__group" aria-labelledby="tm-docside-decisions">
        <h2 id="tm-docside-decisions" className="tm-docside__eyebrow">
          {tOr('DecisionsSidebar.decisions', 'Decisions')}
        </h2>
        <ul className="tm-docside__list">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                className="tm-docside__row"
                href={`/${organizationSlug}/decisions/${row.id}`}
                {...(row.id === activeDecisionId ? { 'aria-current': 'page' as const } : {})}
              >
                <span className="tm-docside__row-glyph" aria-hidden="true">
                  ◇
                </span>
                <span>{row.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
