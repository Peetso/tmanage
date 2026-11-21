/**
 * AI action registry — the knowledge layer's file passages (62-24, plan 62 §4.4 level 3).
 *
 * A read (`read`/read): "what does the Acme brief say about the deadline?" is answered from the
 * passages of files the member can open. The route runs in-process as the member, so its
 * `@RequireCapability('search.use')`, the filter before rank (workspace and the member's projects)
 * and the re-check of every hit through the file's own read rule all apply. The passages are text
 * other people wrote: the chat marks them untrusted (the op id matches the untrusted pattern).
 */
import type { AiActionOp } from './types.js';
import { det, f, listArgs, type AiActionDetail } from './detail.js';

export const knowledgeOps: readonly AiActionOp[] = [
  {
    id: 'knowledge.file_passages.list',
    method: 'GET',
    path: '/v1/organizations/:orgSlug/knowledge/file-passages',
    capability: 'search.use',
    risk: 'read',
    scope: 'read',
  },
];

export const knowledgeDetails: readonly AiActionDetail[] = [
  det({
    id: 'knowledge.file_passages.list',
    title: 'Find passages in files',
    description:
      'The passages of files you can open that best answer a question, best first, each with ' +
      'its file, page and in-app link. Optionally one project. Use it to read what a brief, ' +
      'contract or report says; cite the files as links.',
    descriptionAr:
      'المقاطع من الملفات التي يمكنك فتحها والتي تجيب عن سؤال، الأفضل أولاً، مع الملف والصفحة ' +
      'ورابطه داخل التطبيق. يمكن حصرها في مشروع واحد.',
    input: listArgs([], {
      q: f.shortText(300),
      projectId: f.id().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'What does the Acme brief say about the launch date?',
        args: { q: 'Acme brief launch date' },
      },
    ],
  }),
];
