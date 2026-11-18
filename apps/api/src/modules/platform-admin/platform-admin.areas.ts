import type { DynamicModule } from '@nestjs/common';
import { PlatformActivityModule } from './activity/activity.module.js';
import { PlatformOrganizationsModule } from './organizations/organizations.module.js';
import { PlatformPeopleModule } from './people/people.module.js';
import { PlatformSettingsModule } from './settings/settings.module.js';
import { PlatformTeamModule } from './team/team.module.js';
// ---- platform-admin v2 · PA-04 ----
import { PlatformPermissionsModule } from './permissions/permissions.module.js';
// ---- platform-admin v2 · PA-05 ----
import { PlatformSupportModule } from './support/support.module.js';
// ---- platform-admin v2 · PA-08 ----
import { PlatformContentModule } from './content/content.module.js';
// ---- 55-21 · usability measurement ----
import { EaseScoreboardModule } from '../product-events/product-events.module.js';
// ---- 51-11 · e-mail deliverability ----
import { EmailDeliverabilityModule } from '../email-deliverability/email-deliverability.module.js';
// ---- 56-32 · host capacity ----
import { PlatformCapacityModule } from './health/capacity.module.js';
// ---- 56-17 · vulnerability disclosure ----
import { PlatformSecurityReportsModule } from '../security-reports/security-reports.module.js';
// ---- 56-23 · security signals ----
import { PlatformSecuritySignalsModule } from '../security-signals/security-signals.module.js';
// ---- 56-13 · incident register ----
import { PlatformIncidentsModule } from './incidents/incidents.module.js';
// ---- R37 · connect apps simply: the owner's setup checklist ----
import { PlatformConnectSetupModule } from './connect-setup/connect-setup.controller.js';
// ---- R39 · 55-17 · support inbox ----
import { PlatformSupportThreadsModule } from '../support/support.module.js';
// ---- R46 L2 · 56-21 · two-person approvals + owner notices ----
import { PlatformGovernanceModule } from './governance/governance.module.js';
// ---- 57-17 · WTP willingness-to-pay answers ----
import { PlatformPricingSurveyModule } from '../pricing-survey/pricing-survey.module.js';
// ---- 57-08 · REFERRAL partner codes ----
import { PlatformReferralsModule } from '../billing/referrals.module.js';

/**
 * Every Platform admin area, one Nest module each (platform-admin v2, PA-02 split). Each area
 * imports `platformAdminCore()` for the guard, the lookup, the audit writer and the team table.
 *
 * Append-only: a slice that adds an area appends its `register()` call at the end, under its
 * marker comment.
 */
export const PLATFORM_AREA_MODULES: DynamicModule[] = [
  // ---- platform-admin v2 · PA-02 ----
  PlatformOrganizationsModule.register(),
  PlatformPeopleModule.register(),
  PlatformSettingsModule.register(),
  PlatformActivityModule.register(),
  PlatformTeamModule.register(),
  // ---- platform-admin v2 · PA-04 ----
  PlatformPermissionsModule.register(),
  // ---- platform-admin v2 · PA-05 ----
  PlatformSupportModule.register(),
  // ---- platform-admin v2 · PA-08 ----
  PlatformContentModule.register(),
  // ---- 55-21 · usability measurement ----
  EaseScoreboardModule.register(),
  // ---- 51-11 · e-mail deliverability ----
  EmailDeliverabilityModule.register(),
  // ---- 56-32 · host capacity ----
  PlatformCapacityModule.register(),
  // ---- 56-17 · vulnerability disclosure ----
  PlatformSecurityReportsModule.register(),
  // ---- 56-23 · security signals: alert rules + platform signal list ----
  PlatformSecuritySignalsModule.register(),
  // ---- 56-13 · incident register: legal clocks, publish to the status page ----
  PlatformIncidentsModule.register(),
  // ---- R37 · connect apps simply: the owner's setup checklist ----
  PlatformConnectSetupModule.register(),
  // ---- R39 · 55-17 · support inbox: list, reply, status across organizations ----
  PlatformSupportThreadsModule.register(),
  // ---- R46 L2 · 56-21 · two-person approvals + owner notices ----
  PlatformGovernanceModule.register(),
  // ---- 57-17 · WTP: the willingness-to-pay answers list (Growth page) ----
  PlatformPricingSurveyModule.register(),
  // ---- 57-08 · REFERRAL: partner codes and their sign-up lists (Growth page) ----
  PlatformReferralsModule.register(),
];
