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
 * The only state in which file content may be served to any principal other than the
 * uploader or an authorized processing job.
 *
 * `23-ERD §10`. Read paths assert against this rather than testing `!== 'rejected'`,
 * because a file still `scanning` is equally unsafe to serve.
 */
export const SERVABLE_UPLOAD_STATES: readonly UploadState[] = ['ready'];

export function isServable(state: UploadState): boolean {
  return SERVABLE_UPLOAD_STATES.includes(state);
}
