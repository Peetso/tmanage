import { StateMachine, type StateMachineDefinition } from './state-machine.js';

/** `23-ERD-AND-STATE-MACHINES.md` §10. */
export const UPLOAD_STATES = [
  'created',
  'uploading',
  'uploaded',
  'verifying',
  'scanning',
  'ready',
  'rejected',
  'expired',
  'cancelled',
] as const;

export type UploadState = (typeof UPLOAD_STATES)[number];

const definition: StateMachineDefinition<UploadState> = {
  name: 'upload',
  initial: 'created',
  states: UPLOAD_STATES,
  terminal: ['ready', 'rejected', 'expired', 'cancelled'],
  transitions: [
    { from: 'created', to: 'uploading' },
    { from: 'created', to: 'expired' },
    { from: 'created', to: 'cancelled' },
    { from: 'uploading', to: 'uploaded', requires: ['byteSize'] },
    { from: 'uploading', to: 'cancelled' },
    { from: 'uploading', to: 'expired' },
    {
      from: 'uploaded',
      to: 'verifying',
      note: '04-SECURITY §6: content-signature, size, and MIME validation.',
    },
    {
      from: 'verifying',
      to: 'scanning',
      requires: ['contentHash', 'detectedMimeType'],
      note: 'US-C01: checksum and detected type are recorded before the scan stage.',
    },
    { from: 'verifying', to: 'rejected', requires: ['rejectionCode'] },
    {
      from: 'scanning',
      to: 'ready',
      requires: ['scanVerdict', 'scannedAt'],
      note:
        'US-C01 + 23-ERD §10: the file is inaccessible outside the upload owner and authorized ' +
        'processing until it reaches ready.',
    },
    { from: 'scanning', to: 'rejected', requires: ['rejectionCode'] },
    { from: 'scanning', to: 'expired' },
  ],
};

export const uploadStateMachine = new StateMachine(definition);

/**
 * The only state in which file content may be served to any principal other than an
 * authorized processing job — the uploader included: nothing is exposed before the scan.
 *
 * `23-ERD §10`. Read paths assert against this rather than testing `!== 'rejected'`,
 * because a file still `scanning` is equally unsafe to serve.
 */
export const SERVABLE_UPLOAD_STATES: readonly UploadState[] = ['ready'];

export function isServable(state: UploadState): boolean {
  return SERVABLE_UPLOAD_STATES.includes(state);
}

/**
 * FILE-002 slice C. Whether a **version** may be served: the asset `ready`, the version's
 * verdict `clean`, the version promoted to the `private` zone — three facts, together.
 *
 * The 0019 trigger holds the transition into `ready` to the latest version being clean and
 * promoted; a read path must hold the version it is about to serve to the same rule,
 * because a replacement version (`23-ERD` §10) is born in quarantine under an asset that is
 * already `ready`. The predicate takes the values as the row carries them — strings — so a
 * caller cannot satisfy it by asserting a type.
 */
export function isServableVersion(facts: {
  readonly status: string;
  readonly scanVerdict: string | null;
  readonly trustZone: string;
}): boolean {
  return (
    isServable(facts.status as UploadState) &&
    facts.scanVerdict === 'clean' &&
    facts.trustZone === 'private'
  );
}
