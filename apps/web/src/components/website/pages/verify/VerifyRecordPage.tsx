'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Field, InlineAlert, StateCapsule } from '@tmanage/ui';
import { browserApiClient } from '../../../../lib/api/browser-client';
import type { ApiClient } from '../../../../lib/api/client';
import {
  readVerifyFragment,
  verifyApprovalRecord,
  type PublicRecordVerdictView,
} from '../../../../lib/api/approval-records';
import { ApiRequestError } from '../../../../lib/api/errors';
import { formatDay, formatTime } from '../../../../lib/i18n/format';
import { useActiveLocale } from '../../../../lib/i18n/use-active-locale';
import { useTOr } from '../../../../lib/i18n/use-t-or';
import { useHydrated } from '../../../../lib/use-hydrated';
import { SectionHeader, WebSection } from '../../sections';
import './verify.css';

/** The longest value either field takes; the API reads no more. */
const MAX_INPUT = 200;

type Failure = 'required' | 'rate_limited' | 'failed';

export interface VerifyRecordPageProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * 52-19 (web half) — `/verify` and `/ar/verify`, Figma 714:39384 / 714:39705 (genuine),
 * 714:39492 / 714:39813 (not found), 714:39598 / 714:39919 (altered), with the design review's
 * points 10, 13, 14 and 15. No sign-in: whoever holds a certificate pastes its record ID and
 * fingerprint, or opens the certificate's link, whose `#record=…&fingerprint=…` fragment fills the
 * form and checks at once (a fragment never reaches a server). The answer is the verdict, the date
 * (genuine only, in UTC) and the workspace name, nothing else.
 */
