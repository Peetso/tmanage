/**
 * AI action registry — the Activity tab of a project and of a client (62-A2, B02).
 *
 * Both routes are reads (`read`/read): "what happened on ABC this week?" is answered from a tool,
 * not from SQL (plan 62, 62-22 knowledge pack). They run in-process as the member, so the route's
 * `@RequireCapability` and the service's parent check and per-entry read rule still apply: an
 * entry the member could not open on its own screen is not in the result, and finance entries
 * need `finance.view`. Entries are phrases built from the action — never titles, bodies or
 * amounts — so the `standard` redaction profile is enough. The op's `capability` mirrors the
 * controller (the sync test fails on drift). Wired into `index.ts` (ops) and `wave-c.ts`
 * (details) by the committer.
 */
import { ACTIVITY_KINDS } from '@tmanage/domain';
import { z } from 'zod';
import type { AiActionOp } from './types.js';
import { det, f, listArgs, type AiActionDetail } from './detail.js';

const ORG = '/v1/organizations/:orgSlug';

export const activityOps: readonly AiActionOp[] = [
  {
    id: 'activity.project.list',
    method: 'GET',
    path: `${ORG}/projects/:projectId/activity/`,
    capability: 'work.read',
    risk: 'read',
    scope: 'read',
  },
  {
    id: 'activity.client.list',
    method: 'GET',
    path: `${ORG}/client-organizations/:clientOrganizationId/activity/`,
    capability: 'org.manage',
    risk: 'read',
    scope: 'read',
  },
];

const filters = {
  kind: z.enum(ACTIVITY_KINDS).optional(),
  person: f.id(36).optional(),
  from: f.iso().optional(),
  to: f.iso().optional(),
};

export const activityDetails: readonly AiActionDetail[] = [
  det({
    id: 'activity.project.list',
    title: 'Show what happened on a project',
    description:
      'What happened on one project, newest first: tasks, files, approvals, milestones, ' +
      'requests, time and (with finance access) money. Filter by kind, person (user id) and ' +
      'date (`from`, `to`: a day or an instant). Each entry says who did what, never the content.',
    descriptionAr:
      'ما جرى في مشروع واحد، الأحدث أولاً: المهام والملفات والموافقات والمراحل والطلبات والوقت ' +
      'و(لمن لديه صلاحية المالية) المال. يمكن التصفية حسب النوع والشخص والتاريخ. ' +
      'كل سطر يقول من فعل ماذا، دون المحتوى.',
    input: listArgs(['projectId'], filters),
    redact: 'standard',
    examples: [
      {
        summary: 'What happened on the Acme website this week?',
        args: { projectId: 'prj_acme', from: '2026-11-16' },
      },
      {
        summary: 'Which files were added to Acme?',
        args: { projectId: 'prj_acme', kind: 'files' },
      },
    ],
  }),
  det({
    id: 'activity.client.list',
    title: 'Show what happened for a client',
    description:
      'What happened for one client company across the projects shared with it and its own ' +
      'invoices, quotes, expenses and requests, newest first. Same filters as the project ' +
      'activity. Each entry says who did what, never the content.',
    descriptionAr:
      'ما جرى لشركة عميل واحدة عبر المشاريع المشتركة معها وفواتيرها وعروض أسعارها ومصروفاتها ' +
      'وطلباتها، الأحدث أولاً. نفس عوامل التصفية. كل سطر يقول من فعل ماذا، دون المحتوى.',
    input: listArgs(['clientOrganizationId'], filters),
    redact: 'standard',
    examples: [
      {
        summary: 'What did we do for Acme last month?',
        args: { clientOrganizationId: 'cli_acme', from: '2026-10-01', to: '2026-10-31' },
      },
    ],
  }),
];
