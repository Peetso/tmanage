/**
 * AI action registry — wave C barrel (slice S4).
 *
 * Wave C of the registry (plan §7, S4): clients/portal, people, tenancy, insights, preferences,
 * admin (allowed parts), billing, automations (read/run), audit and import. Each area ships its own
 * detail file (schemas, redaction, titles, descriptions, examples); this barrel concatenates them
 * and indexes them by op id. The waves are file-disjoint, so S2 (wave A) and S3 (wave B) add their
 * own barrels without touching this one. Slice S5's `mcp/tool-catalog.ts` joins these details to
 * the classified ops in `index.ts` to build the compact and full MCP tool catalogs.
 */
import { indexById, type AiActionDetail } from './detail.js';
import { clientsDetails } from './clients.js';
import { portalDetails } from './portal.js';
import { peopleDetails } from './people.js';
import { tenancyDetails } from './tenancy.js';
import { insightsDetails } from './insights.js';
import { preferencesDetails } from './preferences.js';
import { adminDetails } from './admin.js';
import { billingDetails } from './billing.js';
import { automationsDetails } from './automations.js';
import { auditDetails } from './audit.js';
import { importDetails } from './import.js';
import { privacyDetails } from './privacy.js';
import { financeTimeDetails } from './finance-time.js';

export const waveCDetails: readonly AiActionDetail[] = [
  ...clientsDetails,
  ...portalDetails,
  ...peopleDetails,
  ...tenancyDetails,
  ...insightsDetails,
  ...preferencesDetails,
  ...adminDetails,
  ...billingDetails,
  ...automationsDetails,
  ...auditDetails,
  ...importDetails,
  ...privacyDetails,
  ...financeTimeDetails,
];

/** Wave C details indexed by op id (throws on a duplicate id within the wave). */
export const waveCDetailsById: ReadonlyMap<string, AiActionDetail> = indexById(waveCDetails);
