'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  PRICING_BAND_VALUES,
  PRICING_NOTE_MAX,
  answerPricingSurvey,
  skipPricingSurvey,
} from '../../lib/api/pricing-survey';
import type { PricingBand } from '../../lib/api/pricing-survey';
import { useTOr } from '../../lib/i18n/use-t-or';
import { PRICING_SURVEY_COPY } from './pricing-survey-copy';
import { pricingSurveyKey, pricingSurveyQuery } from './pricing-survey-query';
import type { PricingSurveyCopyKey } from './pricing-survey-copy';
import '../../styles/screens/pricing-survey.css';

function useCopy(): (key: PricingSurveyCopyKey) => string {
  const tOr = useTOr();
  return (key) => tOr(`PricingSurvey.${key}`, PRICING_SURVEY_COPY[key]);
}

/**
 * 57-17 WTP — the willingness-to-pay card on Home (Figma 717:39648 Question / 717:39966 Sent;
 * design review point 11: below "Due & at risk", "Send answer" disabled until a band is chosen).
 *
 * Draws only when the API says `show` — owners and admins, after 14 days, once per person; a
 * client never reaches My Day and the API answers `show: false` (or 403) for everyone else. A
 * failed read draws nothing: a survey must never put an error on Home. Skip hides the card at
 * once; an answer turns it into the "Sent" state until the next visit.
 */
export function PricingSurveyCard({
  api,
  organizationSlug,
}: {
  api: ApiClient;
  organizationSlug: string;
}) {
  const copy = useCopy();
  const queryClient = useQueryClient();
  const [band, setBand] = useState<PricingBand | null>(null);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<'answered' | 'skipped' | null>(null);

  const survey = useQuery(pricingSurveyQuery(api, organizationSlug));

  const settle = (outcome: 'answered' | 'skipped') => {
    setResult(outcome);
    queryClient.setQueryData(pricingSurveyKey(organizationSlug), { show: false });
  };
  // 409: already answered elsewhere (another tab) — the question is closed, so it just goes.
  const closedElsewhere = (error: unknown) =>
    error instanceof ApiRequestError && error.status === 409;

  const send = useMutation({
    mutationFn: (chosen: PricingBand) =>
      answerPricingSurvey(api, organizationSlug, {
        band: chosen,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: () => settle('answered'),
    onError: (error) => {
      if (closedElsewhere(error)) settle('skipped');
    },
  });
  const skip = useMutation({
    mutationFn: () => skipPricingSurvey(api, organizationSlug),
    onSuccess: () => settle('skipped'),
    onError: (error) => {
      if (closedElsewhere(error)) settle('skipped');
    },
  });

  if (result === 'answered') {
    return (
      <section className="tm-card tm-wtp" aria-labelledby="tm-wtp-thanks" role="status">
        <StateCapsule state="done" glyph="✓" className="tm-wtp__sent">
          {copy('sent')}
        </StateCapsule>
        <h2 id="tm-wtp-thanks" className="tm-wtp__question">
          {copy('thanks')}
        </h2>
        <p className="tm-wtp__body">{copy('sentBody')}</p>
      </section>
    );
  }
  if (result === 'skipped' || survey.data?.show !== true) return null;

  const busy = send.isPending || skip.isPending;
  const failed =
    (send.isError && !closedElsewhere(send.error)) ||
    (skip.isError && !closedElsewhere(skip.error));

  return (
    <section className="tm-card tm-wtp" aria-labelledby="tm-wtp-question">
      <p className="tm-wtp__eyebrow">{copy('eyebrow')}</p>
      <h2 id="tm-wtp-question" className="tm-wtp__question">
        {copy('question')}
      </h2>
      <p className="tm-wtp__body">{copy('body')}</p>
      <div className="tm-wtp__bands" role="radiogroup" aria-label={copy('bandsLabel')}>
        {PRICING_BAND_VALUES.map((value) => {
          const chosen = band === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={chosen}
              className="tm-chip tm-wtp__band"
              onClick={() => setBand(value)}
            >
              {chosen ? (
                <span className="tm-wtp__tick" aria-hidden="true">
                  ✓
                </span>
              ) : null}
              <bdi>{isolatePrices(copy(`band_${value}`))}</bdi>
            </button>
          );
        })}
      </div>
      <Field
        className="tm-wtp__note"
        label={copy('noteLabel')}
        placeholder={copy('notePlaceholder')}
        value={note}
        maxLength={PRICING_NOTE_MAX}
        onChange={(event) => setNote(event.target.value)}
      />
      {failed ? (
        <InlineAlert tone="danger" live>
          {copy('sendFailed')}
        </InlineAlert>
      ) : null}
      <div className="tm-wtp__actions">
        <Button
          tone="ink"
          size="accessible"
          disabled={band === null || skip.isPending}
          loading={send.isPending}
          loadingLabel={copy('sending')}
          onClick={() => {
            if (band !== null && !busy) send.mutate(band);
          }}
        >
          {copy('send')}
        </Button>
        <Button
          tone="text"
          size="accessible"
          disabled={send.isPending}
          loading={skip.isPending}
          onClick={() => {
            if (!busy) skip.mutate();
          }}
        >
          {copy('skip')}
        </Button>
        <p className="tm-wtp__once">{copy('askOnce')}</p>
      </div>
    </section>
  );
}

/**
 * Prices read left to right in every language ("$5–$9", design review fix 7): each price or
 * price range is its own LTR island, so an Arabic band reads "أقل من $5", never "5$ من أقل".
 */
function isolatePrices(text: string): ReactNode {
  const parts = text.split(/(\$\d+(?:–\$\d+)?)/u);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <bdi key={index} dir="ltr">
        {part}
      </bdi>
    ) : (
      part
    ),
  );
}
