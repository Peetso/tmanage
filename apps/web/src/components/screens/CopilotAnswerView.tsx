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
import type { ApiClient } from '../../lib/api/client';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { localizedPageName } from '../../lib/route-titles';
import { useDictation } from '../voice/useDictation';
import {
  MicButton,
  MicNotice,
  ReadAloudButton,
  ReadAloudSwitch,
  useReadAloudPreference,
} from '../voice/VoiceControls';
import { useDescribeApiError } from '../../lib/api/describe-error';
import '../../styles/screens/search-ai.css';

export interface CopilotAnswerViewProps {
  organizationSlug: string;
  organizationName: string;
  /** Preseed and auto-ask a question — how the Search "Ask" affordance opens straight onto an answer. */
  initialQuestion?: string;
  client?: ApiClient;
}

/** A message key for each permission-boundary scope the API can return. */
const SCOPE_KEYS: Readonly<Record<CopilotAnswer['permissionBoundary']['scope'], MessageKey>> = {
  organization: 'CopilotAnswerView.scopeOrganization',
  'assigned-projects': 'CopilotAnswerView.scopeAssignedProjects',
  'client-projection': 'CopilotAnswerView.scopeClientProjection',
};

/**
 * **AI copilot answer view (Module 16 — Search, command & AI)** — drawn as AI-01 AI workspace,
 * with SR-03's numbered citations: the question as an ink bubble, the answer card with its
 * next safe action, the composer capsule at the foot, and the evidence panel ("What it read")
 * always present on the end side with the permission boundary as its LIMITS footer.
 *
 * ## What it is honest about
 *
 * - **The provider is named.** The API reports which provider answered; the reader sees it in words
 *   (`providerLine`), so an answer put together offline from their records is never mistaken for
 *   one a model wrote. The provider's id itself is for logs, not the screen.
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
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const [draft, setDraft] = useState<string>(initialQuestion ?? '');
  const [question, setQuestion] = useState<string>(initialQuestion?.trim() ?? '');
  const dictation = useDictation({ value: draft, onChange: setDraft });
  const [readAnswersAloud, setReadAnswersAloud] = useReadAloudPreference();

  const result = useQuery({
    queryKey: ['copilot-ask', organizationSlug, question],
    queryFn: () => askCopilot(api, organizationSlug, question),
    enabled: question !== '',
  });

  const answer = result.data;
  const org = encodeURIComponent(organizationSlug);
  const locale = useActiveLocale();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (dictation.status === 'listening') dictation.stop();
    setQuestion(draft.trim());
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={t('CopilotAnswerView.title')}
      eyebrow={t('CopilotAnswerView.eyebrow')}
      actions={
        <a href="#tm-copilot-boundary" className="tm-button tm-button--outline tm-button--default">
          {t('CopilotAnswerView.whatItMayDo')}
        </a>
      }
    >
      <div className="tm-sa-copilot">
        <div className="tm-sa-thread">
          {question !== '' ? <p className="tm-sa-bubble">{question}</p> : null}

          {question === '' ? (
            <div className="tm-sa-empty">
              <p className="tm-sa-empty__title">{t('CopilotAnswerView.askToBegin')}</p>
              <p className="tm-sa-empty__body">{t('CopilotAnswerView.askToBeginBody')}</p>
            </div>
          ) : null}

          {result.isError ? (
            <InlineAlert tone="danger" title={t('CopilotAnswerView.askError')} live>
              {describeError(result.error)}
            </InlineAlert>
          ) : null}

          {question !== '' && result.isPending ? (
            <LoadingRegion label={t('CopilotAnswerView.loadingLabel')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {answer ? (
            <AnswerCard
              answer={answer}
              organizationSlug={organizationSlug}
              readAloud={readAnswersAloud}
            />
          ) : null}

          <form className="tm-sa-composer" onSubmit={onSubmit} role="search">
            <label className="tm-visually-hidden" htmlFor="tm-copilot-q">
              {t('CopilotAnswerView.composerLabel')}
            </label>
            <input
              id="tm-copilot-q"
              className="tm-sa-composer__input"
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t('CopilotAnswerView.composerPlaceholder')}
              aria-describedby="tm-copilot-hint"
            />
            <span
              id="tm-copilot-hint"
              className={dictation.status === 'listening' ? 'tm-visually-hidden' : 'tm-sa-eyebrow'}
            >
              {t('CopilotAnswerView.scopeHint')}
            </span>
            <MicButton dictation={dictation} />
            <button
              type="submit"
              className="tm-sa-send"
              aria-label={t('CopilotAnswerView.ask')}
              disabled={draft.trim() === ''}
            >
              <span aria-hidden="true">↑</span>
            </button>
          </form>
          <MicNotice dictation={dictation} showIdleHint />
        </div>

        <aside className="tm-sa-panel" aria-labelledby="tm-copilot-evidence">
          <h2 id="tm-copilot-evidence" className="tm-sa-panel__head">
            {answer
              ? `${t('CopilotAnswerView.whatItRead')} · ${(answer.evidence.length === 1
                  ? t('CopilotAnswerView.sourceCountOne')
                  : t('CopilotAnswerView.sourceCountMany')
                ).replace('{count}', String(answer.evidence.length))}`
              : t('CopilotAnswerView.whatItRead')}
          </h2>
          {answer && answer.evidence.length > 0 ? (
            <ol className="tm-sa-panel__list" aria-label={t('CopilotAnswerView.evidenceAria')}>
              {answer.evidence.map((item, index) => {
                // VR2 fix 1: the page a source points at, by name; the address stays the link.
                const place = evidencePlace(`/${org}${item.link}`, locale);
                return (
                  <li key={`${item.source}:${item.link}`} className="tm-sa-panel__item">
                    <span className="tm-sa-panel__cite" aria-hidden="true">
                      [{index + 1}]
                    </span>
                    <span className="tm-sa-panel__source">
                      <Link href={`/${org}${item.link}`}>{item.source}</Link>
                      {place === undefined ? null : (
                        <span className="tm-sa-panel__meta">{place}</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="tm-sa-panel__empty">
              {answer ? t('CopilotAnswerView.noSources') : t('CopilotAnswerView.recordsListed')}
            </p>
          )}

          <section className="tm-sa-panel__limits" aria-labelledby="tm-copilot-boundary">
            <h3 id="tm-copilot-boundary" className="tm-sa-eyebrow">
              {t('CopilotAnswerView.limits')}
            </h3>
            {answer ? (
              <>
                <p className="tm-sa-limits__scope">
                  {t(SCOPE_KEYS[answer.permissionBoundary.scope])}
                </p>
                <p>
                  {t('CopilotAnswerView.canSeePrefix')}
                  {answer.permissionBoundary.canSee}.
                </p>
                <p>
                  {t('CopilotAnswerView.cannotSeePrefix')}
                  {answer.permissionBoundary.cannotSee}.
                </p>
              </>
            ) : null}
            <p>{t('CopilotAnswerView.cannotActNote')}</p>
          </section>

          <ReadAloudSwitch checked={readAnswersAloud} onChange={setReadAnswersAloud} />
        </aside>
      </div>
    </AppShell>
  );
}

/** The answer card: the synthesis, who produced it, and the one read-only next step. */
function AnswerCard({
  answer,
  organizationSlug,
  readAloud,
}: {
  answer: CopilotAnswer;
  organizationSlug: string;
  readAloud: boolean;
}) {
  const t = useT();
  const nextActionHref =
    answer.evidence.length > 0
      ? `/${encodeURIComponent(organizationSlug)}${answer.evidence[0]!.link}`
      : null;

  return (
    <section className="tm-sa-answer" aria-labelledby="tm-copilot-answer">
      <div className="tm-sa-answer__head">
        <span className="tm-sa-answer__dot" aria-hidden="true" />
        <h2 id="tm-copilot-answer" className="tm-sa-eyebrow">
          {t('CopilotAnswerView.answerHeading')}
        </h2>
        <ReadAloudButton text={answer.answer} autoRead={readAloud} />
      </div>
      <p className="tm-sa-answer__text">{answer.answer}</p>
      <p className="tm-sa-answer__provider">{providerLine(t, answer.provider)}</p>
      <div
        className="tm-sa-answer__actions"
        aria-label={t('CopilotAnswerView.nextSafeActionAria')}
        role="group"
      >
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

/**
 * Who answered, in the reader's words. The ids are the API's provider ids (`copilot.provider.ts`,
 * `copilot.remote.provider.ts`); one the screen does not know yet is still said to be a model.
 */
function providerLine(t: ReturnType<typeof useT>, provider: string): string {
  switch (provider) {
    case 'local-stub':
      return t('CopilotAnswerView.providerOffline');
    case 'anthropic':
      return t('CopilotAnswerView.providerAnthropic');
    case 'openai':
      return t('CopilotAnswerView.providerOpenai');
    default:
      return t('CopilotAnswerView.providerOther');
  }
}

/**
 * Where an evidence link leads, in words: the page's name in `locale`, with the search words when
 * it is a search ("Search · “blocked”"). `undefined` for an address no page names, so a raw path
 * is never printed as text.
 */
export function evidencePlace(href: string, locale: string): string | undefined {
  const name = localizedPageName(href, locale);
  if (name === undefined) return undefined;
  const query = new URLSearchParams(href.split('?')[1]?.split('#')[0] ?? '').get('q')?.trim();
  return query ? `${name} · “${query}”` : name;
}
