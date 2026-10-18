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
import '../../styles/screens/search-ai.css';

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
 * **AI copilot answer view (Module 16 — Search, command & AI)** — drawn as AI-01 AI workspace,
 * with SR-03's numbered citations: the question as an ink bubble, the answer card with its
 * next safe action, the composer capsule at the foot, and the evidence panel ("What it read")
 * always present on the end side with the permission boundary as its LIMITS footer.
 *
 * ## What it is honest about
 *
 * - **The provider is named.** The only provider wired today is the deterministic offline stub, and
 *   its id is shown, so a reader is never misled that a real model answered.
 * - **The boundary is the server's, rendered not re-derived.** The API decides what the caller may
 *   and may not see; the panel renders exactly that.
 * - **The next safe action is read-only.** It links to the first cited in-app surface, so the one
 *   affordance the panel offers can only take the person to records they could already open — the
 *   copilot never acts on their behalf. AI-01's "Review and edit the draft" / AI-02 / AI-03 have no
 *   endpoint behind them yet, so they are not drawn.
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
  const org = encodeURIComponent(organizationSlug);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuestion(draft.trim());
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Ask about the work, not the tool"
      eyebrow="Assistant · reads what you can read"
      actions={
        <a href="#tm-copilot-boundary" className="tm-sa-capsule">
          What it may do
        </a>
      }
    >
      <div className="tm-sa-copilot">
        <div className="tm-sa-thread">
          {question !== '' ? <p className="tm-sa-bubble">{question}</p> : null}

          {question === '' ? (
            <div className="tm-sa-empty">
              <p className="tm-sa-empty__title">Ask a question to begin</p>
              <p className="tm-sa-empty__body">
                Type a question below. The copilot answers from what you can already see, shows its
                evidence, and never makes changes on its own.
              </p>
            </div>
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

          {answer ? <AnswerCard answer={answer} organizationSlug={organizationSlug} /> : null}

          <form className="tm-sa-composer" onSubmit={onSubmit} role="search">
            <label className="tm-visually-hidden" htmlFor="tm-copilot-q">
              What do you want to know?
            </label>
            <input
              id="tm-copilot-q"
              className="tm-sa-composer__input"
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ask about the work you can see…"
              aria-describedby="tm-copilot-hint"
            />
            <span id="tm-copilot-hint" className="tm-sa-eyebrow">
              Scope: what you can see
            </span>
            <button
              type="submit"
              className="tm-sa-send"
              aria-label="Ask"
              disabled={draft.trim() === ''}
            >
              <span aria-hidden="true">↑</span>
            </button>
          </form>
        </div>

        <aside className="tm-sa-panel" aria-labelledby="tm-copilot-evidence">
          <h2 id="tm-copilot-evidence" className="tm-sa-panel__head">
            {answer
              ? `What it read · ${answer.evidence.length} ${answer.evidence.length === 1 ? 'source' : 'sources'}`
              : 'What it read'}
          </h2>
          {answer && answer.evidence.length > 0 ? (
            <ol className="tm-sa-panel__list" aria-label="Evidence behind this answer">
              {answer.evidence.map((item, index) => (
                <li key={`${item.source}:${item.link}`} className="tm-sa-panel__item">
                  <span className="tm-sa-panel__cite" aria-hidden="true">
                    [{index + 1}]
                  </span>
                  <span className="tm-sa-panel__source">
                    <Link href={`/${org}${item.link}`}>{item.source}</Link>
                    <span className="tm-sa-panel__meta">{item.link}</span>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="tm-sa-panel__empty">
              {answer
                ? 'No sources were cited for this answer.'
                : 'The records behind an answer are listed here, each linking to where it lives.'}
            </p>
          )}

          <section className="tm-sa-panel__limits" aria-labelledby="tm-copilot-boundary">
            <h3 id="tm-copilot-boundary" className="tm-sa-eyebrow">
              Limits
            </h3>
            {answer ? (
              <>
                <p className="tm-sa-limits__scope">
                  {SCOPE_LABEL[answer.permissionBoundary.scope]}
                </p>
                <p>Can see: {answer.permissionBoundary.canSee}.</p>
                <p>Cannot see: {answer.permissionBoundary.cannotSee}.</p>
              </>
            ) : null}
            <p>It cannot send, approve or change anything. Every one of those stays with you.</p>
          </section>
        </aside>
      </div>
    </AppShell>
  );
}

/** The answer card: the synthesis, who produced it, and the one read-only next step. */
function AnswerCard({
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
    <section className="tm-sa-answer" aria-labelledby="tm-copilot-answer">
      <div className="tm-sa-answer__head">
        <span className="tm-sa-answer__dot" aria-hidden="true" />
        <h2 id="tm-copilot-answer" className="tm-sa-eyebrow">
          Answer · nothing has been changed
        </h2>
      </div>
      <p className="tm-sa-answer__text">{answer.answer}</p>
      <p className="tm-sa-answer__provider">Answered by: {answer.provider}</p>
      <div className="tm-sa-answer__actions" aria-label="Next safe action" role="group">
        {nextActionHref ? (
          <Link href={nextActionHref} className="tm-sa-capsule tm-sa-capsule--lime">
            {answer.nextSafeAction}
          </Link>
        ) : (
          <p className="tm-sa-answer__next">{answer.nextSafeAction}</p>
        )}
      </div>
    </section>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