export function VerifyRecordPage({ client }: VerifyRecordPageProps) {
  const tOr = useTOr();
  const hydrated = useHydrated();
  const [recordId, setRecordId] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<PublicRecordVerdictView | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function check(input: { recordId: string; fingerprint: string }) {
    const id = input.recordId.trim();
    const print = input.fingerprint.trim();
    setResult(null);
    if (id === '' || print === '') {
      setFailure('required');
      return;
    }
    setFailure(null);
    setChecking(true);
    try {
      const api = client ?? browserApiClient();
      setResult(await verifyApprovalRecord(api, { recordId: id, fingerprint: print }));
    } catch (error) {
      setFailure(
        error instanceof ApiRequestError && error.status === 429 ? 'rate_limited' : 'failed',
      );
    } finally {
      setChecking(false);
    }
  }

  // The certificate's link: fill the form from the fragment and check once.
  useEffect(() => {
    const linked = readVerifyFragment(window.location.hash);
    if (linked.recordId === '' && linked.fingerprint === '') return;
    setRecordId(linked.recordId);
    setFingerprint(linked.fingerprint);
    void check(linked);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void check({ recordId, fingerprint });
  }

  return (
    <WebSection className="tm-web-verify" aria-labelledby="verify-title">
      <div className="tm-web-verify__column">
        <SectionHeader
          as="h1"
          size="page"
          id="verify-title"
          eyebrow={tOr('VerifyRecord.eyebrow', 'Approval record')}
          title={tOr('VerifyRecord.title', 'Verify this approval record')}
          lede={tOr(
            'VerifyRecord.intro',
            'Paste the record ID and the fingerprint printed on the certificate. This page only tells you whether the record is genuine, the date and the workspace name.',
          )}
        />
        <form
          noValidate
          className="tm-web-verify__card"
          onSubmit={submit}
          aria-label={tOr('VerifyRecord.title', 'Verify this approval record')}
        >
          <fieldset className="tm-fieldset tm-web-verify__fields" disabled={!hydrated}>
            <Field
              label={tOr('VerifyRecord.recordIdLabel', 'Record ID')}
              hint={tOr(
                'VerifyRecord.recordIdHint',
                'Printed under “Check this record” on the certificate.',
              )}
              name="recordId"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              maxLength={MAX_INPUT}
              value={recordId}
              onChange={(event) => setRecordId(event.target.value)}
              error={
                failure === 'required' && recordId.trim() === ''
                  ? tOr('VerifyRecord.required', 'Enter both the record ID and the fingerprint.')
                  : undefined
              }
            />
            <Field
              label={tOr('VerifyRecord.fingerprintLabel', 'Fingerprint')}
              hint={tOr(
                'VerifyRecord.fingerprintHint',
                'The long line of letters and numbers on the certificate.',
              )}
              name="fingerprint"
              dir="ltr"
              className="tm-web-verify__mono"
              autoComplete="off"
              spellCheck={false}
              maxLength={MAX_INPUT}
              value={fingerprint}
              onChange={(event) => setFingerprint(event.target.value)}
              error={
                failure === 'required' && fingerprint.trim() === ''
                  ? tOr('VerifyRecord.required', 'Enter both the record ID and the fingerprint.')
                  : undefined
              }
            />
            {failure === 'rate_limited' ? (
              <InlineAlert tone="warning" live>
                {tOr('VerifyRecord.rateLimited', 'Too many checks. Try again in a minute.')}
              </InlineAlert>
            ) : null}
            {failure === 'failed' ? (
              <InlineAlert tone="danger" live>
                {tOr(
                  'VerifyRecord.failed',
                  'The record could not be checked. Check your connection and try again.',
                )}
              </InlineAlert>
            ) : null}
            <div>
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={checking}
                loadingLabel={tOr('VerifyRecord.checking', 'Checking the record')}
              >
                {tOr('VerifyRecord.submit', 'Check record')}
              </Button>
            </div>
          </fieldset>
        </form>
        <div role="status" aria-live="polite" className="tm-web-verify__status">
          {result ? <VerdictCard result={result} /> : null}
        </div>
      </div>
    </WebSection>
  );
}

function VerdictCard({ result }: { result: PublicRecordVerdictView }) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const workspace =
    result.workspaceName !== null && result.workspaceName !== '' ? (
      <p className="tm-web-verify__fact">
        {tOr('VerifyRecord.workspace', 'Workspace: {name}').split('{name}')[0]}
        <bdi>{result.workspaceName}</bdi>
        {tOr('VerifyRecord.workspace', 'Workspace: {name}').split('{name}')[1] ?? ''}
      </p>
    ) : null;

  if (result.verdict === 'genuine') {
    const at = result.decidedAt;
    const sentence =
      result.decision === 'changes_requested'
        ? tOr('VerifyRecord.changesOn', 'Changes asked for on {date} at {time}')
        : result.decision === 'signed'
          ? tOr('VerifyRecord.signedOn', 'Signed on {date} at {time}')
          : tOr('VerifyRecord.approvedOn', 'Approved on {date} at {time}');
    return (
      <section
        className="tm-web-verify__card tm-web-verify__result"
        aria-labelledby="verify-verdict"
      >
        <StateCapsule state="done">{tOr('VerifyRecord.genuineCapsule', 'Genuine')}</StateCapsule>
        <h2 id="verify-verdict" className="tm-web-verify__verdict">
          {tOr('VerifyRecord.genuineTitle', 'This record is genuine')}
        </h2>
        {at !== null ? (
          <p className="tm-web-verify__fact">
            {sentence
              .replace(
                '{date}',
                formatDay(
                  at,
                  { locale, timeZone: 'UTC' },
                  {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  },
                ),
              )
              .replace(
                '{time}',
                formatTime(
                  at,
                  { locale, timeZone: 'UTC' },
                  {
                    hour: '2-digit',
                    minute: '2-digit',
                    hourCycle: 'h23',
                  },
                ),
              )}{' '}
            <span className="tm-web-verify__zone" dir="ltr">
              UTC
            </span>
          </p>
        ) : null}
        {workspace}
        <p className="tm-web-verify__body">
          {result.decision === 'approved'
            ? tOr(
                'VerifyRecord.genuineBody',
                'The approved file is the file on the record. Nothing has changed since.',
              )
            : tOr(
                'VerifyRecord.genuineBodyOther',
                'Nothing in this record has changed since it was saved.',
              )}
        </p>
      </section>
    );
  }

  if (result.verdict === 'altered') {
    return (
      <section
        className="tm-web-verify__card tm-web-verify__result"
        aria-labelledby="verify-verdict"
      >
        <StateCapsule state="blocked">{tOr('VerifyRecord.alteredCapsule', 'Altered')}</StateCapsule>
        <h2 id="verify-verdict" className="tm-web-verify__verdict">
          {tOr('VerifyRecord.alteredTitle', 'This record has been altered')}
        </h2>
        {workspace}
        <p className="tm-web-verify__body">
          {tOr(
            'VerifyRecord.alteredBody',
            'The record exists, but it no longer matches what was saved when it was approved. Do not rely on it. Ask the company that sent it for a new certificate.',
          )}
        </p>
      </section>
    );
  }

  return (
    <section className="tm-web-verify__card tm-web-verify__result" aria-labelledby="verify-verdict">
      <StateCapsule state="neutral">
        {tOr('VerifyRecord.notFoundCapsule', 'Not found')}
      </StateCapsule>
      <h2 id="verify-verdict" className="tm-web-verify__verdict">
        {tOr('VerifyRecord.notFoundTitle', 'We could not find this record')}
      </h2>
      <p className="tm-web-verify__body">
        {tOr(
          'VerifyRecord.notFoundBody',
          'No record matches this ID and fingerprint. Check both for typing errors, or ask the company that sent you the certificate.',
        )}
      </p>
    </section>
  );
}
