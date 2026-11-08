import type { WizardStep } from '../api/onboarding-wizard';

/** The wizard's steps in screen order (the API's `WIZARD_STEPS`). */
export const WIZARD_STEP_ORDER: readonly WizardStep[] = [
  'company',
  'work_type',
  'invite',
  'storage',
  'sample_project',
  'finish',
];

/** The step before `step`, or null on the first. */
export function previousStep(step: WizardStep): WizardStep | null {
  const index = WIZARD_STEP_ORDER.indexOf(step);
  return index > 0 ? (WIZARD_STEP_ORDER[index - 1] ?? null) : null;
}

/** The step after `step`; Finish is the last. */
export function nextStep(step: WizardStep): WizardStep {
  const index = WIZARD_STEP_ORDER.indexOf(step);
  return WIZARD_STEP_ORDER[Math.min(index + 1, WIZARD_STEP_ORDER.length - 1)] ?? 'finish';
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/**
 * Split the invite box into addresses: commas, semicolons, spaces or new lines separate them;
 * case-insensitive duplicates are dropped. Anything that is not an address is returned apart so
 * the screen can name it rather than silently drop it.
 */
export function parseInviteEmails(text: string): {
  readonly valid: readonly string[];
  readonly invalid: readonly string[];
} {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of text.split(/[\s,;]+/)) {
    const email = token.trim();
    if (email === '') continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (EMAIL.test(email) ? valid : invalid).push(email);
  }
  return { valid, invalid };
}
