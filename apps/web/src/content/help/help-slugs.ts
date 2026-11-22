/**
 * The slugs of the Help centre articles (`/help/<slug>`), without their content (SEOE,
 * 2026-11-17): the Arabic twin table reads these, so the articles stay out of every public page's
 * bundle. `compare-slugs.test.tsx` keeps them equal to the slugs of `HELP_ARTICLES`, in order.
 */
export const HELP_SLUGS = [
  'create-your-workspace',
  'invite-your-team',
  'start-a-project',
  'milestones-and-dates',
  'create-and-assign-tasks',
  'task-approval',
  'invite-a-client',
  'what-clients-see',
  'upload-and-share-files',
  'connect-drive-onedrive',
  'log-time-timesheets',
  'invoices-and-expenses',
  'two-step-sign-in',
  'sessions-and-devices',
  'export-from-monday',
  'export-from-asana',
  'export-from-clickup',
  'export-from-trello',
  'export-from-basecamp',
  'export-from-jira',
  'connect-an-ai-assistant',
  // 55-15p: the ready-made AI requests (`ai-recipes.ts`).
  'ai-recipes',
  'ai-recipe-plan-my-week',
  'ai-recipe-client-update',
  'ai-recipe-sort-inbox',
  'ai-recipe-whats-overdue',
  'ai-recipe-notes-to-tasks',
  'ai-recipe-summarise-document',
  'ai-recipe-draft-reply',
  // 57-07 (MENA): the Arabic-first starter set (`arabic-help.ts`).
  'switch-to-arabic',
  'arabic-and-english-workspace',
  'arabic-dates-and-numbers',
  'send-for-client-approval',
  'check-an-approval-record',
  // Plan 62-20: TManage AI (`tmanage-ai-help.ts`).
  'tmanage-ai',
] as const;

export type HelpSlug = (typeof HELP_SLUGS)[number];
