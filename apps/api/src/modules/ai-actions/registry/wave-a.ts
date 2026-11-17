/**
 * AI action registry — wave A barrel (slice S2).
 *
 * Wave A of the registry (plan §7, S2): work (items, forms), projects, search, home, inbox,
 * the notifications feed and work views. Each area ships its own detail file (schemas, redaction,
 * titles, descriptions, examples); this barrel concatenates them and indexes them by op id. The
 * waves are file-disjoint, so S3 (wave B) and S4 (wave C) add their own barrels without touching
 * this one. Slice S5's `mcp/tool-catalog.ts` joins these details to the classified ops in
 * `index.ts` to build the compact and full MCP tool catalogs.
 */
import { indexById, type AiActionDetail } from './detail.js';
import { workDetails } from './work.js';
import { projectsDetails } from './projects.js';
import { searchDetails } from './search.js';
import { homeDetails } from './home.js';
import { inboxDetails } from './inbox.js';
import { notificationsDetails } from './notifications.js';
import { workViewsDetails } from './work-views.js';
import { financeDocumentDetails } from './finance-documents.js';

export const waveADetails: readonly AiActionDetail[] = [
  ...workDetails,
  ...projectsDetails,
  ...searchDetails,
  ...homeDetails,
  ...inboxDetails,
  ...notificationsDetails,
  ...workViewsDetails,
  // 52-22p: public-form triage (`work_forms.*`) is wave A; the rest of the file is wave C.
  ...financeDocumentDetails.filter((d) => d.id.startsWith('work_forms.')),
];

/** Wave-A details indexed by op id (throws on a duplicate id within the wave). */
export const waveADetailsById: ReadonlyMap<string, AiActionDetail> = indexById(waveADetails);
