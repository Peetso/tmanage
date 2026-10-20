/**
 * AI action detail — wave B barrel (slice S3).
 *
 * Collects the per-area detail arrays for the wave-B modules (conversations, docs, files,
 * calendar, decisions, approvals and the `client_requests` requests module) into one list
 * and an id index. Slice S5 (`mcp/tool-catalog.ts`) merges the wave A/B/C barrels into the
 * compact and full tool catalogs. Kept separate from `index.ts` so the registry waves do not
 * contend on one file.
 */
import { indexById, type AiActionDetail } from './detail.js';
import { conversationsDetails } from './conversations.js';
import { docsDetails } from './docs.js';
import { filesDetails } from './files.js';
import { calendarDetails } from './calendar.js';
import { decisionsDetails } from './decisions.js';
import { approvalsDetails } from './approvals.js';
import { requestsDetails } from './requests.js';

export const waveBDetails: readonly AiActionDetail[] = [
  ...conversationsDetails,
  ...docsDetails,
  ...filesDetails,
  ...calendarDetails,
  ...decisionsDetails,
  ...approvalsDetails,
  ...requestsDetails,
];

/** Wave-B details indexed by op id (throws on a duplicate id). */
export const waveBDetailsById: ReadonlyMap<string, AiActionDetail> = indexById(waveBDetails);
