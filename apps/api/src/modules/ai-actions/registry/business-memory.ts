/**
 * AI action registry — Business Memory (62-26, plan 62 §4.6).
 *
 * - `business_memory.facts.list` and `business_memory.facts.recall` are reads: the facts the
 *   member may read, filtered by audience and entity in the route before ordering. Their results
 *   are text people wrote, so the chat marks them untrusted (the op ids match the pattern).
 * - `business_memory.facts.propose` is confirm-class: the AI may only suggest a fact, the member
 *   sees a card first, and the fact stays `proposed` (never recalled) until a person approves it.
 * - Approving, editing, confirming and retiring are a person's decisions: NEVER entries
 *   (`never.ts`, reason `business_memory_decision`).
 */
import { z } from 'zod';
import type { AiActionOp } from './types.js';
import { bodyArgs, det, f, listArgs, type AiActionDetail } from './detail.js';

const ENTITY_TYPES = ['client', 'project', 'person', 'process', 'company'] as const;
const AUDIENCES = ['internal', 'client_visible', 'finance', 'hr'] as const;
const CATEGORIES = [
  'preference',
  'policy',
  'contact',
  'billing',
  'delivery',
  'process',
  'other',
] as const;

export const businessMemoryOps: readonly AiActionOp[] = [
  {
    id: 'business_memory.facts.list',
    method: 'GET',
    path: '/v1/organizations/:orgSlug/business-memory/facts',
    capability: 'ai.use',
    risk: 'read',
    scope: 'read',
  },
  {
    id: 'business_memory.facts.recall',
    method: 'GET',
    path: '/v1/organizations/:orgSlug/business-memory/recall',
    capability: 'ai.use',
    risk: 'read',
    scope: 'read',
  },
  {
    id: 'business_memory.facts.propose',
    method: 'POST',
    path: '/v1/organizations/:orgSlug/business-memory/facts',
    capability: 'ai.use',
    risk: 'confirm',
    scope: 'write',
  },
];

export const businessMemoryDetails: readonly AiActionDetail[] = [
  det({
    id: 'business_memory.facts.list',
    title: 'List Business Memory facts',
    description:
      'The approved facts the workspace keeps about its clients, projects, people, processes ' +
      'and company that you may read, newest first. Optionally one status, entity or only the ' +
      'stale ones (not confirmed for 180 days).',
    descriptionAr:
      'الحقائق المعتمدة التي تحفظها مساحة العمل عن عملائها ومشاريعها وأفرادها وإجراءاتها ' +
      'وشركتها، مما يحق لك قراءته، الأحدث أولاً.',
    input: listArgs([], {
      status: z.enum(['proposed', 'approved', 'retired', 'all']).optional(),
      entityType: z.enum(ENTITY_TYPES).optional(),
      entityId: f.id().optional(),
      stale: z.enum(['true', 'false']).optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Stale facts', args: { stale: 'true' } }],
  }),
  det({
    id: 'business_memory.facts.recall',
    title: 'Recall Business Memory',
    description:
      'At most eight approved facts about the named entities (client:<id>, project:<id>, ' +
      'person:<id>, process, company; up to five, comma separated) that you may read.',
    descriptionAr: 'ثماني حقائق معتمدة على الأكثر عن الكيانات المذكورة مما يحق لك قراءته.',
    input: listArgs([], { entities: f.shortText(300) }),
    redact: 'standard',
    examples: [{ summary: 'What do we know about this client?', args: { entities: 'company' } }],
  }),
  det({
    id: 'business_memory.facts.propose',
    title: 'Propose a Business Memory fact',
    description:
      'Suggest one lasting fact (one line, at most 500 characters) about a client, project, ' +
      'person, process or the company. It is saved as a proposal only; a person must approve ' +
      'it before it is used. Confirm-class: needs your approval before it runs.',
    descriptionAr:
      'اقتراح حقيقة دائمة واحدة عن عميل أو مشروع أو شخص أو إجراء أو الشركة. تُحفظ اقتراحاً ' +
      'فقط، ولا تُستخدم حتى يعتمدها شخص.',
    input: bodyArgs([], {
      entityType: z.enum(ENTITY_TYPES),
      entityId: f.id().optional(),
      fact: f.shortText(500),
      category: z.enum(CATEGORIES),
      audience: z.enum(AUDIENCES).optional(),
      sourceHref: f.shortText(500).optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'The client wants invoices in AED',
        args: {
          entityType: 'client',
          entityId: '0190a000-0000-7000-8000-000000000001',
          fact: 'Invoices to this client are issued in AED.',
          category: 'billing',
          audience: 'finance',
        },
      },
    ],
  }),
];
