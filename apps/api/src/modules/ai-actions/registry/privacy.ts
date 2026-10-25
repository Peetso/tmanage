/**
 * AI action details — privacy (D5, Figma F5). Only the two reads are ops: the owner's Privacy page
 * and a member's own "My data". Requesting an export, downloading one and asking for a deletion are
 * NEVER routes (`never.ts`, `org_creation_or_account`): a person does those themselves.
 */
import { det, noArgs, type AiActionDetail } from './detail.js';

export const privacyDetails: readonly AiActionDetail[] = [
  det({
    id: 'admin.privacy.get',
    title: 'Privacy requests',
    description:
      'The company data exports, member data exports and any pending company deletion. Owners only.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Privacy page', args: {} }],
  }),
  det({
    id: 'me.privacy.get',
    title: 'My data requests',
    description: 'Your own personal-data export and any pending deletion of your account.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'My data', args: {} }],
  }),
];
