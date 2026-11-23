/**
 * AI action registry — ADR-0015 part 2, the platform routes the three lane files do not hold.
 *
 * - **Keys (56-02).** `GET keys/status` and `POST keys/rotate`. Review F7 asked: "op if the
 *   response shows no raw secret; else NEVER (K3)". Neither route reads, writes or returns a key
 *   value (`keys.controller.ts`: status only; rotation queues the worker's re-encrypt job), so both
 *   are ops. Rotation is F5 (fresh re-authentication) and super-admin only in the service.
 * - **The Support-mode banner read** (`GET /v1/organizations/:orgSlug/support-session`): a tenant
 *   route (capability `approval.read`), not a platform op. It answers `{supportSession: null}` for
 *   anyone who is not the operator inside a live visit, and a bound token never acts through a
 *   support membership (F8), so for the AI it always says "not in a support visit". It was withheld
 *   under the old blanket reason; it is a plain read.
 */
import { z } from 'zod';
import type { AiActionOp, Sensitivity } from './types.js';
import { det, noArgs, type AiActionDetail } from './detail.js';
import { pop } from './platform-op.js';

/** `platform-admin/settings/keys.service.ts` ROTATABLE_PURPOSES. */
const ROTATABLE_PURPOSES = [
  'storage_token',
  'calendar_token',
  'reporter_email',
  'org_secret',
  'connector_token',
  'figma_token',
  'walkthrough_email',
  'outreach_email',
] as const;

export const corePlatformOps: readonly AiActionOp[] = [
  pop('platform.keys.status.get', 'GET', '/keys/status', 'platform.settings.edit'),
  pop('platform.keys.rotate', 'POST', '/keys/rotate', 'platform.settings.edit'),
  {
    id: 'org.support_session.get',
    method: 'GET',
    path: '/v1/organizations/:orgSlug/support-session',
    capability: 'approval.read',
    risk: 'read',
    scope: 'read',
  },
];

export const corePlatformDetails: readonly AiActionDetail[] = [
  det({
    id: 'platform.keys.status.get',
    title: 'Show the encryption key status',
    description:
      'Platform admin: for each kind of stored secret (storage tokens, calendar tokens, connector ' +
      'tokens, Figma tokens, stored e-mail addresses), which key encrypts it, whether a newer key is ' +
      'set in the server environment, and the latest rotation jobs. Never returns a key value. Needs ' +
      'the platform permission platform.settings.edit and a live Platform admin step-up (without it ' +
      'the call answers 403 reauthentication_required: ask the person to open Platform admin and ' +
      'confirm it is them).',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'See whether a key rotation is due', args: {} }],
  }),
  det({
    id: 'platform.keys.rotate',
    title: 'Rotate an encryption key',
    description:
      'Platform admin, super admin only: queue the worker job that re-encrypts one kind of stored ' +
      'secret with the newest key set in the server environment. No key value is read or shown. ' +
      'Refused with 409 when no keys are set, when the new key has not been added to the ' +
      'environment yet, or while a rotation for the same purpose runs; 403 for a non-super admin. ' +
      'Needs platform.settings.edit and a live Platform admin step-up. It goes on a card the person ' +
      'confirms, and confirming asks for the password again. Use platform.keys.status.get first to ' +
      'see which purposes can rotate.',
    input: z.object({ purpose: z.enum(ROTATABLE_PURPOSES) }).strict(),
    redact: 'standard',
    examples: [
      { summary: 'Rotate the key of stored storage tokens', args: { purpose: 'storage_token' } },
    ],
  }),
  det({
    id: 'org.support_session.get',
    title: 'Show the live support visit',
    description:
      "The caller's live Platform admin support visit in this workspace, for the banner: " +
      '{supportSession: null} for an ordinary member, and always null for the AI (an AI connection ' +
      'never acts through a support visit). Start, extend or end a visit with the platform ' +
      'support_sessions actions instead.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Check for a support visit', args: {} }],
  }),
];

export const corePlatformSensitivity: Readonly<Record<string, Sensitivity>> = {
  'platform.keys.rotate': 'destructive',
};
