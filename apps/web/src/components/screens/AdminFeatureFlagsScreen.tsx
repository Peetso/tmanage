'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  OPTIONAL_MODULE_FLAGS,
  listFeatureFlags,
  setFeatureFlag,
} from '../../lib/api/admin-feature-flags';
import type {
  FeatureFlagAdminView,
  FeatureFlagsAdminView,
  OptionalModuleFlag,
} from '../../lib/api/admin-feature-flags';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AdminFeatureFlagsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** Human labels for the optional-module flags, keyed by the id the API validates against. */
const FLAG_LABELS: Record<OptionalModuleFlag, string> = {
  chat: 'Chat and collaboration',
  meetings: 'Calendar and meetings',
  docs: 'Docs and knowledge',
  people: 'People and capacity',
  insights: 'Insights and reporting',
  automations: 'Automations and integrations',
  client_portal: 'Client Portal',
  billing: 'Billing and plan management',
  copilot: 'AI copilot',
};

/**
 * **Per-org feature flags (Administration module 18, x278).**
 *
 * `38-MODULE-MAP §3` names the optional modules an org may turn on or off; `22-SCREEN
 * §Administration`. An org admin sees every known optional module with its enabled state and who
 * last changed it, and toggles one on or off — each toggle is a single PUT behind `org.manage`,
 * scoped by the server to this studio. A key off the fixed allowlist is refused by the API; this
 * screen only ever names keys on it.
 */
export function AdminFeatureFlagsScreen({
  organizationSlug,
  organizationName,
  client,
}: AdminFeatureFlagsScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const queryKey = ['admin-feature-flags', organizationSlug];

  const flags = useQuery({
    queryKey,
    queryFn: () => listFeatureFlags(api, organizationSlug),
  });

  const toggle = useMutation({
    mutationFn: ({ key, enabled }: { key: OptionalModuleFlag; enabled: boolean }) =>
      setFeatureFlag(api, organizationSlug, key, enabled),
    onSuccess: (updated) => {
      queries.setQueryData<FeatureFlagsAdminView>(queryKey, (current) =>
        current
          ? { flags: current.flags.map((f) => (f.key === updated.key ? updated : f)) }
          : { flags: [updated] },
      );
    },
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Feature flags"
      description="Turn optional modules on or off for this organization."
    >
      {flags.isPending ? (
        <LoadingRegion label="Loading feature flags">
          <Skeleton />
        </LoadingRegion>
      ) : flags.isError ? (
        <InlineAlert tone="danger" title="We could not load the feature flags">
          {errorMessage(flags.error)}
        </InlineAlert>
      ) : (
        <section className="tm-panel tm-stack" aria-labelledby="tm-feature-flags-heading">
          <h2 id="tm-feature-flags-heading" className="tm-eyebrow">
            Optional modules
          </h2>

          {toggle.isError ? (
            <InlineAlert tone="danger" title="We could not save that change">
              {errorMessage(toggle.error)}
            </InlineAlert>
          ) : null}

          <ul className="tm-stack" aria-label="Optional modules">
            {orderFlags(flags.data.flags).map((flag) => (
              <li className="tm-field tm-field--inline" key={flag.key}>
                <input
                  id={`tm-flag-${flag.key}`}
                  className="tm-field__control"
                  type="checkbox"
                  checked={flag.enabled}
                  disabled={toggle.isPending}
                  onChange={(event) =>
                    toggle.mutate({ key: flag.key, enabled: event.target.checked })
                  }
                />
                <label className="tm-field__label" htmlFor={`tm-flag-${flag.key}`}>
                  {FLAG_LABELS[flag.key]}
                </label>
                <span className="tm-field__hint">{changedNote(flag)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </AppShell>
  );
}

/** Present the flags in the fixed allowlist order, defaulting any the API omits to off. */
function orderFlags(flags: readonly FeatureFlagAdminView[]): FeatureFlagAdminView[] {
  const byKey = new Map(flags.map((f) => [f.key, f]));
  return OPTIONAL_MODULE_FLAGS.map(
    (key) => byKey.get(key) ?? { key, enabled: false, updatedBy: null, updatedAt: null },
  );
}

/** A short "when last changed" note, or a neutral default for a flag never set. */
function changedNote(flag: FeatureFlagAdminView): string {
  if (!flag.updatedAt) return 'Never changed (default off)';
  return `Changed ${new Date(flag.updatedAt).toLocaleDateString()}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
