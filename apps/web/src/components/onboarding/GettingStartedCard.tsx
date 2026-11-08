'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LimeButton, OutlineButton, TextButton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import {
  STEP_HREF,
  completeGettingStartedStep,
  dismissGettingStarted,
  getGettingStarted,
  type ChecklistStep,
  type GettingStartedView,
} from '../../lib/api/getting-started';
import { useTOr } from '../../lib/i18n/use-t-or';

const STEP_LABEL: Readonly<Record<ChecklistStep, readonly [string, string]>> = {
  invite_teammate: ['GettingStarted.step.inviteTeammate', 'Invite a teammate'],
  create_project: ['GettingStarted.step.createProject', 'Create a project'],
  add_client: ['GettingStarted.step.addClient', 'Add a client'],
  connect_storage: ['GettingStarted.step.connectStorage', 'Connect storage'],
  set_working_hours: ['GettingStarted.step.setWorkingHours', 'Set working hours'],
  try_ai_assistant: ['GettingStarted.step.tryAiAssistant', 'Try the AI assistant'],
};

export function gettingStartedQueryKey(organizationSlug: string) {
  return ['getting-started', organizationSlug] as const;
}

/** Whether the checklist should still be offered: loaded, not dismissed, not finished. */
export function shouldOfferChecklist(view: GettingStartedView | undefined): boolean {
  return view !== undefined && !view.dismissed && view.completedCount < view.totalCount;
}

export interface GettingStartedCardProps {
  readonly organizationSlug: string;
  readonly client?: ApiClient;
}

/**
 * **55-11 — the getting-started checklist card** (Figma R49 L1, Product page 18:180).
 *
 * Six steps with a progress bar; a step is done when the company's data says so or when the
 * member marks it. "Start" opens the next unfinished step; "Hide checklist" dismisses it for this
 * member (stored server-side, so it stays hidden on every device). Logical properties mirror it
 * for Arabic. Renders nothing once dismissed or finished.
 */
