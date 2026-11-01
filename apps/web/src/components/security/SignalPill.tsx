'use client';

import { AUTOMATION_REASON_POINTS } from '../../lib/api/session-intel';
import type { AutomationVerdict, IntelAutomation } from '../../lib/api/session-intel';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';

const VERDICT_KEY: Readonly<Record<AutomationVerdict, MessageKey>> = {
  likely_person: 'SessionIntel.verdictPerson',
  unclear: 'SessionIntel.verdictUnclear',
  likely_automated: 'SessionIntel.verdictAutomated',
};

const REASON_KEY: Readonly<Record<string, MessageKey>> = {
  ua_headless: 'SessionIntel.reasonUaHeadless',
  ua_tool: 'SessionIntel.reasonUaTool',
  ch_headless: 'SessionIntel.reasonChHeadless',
  webdriver: 'SessionIntel.reasonWebdriver',
  form_too_fast: 'SessionIntel.reasonFormTooFast',
  no_keystrokes: 'SessionIntel.reasonNoKeystrokes',
  hosting_ip: 'SessionIntel.reasonHostingIp',
  tor_ip: 'SessionIntel.reasonTorIp',
  rate_high: 'SessionIntel.reasonRateHigh',
  accept_language_missing: 'SessionIntel.reasonAcceptLanguageMissing',
};

/** The catalog key of a verdict's label. */
export function verdictKey(verdict: AutomationVerdict): MessageKey {
  return VERDICT_KEY[verdict];
}

/** The catalog key of one reason code; an unknown code reads as "another signal". */
export function reasonKey(code: string): MessageKey {
  return REASON_KEY[code] ?? 'SessionIntel.reasonOther';
}

/**
 * **SignalPill** (Figma 503:29264 frames 1–3) — "Likely person / Unclear / Likely automated" for a
 * sign-in, with its reasons when asked. A hint, never a certainty: the reasons are always there to
 * read, and a missing signal is a dash, not a guess.
 */
export function SignalPill({
  automation,
  withScore = false,
  withReasons = false,
}: {
  automation: IntelAutomation | null | undefined;
  withScore?: boolean;
  withReasons?: boolean;
}) {
  const t = useT();
  if (!automation) return <span className="tm-intel-dash">—</span>;
  const label = t(verdictKey(automation.verdict));
  return (
    <span className="tm-intel-signal">
      <span className={`tm-intel-pill tm-intel-pill--${automation.verdict}`}>
        <span className="tm-intel-pill__dot" aria-hidden="true" />
        {withScore ? `${label} · ${automation.score}` : label}
      </span>
      {withReasons && automation.reasons.length > 0 ? (
        <ul className="tm-intel-reasons">
          {automation.reasons.map((code) => (
            <li key={code}>
              {t(reasonKey(code))}
              {AUTOMATION_REASON_POINTS[code] ? (
                <bdi dir="ltr" className="tm-intel-reasons__points">
                  +{AUTOMATION_REASON_POINTS[code]}
                </bdi>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}
