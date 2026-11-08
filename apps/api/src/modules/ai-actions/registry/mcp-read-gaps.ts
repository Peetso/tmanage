/**
 * AI action details — 52-22 MCP read-gap coverage.
 *
 * These ops were classified in `index.ts` but had no detail, so `tool-catalog.ts` skipped them and
 * no MCP client could reach them. This file adds the *safe reads only* (list/get, risk `read`):
 * the writes and confirm-class ops in the same areas stay detail-less, so they remain off MCP and
 * the approval path for writes is untouched. Three reads are deliberately left out — see
 * {@link MCP_READ_GAPS_WITHHELD} — because they reach outside the workspace or expose a secret.
 */
import { z } from 'zod';
import { det, f, noArgs, pathOnly, type AiActionDetail } from './detail.js';

function strict(shape: z.ZodRawShape): z.ZodTypeAny {
  return z.object(shape).strict();
}

/** Classified reads kept off MCP on purpose, with the reason. */
export const MCP_READ_GAPS_WITHHELD: Readonly<Record<string, string>> = {
  'unfurl.get': 'fetches an arbitrary outside URL on the server',
  'inbound_email.address.get': 'the receiving address works as a secret (it can be rotated)',
  'org.settings.file_safety.get': 'security configuration is never shown to an AI principal',
};

export const mcpReadGapDetails: readonly AiActionDetail[] = [
  det({
    id: 'glossary.terms.list',
    title: 'List glossary terms',
    description: "The studio's glossary, alphabetically. Optional q filters to a term prefix.",
    input: strict({ q: f.shortText(120).optional() }),
    redact: 'standard',
    examples: [{ summary: 'Terms starting with "SLA"', args: { q: 'SLA' } }],
  }),
  det({
    id: 'message_bookmarks.list',
    title: 'List my saved messages',
    description: 'Messages you saved, newest first, across the conversations you can still read.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'All saved messages', args: {} }],
  }),
  det({
    id: 'objectives.list',
    title: 'List objectives',
    description: 'The workspace objectives (OKRs) with their progress.',
    input: strict({ limit: f.limit }),
    redact: 'standard',
    examples: [{ summary: 'First 20', args: { limit: 20 } }],
  }),
  det({
    id: 'objectives.key_results.list',
    title: 'List key results of an objective',
    description: 'The key results that measure one objective, with current and target values.',
    input: strict({ objectiveId: f.id(), limit: f.limit }),
    redact: 'standard',
    examples: [{ summary: 'One objective', args: { objectiveId: 'obj_123' } }],
  }),
  det({
    id: 'objectives.work_links.list',
    title: 'List work linked to an objective',
    description: 'The work items linked to one objective.',
    input: strict({ objectiveId: f.id(), limit: f.limit }),
    redact: 'standard',
    examples: [{ summary: 'One objective', args: { objectiveId: 'obj_123' } }],
  }),
  det({
    id: 'onboarding.tour.list',
    title: 'Show my onboarding tour',
    description: 'The steps of the getting-started tour and which ones you have finished.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'My tour', args: {} }],
  }),
  det({
    id: 'recent_documents.list',
    title: 'List recent documents',
    description:
      'Documents you opened recently. projectId narrows to one project; scope=favourites to ' +
      'your bookmarks.',
    input: strict({ projectId: f.id().optional(), scope: z.literal('favourites').optional() }),
    redact: 'standard',
    examples: [{ summary: 'My recent documents', args: {} }],
  }),
  det({
    id: 'upload_sessions.list',
    title: 'List upload sessions',
    description:
      'Your file upload reservations and their state. scope=organization is the owner view.',
    input: strict({
      projectId: f.id().optional(),
      scope: z.enum(['own', 'organization']).optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'My uploads', args: { scope: 'own' } }],
  }),
  det({
    id: 'upload_sessions.get',
    title: 'Get an upload session',
    description: 'One upload reservation: its file name, size and state.',
    input: pathOnly('uploadSessionId'),
    redact: 'standard',
    examples: [{ summary: 'One upload', args: { uploadSessionId: 'up_123' } }],
  }),
  det({
    id: 'usage.list',
    title: 'Show workspace usage',
    description: 'Storage and seat usage of the workspace against its plan limits.',
    input: noArgs(),
    redact: 'billing',
    examples: [{ summary: 'Current usage', args: {} }],
  }),
  det({
    id: 'google_drive.storage.get',
    title: 'Show the Google Drive connection',
    description: 'Whether Google Drive is connected for file attachments. No tokens are returned.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Drive status', args: {} }],
  }),
  det({
    id: 'google_drive.attachments.list',
    title: 'List Google Drive attachments',
    description: 'The Google Drive files attached to one work item.',
    input: pathOnly('workItemId'),
    redact: 'standard',
    examples: [{ summary: 'One work item', args: { workItemId: 'wi_123' } }],
  }),
  det({
    id: 'onedrive.storage.get',
    title: 'Show the OneDrive connection',
    description: 'Whether OneDrive is connected for file attachments. No tokens are returned.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'OneDrive status', args: {} }],
  }),
  det({
    id: 'onedrive.attachments.list',
    title: 'List OneDrive attachments',
    description: 'The OneDrive files attached to one work item.',
    input: pathOnly('workItemId'),
    redact: 'standard',
    examples: [{ summary: 'One work item', args: { workItemId: 'wi_123' } }],
  }),
  det({
    id: 'meeting_guests.list',
    title: 'List meeting guests',
    description: 'The outside guests invited to one meeting.',
    input: pathOnly('meetingId'),
    redact: 'people',
    examples: [{ summary: 'One meeting', args: { meetingId: 'mt_123' } }],
  }),
  det({
    id: 'iterations.list',
    title: 'List iterations of a project',
    description: 'The sprints (iterations) of one project, with dates and state.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'One project', args: { projectId: 'pr_123' } }],
  }),
  det({
    id: 'iterations.get',
    title: 'Get an iteration',
    description: 'One sprint (iteration): its dates, goal and work items.',
    input: pathOnly('iterationId'),
    redact: 'standard',
    examples: [{ summary: 'One iteration', args: { iterationId: 'it_123' } }],
  }),
  det({
    id: 'iterations.burndown',
    title: 'Show an iteration burndown',
    description: 'The remaining work per day of one sprint (iteration).',
    input: pathOnly('iterationId'),
    redact: 'standard',
    examples: [{ summary: 'One iteration', args: { iterationId: 'it_123' } }],
  }),
  det({
    id: 'inbound_email.log.get',
    title: 'List received e-mails',
    description: 'The log of e-mails received into the workspace, newest first.',
    input: strict({ cursor: f.cursor }),
    redact: 'client_safe',
    examples: [{ summary: 'Latest e-mails', args: {} }],
  }),
  det({
    id: 'inbound_email.attachments.get',
    title: 'List attachments of a received e-mail',
    description: 'The attachments of one received e-mail and their scan state. No file content.',
    input: pathOnly('id'),
    redact: 'client_safe',
    examples: [{ summary: 'One e-mail', args: { id: 'ie_123' } }],
  }),
];