export function GettingStartedCard({ organizationSlug, client }: GettingStartedCardProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const describeError = useDescribeApiError();
  const queryClient = useQueryClient();
  const queryKey = gettingStartedQueryKey(organizationSlug);
  const titleId = useId();
  const [error, setError] = useState<string | null>(null);

  const checklist = useQuery({
    queryKey,
    queryFn: () => getGettingStarted(api, organizationSlug),
  });
  const onSuccess = (view: GettingStartedView) => queryClient.setQueryData(queryKey, view);
  const onError = (cause: unknown) => setError(describeError(cause));
  const mark = useMutation({
    mutationFn: (step: ChecklistStep) => completeGettingStartedStep(api, organizationSlug, step),
    onMutate: () => setError(null),
    onSuccess,
    onError,
  });
  const dismiss = useMutation({
    mutationFn: () => dismissGettingStarted(api, organizationSlug),
    onMutate: () => setError(null),
    onSuccess,
    onError,
  });

  const view = checklist.data;
  if (!shouldOfferChecklist(view) || view === undefined) return null;
  const busy = mark.isPending || dismiss.isPending;
  const percent = Math.round((view.completedCount / view.totalCount) * 100);

  return (
    <section className="tm-gs" aria-labelledby={titleId}>
      <style href="tm-getting-started" precedence="default">
        {GETTING_STARTED_CSS}
      </style>
      <header className="tm-gs__head">
        <h2 id={titleId} className="tm-gs__title">
          {tOr('GettingStarted.title', 'Getting started')}
        </h2>
        <span className="tm-gs__meta">
          {tOr('GettingStarted.progress', '{done} of {total} done')
            .replace('{done}', String(view.completedCount))
            .replace('{total}', String(view.totalCount))}
        </span>
      </header>
      <div
        className="tm-gs__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={view.totalCount}
        aria-valuenow={view.completedCount}
        aria-label={tOr('GettingStarted.title', 'Getting started')}
      >
        <span className="tm-gs__fill" style={{ inlineSize: `${String(percent)}%` }} />
      </div>
      <ul className="tm-gs__steps">
        {view.steps.map(({ step, done }) => {
          const [key, english] = STEP_LABEL[step];
          return (
            <li key={step} className="tm-gs__step" data-done={done ? 'true' : 'false'}>
              <span className="tm-gs__dot" aria-hidden="true">
                {done ? '✓' : ''}
              </span>
              {done ? (
                <span className="tm-gs__label">
                  {tOr(key, english)}
                  <span className="tm-gs__sr"> {tOr('GettingStarted.doneSuffix', '(done)')}</span>
                </span>
              ) : (
                <>
                  <Link className="tm-gs__label" href={`/${organizationSlug}${STEP_HREF[step]}`}>
                    {tOr(key, english)}
                  </Link>
                  <TextButton
                    size="compact"
                    disabled={busy}
                    onClick={() => mark.mutate(step)}
                    aria-label={`${tOr('GettingStarted.markDone', 'Mark done')}: ${tOr(key, english)}`}
                  >
                    {tOr('GettingStarted.markDone', 'Mark done')}
                  </TextButton>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <div className="tm-gs__actions">
        {view.nextStep ? (
          <Link
            className="tm-button tm-button--lime tm-button--default"
            href={`/${organizationSlug}${STEP_HREF[view.nextStep]}`}
          >
            {tOr('GettingStarted.start', 'Start')}
          </Link>
        ) : null}
        <OutlineButton disabled={busy} onClick={() => dismiss.mutate()}>
          {tOr('GettingStarted.hide', 'Hide checklist')}
        </OutlineButton>
      </div>
    </section>
  );
}

/**
 * **55-11 — the shell's entry to the checklist**: a "Getting started 2/6" capsule in the canvas
 * header that opens the card in a popover. Hidden once the member dismisses or finishes it.
 */
export function GettingStartedLauncher({ organizationSlug, client }: GettingStartedCardProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const checklist = useQuery({
    queryKey: gettingStartedQueryKey(organizationSlug),
    queryFn: () => getGettingStarted(api, organizationSlug),
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const view = checklist.data;
  if (!shouldOfferChecklist(view) || view === undefined) return null;
  return (
    <div className="tm-gs-launch" ref={wrapper}>
      <style href="tm-getting-started" precedence="default">
        {GETTING_STARTED_CSS}
      </style>
      <LimeButton
        size="compact"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {tOr('GettingStarted.title', 'Getting started')} {view.completedCount}/{view.totalCount}
      </LimeButton>
      {open ? (
        <div id={panelId} className="tm-gs-launch__panel">
          <GettingStartedCard organizationSlug={organizationSlug} client={api} />
        </div>
      ) : null}
    </div>
  );
}

const GETTING_STARTED_CSS = `
.tm-gs { display: flex; flex-direction: column; gap: 12px; padding: 20px; background: var(--paper-0); color: var(--ink-950); border: var(--b-quiet) solid var(--line-300); border-radius: var(--r-card); }
.tm-gs__head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.tm-gs__title { margin: 0; font-size: 18px; line-height: 24px; font-weight: 700; }
.tm-gs__meta { font-size: var(--t-caption); line-height: var(--t-caption-line); color: var(--ink-650); }
.tm-gs__bar { block-size: 6px; border-radius: var(--r-capsule); background: var(--paper-150); overflow: hidden; }
.tm-gs__fill { display: block; block-size: 100%; background: var(--lime-500); border-radius: var(--r-capsule); }
.tm-gs__steps { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.tm-gs__step { display: flex; align-items: center; gap: 12px; min-block-size: 32px; font-size: var(--t-ui-md); }
.tm-gs__step[data-done='true'] .tm-gs__label { color: var(--ink-500); }
.tm-gs__label { flex: 1 1 auto; color: var(--ink-950); text-decoration: none; }
a.tm-gs__label:hover { text-decoration: underline; }
.tm-gs__dot { flex-shrink: 0; display: grid; place-items: center; inline-size: 20px; block-size: 20px; border: 2px solid var(--line-300); border-radius: var(--r-capsule); font-size: 12px; font-weight: 700; }
.tm-gs__step[data-done='true'] .tm-gs__dot { border-color: transparent; color: var(--ink-950); }
.tm-gs__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding-block-start: 4px; }
.tm-gs__sr { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.tm-gs-launch { position: relative; }
.tm-gs-launch__panel { position: absolute; inset-block-start: calc(100% + 8px); inset-inline-end: 0; z-index: 40; inline-size: min(440px, calc(100vw - 32px)); box-shadow: var(--shadow-overlay, 0 12px 32px rgb(0 0 0 / 0.12)); border-radius: var(--r-card); }
`;
