'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { askCopilot } from '../../lib/api/copilot';
import type { CopilotAnswerView as CopilotAnswer } from '../../lib/api/copilot';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface CopilotAnswerViewProps {
  organizationSlug: string;
  organizationName: string;
  /** Preseed and auto-ask a question — how the Search "Ask" affordance opens straight onto an answer. */
  initialQuestion?: string;
  client?: ApiClient;
}

/** A readable label for each permission-boundary scope the API can return. */
const SCOPE_LABEL: Readonly<Record<CopilotAnswer['permissionBoundary']['scope'], string>> = {
  organization: 'Whole organization',
  'assigned-projects': 'Your assigned projects',
  'client-projection': 'Your client projection',
};

/**
 * **AI copilot answer view (Module 16 — Search, command & AI).**
 *
 * `38-MODULE-MAP` §Search, command & AI asks the copilot to show its working, not just an answer.
 * This panel is the surface for the `POST …/copilot/ask` endpoint (slice 04): a question box and
 * three clearly separated regions over the answer it returns — the **answer**, the **evidence** each
 * linking to the in-app surface it cites, the caller's **permission boundary**, and a primary
 * **next safe action** the person can take to review the records themselves.
 *
 * ## What it is honest about
 *
 * - **The provider is named.** The only provider wired today is the deterministic offline stub, and
 *   its id is shown, so a reader is never misled that a real model answered (the paid model is
 *   Needs-Peter / NS-13).
 * - **The boundary is the server's, rendered not re-derived.** The API decides what the caller may
 *   and may not see; the panel renders exactly that, so the stated reach cannot drift from the
 *   reach the endpoint actually enforced.
 * - **The next safe action is read-only.** It links to the first cited in-app surface (global
 *   search), so the one affordance the panel offers can only take the person to records they could
 *   already open — the copilot never acts on their behalf.
 *
 * A question must be entered and submitted before anything is asked: an empty question is not a
 * question, and the API rejects one. The panel is only mounted where the `copilot` flag is on (the
 * Search screen gates the affordance that reaches it), so the flag's 404 is the belt to this braces.
 */
export function CopilotAnswerView({
  organizationSlug,
  organizationName,
  initialQuestion,
  client,
}: CopilotAnswerViewProps) {
  const api = client ?? browserApiClient();
  const [draft, setDraft] = useState<string>(initialQuestion ?? '');
  const [question, setQuestion] = useState<string>(initialQuestion?.trim() ?? '');

  const result = useQuery({
    queryKey: ['copilot-ask', organizationSlug, question],
    queryFn: () => askCopilot(api, organizationSlug, question),
    enabled: question !== '',
  });

  const answer = result.data;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuestion(draft.trim());
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="AI copilot"
      description="Ask a question and see the evidence, the limits of what the copilot can see, and a safe next step."
    >
      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-copilot-form">
        <h2 id="tm-copilot-form" className="tm-eyebrow">
          Ask the copilot
        </h2>
        <form className="tm-stack" onSubmit={onSubmit} role="search">
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-copilot-q">
              What do you want to know?
            </label>
            <input
              id="tm-copilot-q"
              className="tm-field__control"
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="e.g. what is blocking the launch project?"
            />
            <span className="tm-field__hint">
              The copilot can only draw on records you already have permission to see.
            </span>
          </div>
          <div>
            <button type="submit" className="tm-button" disabled={draft.trim() === ''}>
              Ask
            </button>
          </div>
        </form>
      </section>

      {question === '' ? (
        <InlineAlert tone="neutral" title="Ask a question to begin">
          Type a question above. The copilot answers from what you can already see, shows its
          evidence, and never makes changes on its own.
        </InlineAlert>
      ) : null}

      {result.isError ? (
        <InlineAlert tone="danger" title="Could not ask the copilot" live>
          {describeError(result.error)}
        </InlineAlert>
      ) : null}

      {question !== '' && result.isPending ? (
        <LoadingRegion label="Asking the copilot.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {answer ? <CopilotAnswerRegions answer={answer} organizationSlug={organizationSlug} /> : null}
    </AppShell>
  );
}

/** The three separated regions plus the next-safe-action, rendered from one returned answer view. */
function CopilotAnswerRegions({
  answer,
  organizationSlug,
}: {
  answer: CopilotAnswer;
  organizationSlug: string;
}) {
  const nextActionHref =
    answer.evidence.length > 0
      ? `/${encodeURIComponent(organizationSlug)}${answer.evidence[0]!.link}`
      : null;

  return (
    <>
      <section className="tm-panel tm-stack" aria-labelledby="tm-copilot-answer">
        <h2 id="tm-copilot-answer" className="tm-eyebrow">
          Answer
        </h2>
        <p className="tm-prose">{answer.answer}</p>
        <p className="tm-muted tm-prose">Answered by: {answer.provider}</p>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-copilot-evidence">
        <h2 id="tm-copilot-evidence" className="tm-eyebrow">
          Evidence
        </h2>
        {answer.evidence.length === 0 ? (
          <p className="tm-muted tm-prose">No sources were cited for this answer.</p>
        ) : (
          <ul className="tm-stack tm-list" aria-label="Evidence behind this answer">
            {answer.evidence.map((item) => (
              <li key={`${item.source}:${item.link}`} className="tm-prose">
                <Link href={`/${encodeURIComponent(organizationSlug)}${item.link}`}>
                  {item.source}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-copilot-boundary">
        <h2 id="tm-copilot-boundary" className="tm-eyebrow">
          Permission boundary
        </h2>
        <p className="tm-prose">
          <span className="tm-eyebrow tm-muted">Scope</span>{' '}
          {SCOPE_LABEL[answer.permissionBoundary.scope]}
        </p>
        <p className="tm-prose">Can see: {answer.permissionBoundary.canSee}.</p>
        <p className="tm-prose">Cannot see: {answer.permissionBoundary.cannotSee}.</p>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-copilot-next">
        <h2 id="tm-copilot-next" className="tm-eyebrow">
          Next safe action
        </h2>
        {nextActionHref ? (
          <div>
            <Link href={nextActionHref} className="tm-button">
              {answer.nextSafeAction}
            </Link>
          </div>
        ) : (
          <p className="tm-prose">{answer.nextSafeAction}</p>
        )}
      </section>
    </>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
