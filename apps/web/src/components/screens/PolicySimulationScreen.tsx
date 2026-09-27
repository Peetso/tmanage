'use client';

import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CAPABILITIES } from '@tmanage/domain';
import { Button, Field, InlineAlert, Select } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { simulatePolicy, type PolicySimulationView } from '../../lib/api/policy-simulate';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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

  const [memberId, setMemberId] = useState('');
  const [capability, setCapability] = useState<string>(CAPABILITIES[0]);
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
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      title="Policy simulation"
      description="Dry-run a member's access. This reads the stored roles and policies; it changes nothing."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-policy-simulate-heading">
        <h2 id="tm-policy-simulate-heading" className="tm-eyebrow">
          Can this member do this?
        </h2>

        <form
          className="tm-stack"
          noValidate
          aria-label="Policy simulation"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setResult(null);
            if (!simulate.isPending && memberId.trim().length > 0) simulate.mutate();
          }}
        >
          <Field
            label="Member id"
            name="memberId"
            value={memberId}
            onChange={(event) => setMemberId(event.target.value)}
            hint="The membership id of the person to evaluate."
            required
          />
          <Select
            label="Capability"
            name="capability"
            value={capability}
            onChange={(event) => setCapability(event.target.value)}
            hint="The action to test."
          >
            {CAPABILITIES.map((cap) => (
              <option key={cap} value={cap}>
                {cap}
              </option>
            ))}
          </Select>
          <Field
            label="Project id (optional)"
            name="projectId"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            hint="Leave empty to evaluate an organization-level action."
          />

          {simulate.isError ? (
            <InlineAlert tone="danger" title="Could not run the simulation" live>
              {describeError(simulate.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={simulate.isPending}
              loadingLabel="Simulating"
            >
              Simulate
            </Button>
          </div>
        </form>

        {result ? (
          <InlineAlert
            tone={result.allowed ? 'success' : 'danger'}
            title={result.allowed ? 'Allowed' : 'Denied'}
            live
          >
            <p>
              Role <strong>{result.role}</strong> — {result.detail}
            </p>
            <p>
              Deciding rule: <code>{result.decidingRule}</code>
              {result.denialCode ? <> (code {result.denialCode})</> : null}
            </p>
          </InlineAlert>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
