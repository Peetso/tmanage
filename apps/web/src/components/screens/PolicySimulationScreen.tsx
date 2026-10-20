'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Select } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { simulatePolicy, type PolicySimulationView } from '../../lib/api/policy-simulate';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { useHydrated } from '../../lib/use-hydrated';
import type { ApiClient } from '../../lib/api/client';
import { CAPABILITIES_BY_AREA, capabilityLabel } from '../../lib/capability-labels';
import { useT } from '../../lib/i18n/use-t';

export interface PolicySimulationScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Access-policy simulation (Administration module 18, x196).**
 *
 * `22-SCREEN-BY-SCREEN` §Administration. x174 lets an administrator store an access policy; this screen
 * answers the question that policy exists to inform — *would this member be allowed to do this?* It is a
 * faithful reader of the API's read-only simulator: it names a member and a capability (optionally a
 * project), and renders the decision the live evaluator would reach, with the deciding rule shown. It
 * never mutates anything — no role is granted, no policy is written.
 *
 * ## What it does, and what it cannot
 *
 * - **This is a dry run, not an editor.** It reports what the stored roles and policies decide; changing
 *   them is x174 (policies) and the role editor (x195), not here.
 * - **The decision is the API's, not the screen's.** The screen only renders the result; the API makes
 *   the call with the same evaluator the request path uses, so the answer cannot diverge from reality.
 */
export function PolicySimulationScreen({
  organizationSlug,
  organizationName,
  client,
}: PolicySimulationScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  // The standing barrier `useHydrated` documents: these are controlled inputs with no query to
  // gate on, so the fieldset below ships disabled in the server render and enables only once React
  // is live. Without it, on a cold compile the Simulate click can land before the submit handler is
  // attached and is then lost, leaving the screen with neither a result nor an error.
  const hydrated = useHydrated();

  const [memberId, setMemberId] = useState('');
  const [capability, setCapability] = useState<string>(CAPABILITIES_BY_AREA[0] ?? 'org.manage');
  const [projectId, setProjectId] = useState('');
  const [result, setResult] = useState<PolicySimulationView['result'] | null>(null);

  const simulate = useMutation({
    mutationFn: () => {
      const trimmedProject = projectId.trim();
      return simulatePolicy(api, organizationSlug, {
        memberId: memberId.trim(),
        capability,
        ...(trimmedProject.length > 0 ? { context: { projectId: trimmedProject } } : {}),
      });
    },
    onSuccess: (view) => setResult(view.result),
  });

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="policy-simulation"
      crumbs={[
        t('PolicySimulationScreen.crumbAccessPolicy'),
        t('PolicySimulationScreen.crumbSimulation'),
      ]}
      title={t('PolicySimulationScreen.title')}
      description={t('PolicySimulationScreen.description')}
      actions={
        <Link
          href={`/${organizationSlug}/policies`}
          className="tm-button tm-button--outline tm-button--compact"
        >
          {t('PolicySimulationScreen.accessPolicyLink')}
        </Link>
      }
    >
      <div className="tm-cc-split tm-cc-split--even">
        <section className="tm-cc-card" aria-labelledby="tm-policy-simulate-heading">
          <h2 id="tm-policy-simulate-heading" className="tm-cc-eyebrow">
            {t('PolicySimulationScreen.heading')}
          </h2>

          <form
            className="tm-stack"
            noValidate
            aria-label={t('PolicySimulationScreen.formLabel')}
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setResult(null);
              if (!simulate.isPending && memberId.trim().length > 0) simulate.mutate();
            }}
          >
            <fieldset className="tm-fieldset tm-cc-form" disabled={!hydrated}>
              <Field
                label={t('PolicySimulationScreen.memberIdLabel')}
                name="memberId"
                value={memberId}
                onChange={(event) => setMemberId(event.target.value)}
                hint={t('PolicySimulationScreen.memberIdHint')}
                required
              />
              <Select
                label={t('PolicySimulationScreen.capabilityLabel')}
                name="capability"
                value={capability}
                onChange={(event) => setCapability(event.target.value)}
                hint={t('PolicySimulationScreen.capabilityHint')}
              >
                {CAPABILITIES_BY_AREA.map((cap) => (
                  <option key={cap} value={cap}>
                    {capabilityLabel(cap)}
                  </option>
                ))}
              </Select>
              <Field
                label={t('PolicySimulationScreen.projectIdLabel')}
                name="projectId"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                hint={t('PolicySimulationScreen.projectIdHint')}
              />

              {simulate.isError ? (
                <InlineAlert tone="danger" title={t('PolicySimulationScreen.simErrorTitle')} live>
                  {describeError(simulate.error)}
                </InlineAlert>
              ) : null}

              <div className="tm-row">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={simulate.isPending}
                  loadingLabel={t('PolicySimulationScreen.simulating')}
                >
                  {t('PolicySimulationScreen.simulate')}
                </Button>
              </div>
            </fieldset>
          </form>
        </section>

        <section
          className={result ? 'tm-cc-card tm-cc-card--ink' : 'tm-cc-card tm-cc-card--quiet'}
          aria-labelledby="tm-policy-simulate-result"
          aria-live="polite"
        >
          {result ? (
            <>
              <p className="tm-cc-eyebrow">
                <span className="tm-cc-orb" aria-hidden="true" />
                {t('PolicySimulationScreen.resultEyebrow')}
              </p>
              <h2 id="tm-policy-simulate-result" className="tm-cc-card__lead">
                {result.allowed
                  ? t('PolicySimulationScreen.allowed')
                  : t('PolicySimulationScreen.denied')}
              </h2>
              <p className="tm-cc-card__body">
                {t('PolicySimulationScreen.roleWord')} <strong>{result.role}</strong> —{' '}
                {result.detail}
              </p>
              <hr className="tm-cc-rule" />
              <p className="tm-cc-card__body">
                {t('PolicySimulationScreen.decidingRule')} <code>{result.decidingRule}</code>
                {result.denialCode ? (
                  <>
                    {' '}
                    ({t('PolicySimulationScreen.codeWord')} {result.denialCode})
                  </>
                ) : null}
              </p>
            </>
          ) : (
            <>
              <p className="tm-cc-eyebrow">{t('PolicySimulationScreen.noSimEyebrow')}</p>
              <h2 id="tm-policy-simulate-result" className="tm-cc-card__title">
                {t('PolicySimulationScreen.noSimTitle')}
              </h2>
              <p className="tm-cc-card__body">{t('PolicySimulationScreen.noSimBody')}</p>
            </>
          )}
        </section>
      </div>
    </ControlCenterShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
