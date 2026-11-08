'use client';

import { ButtonLink } from '../../primitives';
import { useTOr } from '../../../../lib/i18n/use-t-or';
import './disclosure.css';

/** The one place a security report goes (the real support mailbox; there is no security@ box). */
export const SECURITY_REPORT_EMAIL = 'tm-support@peetrix.com';

/** The mail link the page offers: the subject is pre-filled so the report is easy to triage. */
export const SECURITY_REPORT_HREF = `mailto:${SECURITY_REPORT_EMAIL}?subject=Security`;

type Pair = readonly [key: string, label: string, value: string];

const RESPONSE_TIMES: readonly Pair[] = [
  ['first', 'First reply', 'Within 3 working days'],
  ['assess', 'Our assessment', 'Within 10 working days'],
  ['fix', 'Fix plan', 'As soon as the problem is confirmed'],
];

const IN_SCOPE: readonly (readonly [key: string, text: string])[] = [
  ['site', 'tmanage.peetrix.com and the TManage web and desktop apps'],
  ['api', 'The TManage API and sign-in'],
];

/**
 * **Report a security problem** (`/security/disclosure`, 56-17; Figma 575:32613 EN, 575:32761 AR).
 *
 * The public vulnerability-disclosure policy: where to send a report, what is in scope, the
 * safe-harbour promise and how fast we answer. Static text only — nothing is fetched or sent from
 * the page; the button is a plain `mailto:` link. `/.well-known/security.txt` points here.
 */
export function DisclosurePage() {
  const tr = useTOr();
  const K = 'SecurityDisclosure';

  return (
    <div className="tm-disc">
      <div className="tm-web-container tm-disc__content">
        <header className="tm-disc-hero">
          <p className="tm-disc-hero__eyebrow">{tr(`${K}.eyebrow`, 'Security')}</p>
          <h1 className="tm-disc-hero__title">{tr(`${K}.title`, 'Report a security problem')}</h1>
          <p className="tm-disc-hero__lede">
            {tr(
              `${K}.lede`,
              'Found a weakness in TManage? Tell us privately and we will work with you to fix it.',
            )}
          </p>
        </header>

        <section className="tm-disc-card" aria-labelledby="tm-disc-how">
          <h2 id="tm-disc-how" className="tm-disc-card__title">
            {tr(`${K}.howTitle`, 'How to report')}
          </h2>
          <p className="tm-disc-card__body">
            {tr(
              `${K}.howBody`,
              'Email {email} with “Security” in the subject. Say what you found, the steps to see it again, and how we can reach you. Please do not share it publicly until it is fixed.',
            )
              .split('{email}')
              .flatMap((part, index) =>
                index === 0
                  ? [part]
                  : [
                      <span key="email" dir="ltr" className="tm-disc-card__email">
                        {SECURITY_REPORT_EMAIL}
                      </span>,
                      part,
                    ],
              )}
          </p>
          <div>
            <ButtonLink href={SECURITY_REPORT_HREF} tone="ink" size="default">
              {tr(`${K}.howAction`, 'Email the security team')}
            </ButtonLink>
          </div>
        </section>

        <section className="tm-disc-card" aria-labelledby="tm-disc-scope">
          <h2 id="tm-disc-scope" className="tm-disc-card__title">
            {tr(`${K}.scopeTitle`, 'What is in scope')}
          </h2>
          <ul className="tm-disc-card__list">
            {IN_SCOPE.map(([key, text]) => (
              <li key={key}>{tr(`${K}.scope.${key}`, text)}</li>
            ))}
          </ul>
          <p className="tm-disc-card__note">
            {tr(
              `${K}.outOfScope`,
              'Not in scope: denial-of-service tests, social engineering, spam, and services run by other companies.',
            )}
          </p>
        </section>

        <section className="tm-disc-card" aria-labelledby="tm-disc-harbour">
          <h2 id="tm-disc-harbour" className="tm-disc-card__title">
            {tr(`${K}.harbourTitle`, 'Safe harbour')}
          </h2>
          <p className="tm-disc-card__body">
            {tr(
              `${K}.harbourBody`,
              'If you act in good faith, stay in scope, do not harm people or their data, and give us time to fix the problem, we will not take legal action against you.',
            )}
          </p>
        </section>

        <section className="tm-disc-card" aria-labelledby="tm-disc-times">
          <h2 id="tm-disc-times" className="tm-disc-card__title">
            {tr(`${K}.timesTitle`, 'How fast we answer')}
          </h2>
          <dl className="tm-disc-times">
            {RESPONSE_TIMES.map(([key, label, value]) => (
              <div key={key} className="tm-disc-times__row">
                <dt>{tr(`${K}.time.${key}.label`, label)}</dt>
                <dd>{tr(`${K}.time.${key}.value`, value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}
