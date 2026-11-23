'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  DEFAULT_MODULE_ENABLED,
  OPTIONAL_MODULE_FLAGS,
  PLAN_52_FLAG_LABELS,
  listFeatureFlags,
  setFeatureFlag,
} from '../../lib/api/admin-feature-flags';
import type {
  FeatureFlagAdminView,
  FeatureFlagsAdminView,
  OptionalModuleFlag,
} from '../../lib/api/admin-feature-flags';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useOrganizationName } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { appIntlLocale } from '../../lib/i18n/app-locale';

export interface AdminFeatureFlagsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

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
  organizationName: passedOrganizationName,
  client,
}: AdminFeatureFlagsScreenProps) {
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const organizationName = useOrganizationName(organizationSlug, passedOrganizationName);
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
  const tOr = useTOr();
  const queryKey = ['admin-feature-flags', organizationSlug];

  /** Human labels for the optional-module flags, keyed by the id the API validates against. */
  const flagLabels: Record<OptionalModuleFlag, string> = {
    chat: t('AdminFeatureFlagsScreen.flagChat'),
    meetings: t('AdminFeatureFlagsScreen.flagMeetings'),
    docs: t('AdminFeatureFlagsScreen.flagDocs'),
    people: t('AdminFeatureFlagsScreen.flagPeople'),
    insights: t('AdminFeatureFlagsScreen.flagInsights'),
    automations: t('AdminFeatureFlagsScreen.flagAutomations'),
    client_portal: t('AdminFeatureFlagsScreen.flagClientPortal'),
    billing: t('AdminFeatureFlagsScreen.flagBilling'),
    copilot: t('AdminFeatureFlagsScreen.flagCopilot'),
    time_tracking: t(PLAN_52_FLAG_LABELS.time_tracking),
    finance_rates_budgets: t(PLAN_52_FLAG_LABELS.finance_rates_budgets),
    expenses: t(PLAN_52_FLAG_LABELS.expenses),
    quotes: t(PLAN_52_FLAG_LABELS.quotes),
    client_invoicing: t(PLAN_52_FLAG_LABELS.client_invoicing),
    einvoicing_ksa: t(PLAN_52_FLAG_LABELS.einvoicing_ksa),
    finance_reports: t(PLAN_52_FLAG_LABELS.finance_reports),
    proofing: t(PLAN_52_FLAG_LABELS.proofing),
    approval_links: t(PLAN_52_FLAG_LABELS.approval_links),
    public_forms: t(PLAN_52_FLAG_LABELS.public_forms),
    business_briefing: tOr('FeatureFlags.businessBriefing', 'Business briefing'),
    ai_digest_wording: tOr('FeatureFlags.aiDigestWording', 'AI wording of the weekly digest'),
  };

  /** A short "when last changed" note, or the module's default for a flag never set. */
  const changedNote = (flag: FeatureFlagAdminView): string => {
    if (!flag.updatedAt) {
      return DEFAULT_MODULE_ENABLED[flag.key]
        ? t('AdminFeatureFlagsScreen.onByDefault')
        : t('AdminFeatureFlagsScreen.offByDefault');
    }
    return `${t('AdminFeatureFlagsScreen.changedPrefix')} ${new Date(flag.updatedAt).toLocaleDateString(appIntlLocale())}`;
  };

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

  const ordered = flags.isSuccess ? orderFlags(flags.data.flags) : [];
  const onCount = ordered.filter((flag) => flag.enabled).length;

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="modules"
      crumbs={[t('AdminFeatureFlagsScreen.crumbModules')]}
      title={t('AdminFeatureFlagsScreen.title')}
      {...(flags.isSuccess
        ? {
            titleMeta: `${onCount} ${t('AdminFeatureFlagsScreen.ofConnector')} ${ordered.length} ${t('AdminFeatureFlagsScreen.modulesOnSuffix')}`,
          }
        : {})}
    >
      {flags.isPending ? (
        <LoadingRegion label={t('AdminFeatureFlagsScreen.loading')}>
          <Skeleton />
        </LoadingRegion>
      ) : flags.isError ? (
        <InlineAlert tone="danger" title={t('AdminFeatureFlagsScreen.loadError')}>
          {errorMessage(flags.error)}
        </InlineAlert>
      ) : (
        <div className="tm-cc-split tm-cc-split--even">
          <section className="tm-cc-card" aria-labelledby="tm-feature-flags-heading">
            <h2 id="tm-feature-flags-heading" className="tm-cc-eyebrow">
              {t('AdminFeatureFlagsScreen.optionalModulesHeading')}
            </h2>

            {toggle.isError ? (
              <InlineAlert tone="danger" title={t('AdminFeatureFlagsScreen.saveError')}>
                {errorMessage(toggle.error)}
              </InlineAlert>
            ) : null}

            <ul className="tm-cc-rows" aria-label={t('AdminFeatureFlagsScreen.listLabel')}>
              {ordered.map((flag) => (
                <li key={flag.key}>
                  <div className="tm-cc-rows__text">
                    <label className="tm-cc-rows__title" htmlFor={`tm-flag-${flag.key}`}>
                      {flagLabels[flag.key]}
                    </label>
                    <span className="tm-cc-rows__sub">{changedNote(flag)}</span>
                  </div>
                  <input
                    id={`tm-flag-${flag.key}`}
                    className="tm-switch"
                    type="checkbox"
                    role="switch"
                    checked={flag.enabled}
                    disabled={toggle.isPending}
                    onChange={(event) =>
                      toggle.mutate({ key: flag.key, enabled: event.target.checked })
                    }
                  />
                </li>
              ))}
            </ul>
          </section>

          <section
            className="tm-cc-card tm-cc-card--quiet tm-cc-card--fill"
            aria-labelledby="tm-feature-flags-effect"
          >
            <p className="tm-cc-eyebrow">{t('AdminFeatureFlagsScreen.switchingEyebrow')}</p>
            <h2 id="tm-feature-flags-effect" className="tm-cc-card__title">
              {t('AdminFeatureFlagsScreen.applyToEveryonePrefix')} {organizationName}
            </h2>
            <p className="tm-cc-card__body">{t('AdminFeatureFlagsScreen.effectBody')}</p>
          </section>
        </div>
      )}
    </ControlCenterShell>
  );
}

function orderFlags(flags: readonly FeatureFlagAdminView[]): FeatureFlagAdminView[] {
  const byKey = new Map(flags.map((f) => [f.key, f]));
  return OPTIONAL_MODULE_FLAGS.map(
    (key) =>
      byKey.get(key) ?? {
        key,
        enabled: DEFAULT_MODULE_ENABLED[key],
        updatedBy: null,
        updatedAt: null,
      },
  );
}
