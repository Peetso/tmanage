/**
 * QA-FIX-R M6 — the length limits a person meets in a form and the API enforces, decided once.
 *
 * Before this file the API held its own constant (work item title 300, project name 190) and
 * each form guessed: quick capture allowed 500 characters and the new-project form none, so a
 * long title passed the form and came back as one generic "request body is invalid". The API
 * imports these to refuse, the web imports the same values for `maxLength` (AR-8: one rule,
 * one place; NN/g error-message guidelines: prevent the error before it happens).
 *
 * The widths follow the columns: `projects.name` is as wide as `organizations.name` (190), and a
 * work item or subtask title is 300.
 */
export const WORK_ITEM_TITLE_MAX = 300;
export const PROJECT_NAME_MAX = 190;
