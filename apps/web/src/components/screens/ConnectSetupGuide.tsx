'use client';

import { useId, useState } from 'react';
import { Button, InlineAlert, StateCapsule, VisuallyHidden } from '@tmanage/ui';
import { fillTemplate } from '../../lib/ai-approval-presentation';
import {
  SETUP_KEY_NAMES,
  SETUP_LINKS,
  type ConnectSetupProvider,
  type ConnectSetupView,
} from '../../lib/api/connect-setup';
import { providerName, SETUP_STEPS } from '../../lib/connect-apps-explanations';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';

export interface ConnectSetupGuideProps {
  provider: ConnectSetupProvider;
  /** The provider's row from `GET /v1/platform/connect-setup`; `undefined` while loading. */
  setup: ConnectSetupView['providers'][number] | undefined;
  publicAddressSet: boolean;
  /** What went wrong last time, already in plain words, and the step that fixes it. */
  problem: { readonly ownerKey: MessageKey; readonly fixStep: number | null } | null;
  checking: boolean;
  checkFailed: boolean;
  onCheck: () => void;
  onClose: () => void;
}

/**
 * R37 · the platform owner's "Set it up" checklist (Figma "R37 Connect apps simply", Owner · Set up
 * Google). Numbered plain-language steps; each value to paste has a Copy button; each console page
 * is one link; "Check again" re-reads which providers are ready. Mirrors through the document
 * direction; URLs and key names stay left-to-right.
 */
export function ConnectSetupGuide({
  provider,
  setup,
  publicAddressSet,
  problem,
  checking,
  checkFailed,
  onCheck,
  onClose,
}: ConnectSetupGuideProps) {
  const t = useT();
  const id = useId();
  const name = providerName(provider);
  const links: Partial<Record<number, string>> = SETUP_LINKS[provider];
  const steps = Array.from({ length: SETUP_STEPS[provider] }, (_, index) => index + 1);
  const values = (step: number): readonly string[] => {
    if (step === 3) return setup?.redirectUrls ?? [];
    if (step === SETUP_STEPS[provider]) return SETUP_KEY_NAMES[provider];
    return [];
  };
  const ready = setup?.configured === true;

  return (
    <section className="tm-connect-guide" aria-labelledby={`${id}-title`}>
      <div className="tm-connect-guide__head">
        <h2 className="tm-connect-guide__title" id={`${id}-title`}>
          {fillTemplate(t('ConnectApps.guide.title'), { provider: name })}
        </h2>
        <Button tone="text" onClick={onClose}>
          {t('ConnectApps.guide.close')}
        </Button>
      </div>
      <p className="tm-connect-guide__intro">
        {t(
          provider === 'google'
            ? 'ConnectApps.guide.intro.google'
            : 'ConnectApps.guide.intro.microsoft',
        )}
      </p>
      {setup ? (
        <StateCapsule state={ready ? 'done' : 'blocked'}>
          {fillTemplate(t(ready ? 'ConnectApps.guide.ready' : 'ConnectApps.guide.notReady'), {
            provider: name,
          })}
        </StateCapsule>
      ) : null}
      {problem && !ready ? (
        <InlineAlert tone="danger">
          {fillTemplate(t(problem.ownerKey), {
            provider: name,
            step: String(problem.fixStep ?? ''),
          })}
        </InlineAlert>
      ) : null}
      {!publicAddressSet ? (
        <InlineAlert tone="warning">{t('ConnectApps.guide.addressMissing')}</InlineAlert>
      ) : null}
      <ol className="tm-connect-guide__steps">
        {steps.map((step) => {
          const link = links[step];
          return (
            <li
              key={step}
              className="tm-connect-guide__step"
              data-fix={problem?.fixStep === step ? 'true' : undefined}
            >
              <span className="tm-connect-guide__number" aria-hidden="true">
                {step}
              </span>
              <div className="tm-connect-guide__body">
                <p className="tm-connect-guide__text">
                  <VisuallyHidden>
                    {fillTemplate(t('ConnectApps.guide.stepLabel'), { step: String(step) })}{' '}
                  </VisuallyHidden>
                  {t(`ConnectApps.guide.${provider}.s${step}` as MessageKey)}
                </p>
                {values(step).map((value) => (
                  <CopyRow key={value} value={value} />
                ))}
                {link ? (
                  <a
                    className="tm-connect-guide__link"
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t(`ConnectApps.guide.${provider}.s${step}Link` as MessageKey)}
                  </a>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {checkFailed ? (
        <InlineAlert tone="danger" live>
          {t('ConnectApps.guide.checkError')}
        </InlineAlert>
      ) : null}
      <div>
        <Button
          tone="lime"
          loading={checking}
          loadingLabel={t('ConnectApps.guide.checking')}
          onClick={onCheck}
        >
          {t('ConnectApps.guide.check')}
        </Button>
      </div>
    </section>
  );
}

function CopyRow({ value }: { value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="tm-connect-guide__value-row">
      <code className="tm-connect-guide__value" dir="ltr">
        {value}
      </code>
      <Button
        tone="outline"
        aria-label={fillTemplate(t('ConnectApps.guide.copyLabel'), { value })}
        onClick={() => {
          void globalThis.navigator?.clipboard?.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {t(copied ? 'ConnectApps.guide.copied' : 'ConnectApps.guide.copy')}
      </Button>
    </div>
  );
}
