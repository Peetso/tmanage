/**
 * AI action details — approvals (internal approval workflow and client-facing deliverable
 * projections/decisions).
 *
 * Slice S3 (registry wave B). Enrichment for the ops classified in `index.ts`; see `detail.ts`.
 * Deciding, delegating, adding steps and publishing a projection are confirm-class and notify
 * people. Client-facing projection ops use the `client_safe` profile: the published projection is
 * the 12-PERMISSION-MATRIX §1 allowlist only (title, summary, milestoneState, forecastDate,
 * publishedRisk, decision, approvedContacts — see `approvals.controller.ts`), never internal
 * cost/estimate/review/rationale fields.
 */
import { z } from 'zod';
import { det, queryArgs, noArgs, pathOnly, bodyArgs, f, type AiActionDetail } from './detail.js';

/** The reviewer decision enum mirrored from `approvals.controller.ts`. */
const decision = z.enum(['approve', 'request_changes']);
// = approvals/steps.controller.ts decide: a chain step is approved or rejected.
const stepDecision = z.enum(['approve', 'reject']);

/** The client-safe projection payload (allowlist only; the controller rejects any other key). */
const projection = z
  .object({
    title: f.shortText(300),
    summary: f.text(5_000).nullish(),
    milestoneState: f.shortText(120).nullish(),
    forecastDate: f.iso().nullish(),
    publishedRisk: f.shortText(120).nullish(),
    decision: f.shortText(40).nullish(),
    approvedContacts: z.array(f.shortText(200)).max(100).optional(),
  })
  .strict();

export const approvalsDetails: readonly AiActionDetail[] = [
  det({
    id: 'approvals.create',
    title: 'Open an approval',
    description:
      'Open an approval on a deliverable version and request reviewers. Reviewers are notified.',
    input: bodyArgs([], {
      deliverableVersionId: f.id(),
      reviewerIds: z.array(f.id()).min(1).max(50),
      policy: f.shortText(40).optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'Request review',
        args: { deliverableVersionId: 'dv_1', reviewerIds: ['user_3'] },
      },
    ],
  }),
  det({
    id: 'approvals.decision.create',
    title: 'Decide an approval',
    description:
      'Approve or request changes on an approval. version is the approval’s current version, as ' +
      'returned when it was opened or last read (a stale one is refused). Confirm-class; the ' +
      'requester is notified.',
    input: bodyArgs(['approvalId'], {
      decision,
      version: f
        .int(1, 2_147_483_647)
        .describe('The approval’s current version (from the approval you read)'),
      feedback: f.text(5_000).optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      { summary: 'Approve', args: { approvalId: 'appr_1', decision: 'approve', version: 3 } },
    ],
  }),
  det({
    id: 'approvals.steps.list',
    title: 'List approval steps',
    description: 'The review steps of an approval.',
    input: queryArgs(['approvalId']),
    redact: 'standard',
    examples: [{ summary: 'Steps', args: { approvalId: 'appr_1' } }],
  }),
  det({
    id: 'approvals.steps.create',
    title: 'Set the approval steps',
    description:
      'Define the review chain of an approval: each step has a unique position (0 to 1000), the ' +
      'approver role, and optionally one approver user. Confirm-class; reviewers are notified.',
    input: bodyArgs(['approvalId'], {
      steps: z
        .array(
          z
            .object({
              position: f.int(0, 1000),
              approverRole: f.shortText(64),
              approverUserId: f.id().nullable().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(50),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'Add step',
        args: {
          approvalId: 'appr_1',
          steps: [
            { position: 0, approverRole: 'project_lead' },
            { position: 1, approverRole: 'client', approverUserId: 'user_4' },
          ],
        },
      },
    ],
  }),
  det({
    id: 'approvals.steps.set',
    title: 'Decide an approval step',
    description: 'Approve or reject the active step of an approval chain. Confirm-class.',
    input: bodyArgs(['approvalId', 'stepId'], { decision: stepDecision }),
    redact: 'standard',
    examples: [
      {
        summary: 'Approve step',
        args: { approvalId: 'appr_1', stepId: 'step_2', decision: 'approve' },
      },
    ],
  }),
  det({
    id: 'approvals.delegations.list',
    title: 'List approval delegations',
    description: 'Who approvals are delegated to, and when.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'Delegations', args: {} }],
  }),
  det({
    id: 'approvals.delegations.create',
    title: 'Delegate approvals',
    description:
      'Delegate your approvals to another member from startsAt to endsAt (ISO instants). ' +
      'Confirm-class; they are notified.',
    input: bodyArgs([], {
      delegateMembershipId: f.id(),
      startsAt: f.iso(),
      endsAt: f.iso(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'Delegate',
        args: {
          delegateMembershipId: 'mem_5',
          startsAt: '2026-12-01T00:00:00Z',
          endsAt: '2026-12-15T00:00:00Z',
        },
      },
    ],
  }),
  det({
    id: 'approvals.delegations.delete',
    title: 'Remove an approval delegation',
    description: 'Cancel an approval delegation. Confirm-class.',
    input: pathOnly('delegationId'),
    redact: 'standard',
    examples: [{ summary: 'Cancel', args: { delegationId: 'del_1' } }],
  }),
  det({
    id: 'approvals.projections.create',
    title: 'Publish a client projection',
    description:
      'Freeze and publish the client-safe projection of a deliverable version. Confirm-class; ' +
      'client-visible, so only the allowlisted fields are stored.',
    input: bodyArgs([], { deliverableVersionId: f.id(), projection }),
    redact: 'client_safe',
    notifies: true,
    examples: [
      {
        summary: 'Publish',
        args: { deliverableVersionId: 'dv_1', projection: { title: 'Logo pack v2' } },
      },
    ],
  }),
  det({
    id: 'approvals.projections.get',
    title: 'Get a client projection',
    description: 'Read the published client-safe projection for a deliverable version.',
    input: pathOnly('deliverableVersionId'),
    redact: 'client_safe',
    examples: [{ summary: 'By version', args: { deliverableVersionId: 'dv_1' } }],
  }),
  det({
    id: 'approvals.projections.decision.create',
    title: 'Record a client projection decision',
    description:
      'Record the client’s approve/request-changes decision on a published projection. Confirm-class.',
    input: bodyArgs(['deliverableVersionId'], {
      decision,
      feedback: f.text(5_000).optional(),
      version: f.int(1, 100_000).optional(),
    }),
    redact: 'client_safe',
    notifies: true,
    examples: [
      { summary: 'Client approves', args: { deliverableVersionId: 'dv_1', decision: 'approve' } },
    ],
  }),
  // 52-19: the approval record — sealed decision evidence and its verification.
  det({
    id: 'approvals.record.get',
    title: 'Get an approval record',
    description:
      'Read the sealed decision records of an approval (who, which version hash, decision, when, ' +
      'from where) and whether each record still verifies.',
    input: pathOnly('approvalId'),
    redact: 'standard',
    examples: [{ summary: 'By approval', args: { approvalId: 'ap_1' } }],
  }),
  det({
    id: 'approvals.projections.record.get',
    title: 'Get my approval record for a version',
    description:
      'Read the sealed records of the caller’s own decisions on a published deliverable version.',
    input: pathOnly('deliverableVersionId'),
    redact: 'client_safe',
    examples: [{ summary: 'By version', args: { deliverableVersionId: 'dv_1' } }],
  }),
  // 0211 (audit gap 1): deliverables — create, version, send for client approval.
  det({
    id: 'approvals.deliverables.list',
    title: 'List deliverables',
    description: 'List a project’s deliverables with their approval state and latest version.',
    input: queryArgs([], { projectId: f.id() }),
    redact: 'standard',
    examples: [{ summary: 'In a project', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'approvals.deliverables.create',
    title: 'Create a deliverable',
    description: 'Create a named deliverable on a project, ready for its first version.',
    input: bodyArgs([], {
      projectId: f.id(),
      title: f.shortText(300),
      description: f.text(5_000).nullish(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Create', args: { projectId: 'proj_1', title: 'Homepage concept' } }],
  }),
  det({
    id: 'approvals.deliverables.get',
    title: 'Get a deliverable',
    description: 'Read a deliverable with every version, its note, file and approval outcome.',
    input: pathOnly('deliverableId'),
    redact: 'standard',
    examples: [{ summary: 'By id', args: { deliverableId: 'dlv_1' } }],
  }),
  det({
    id: 'approvals.deliverables.versions.create',
    title: 'Upload a deliverable version',
    description:
      'Add the next version (an uploaded deliverable file and/or a note). Any approval still ' +
      'pending on an older version is invalidated.',
    input: bodyArgs(['deliverableId'], {
      fileAssetId: f.id().nullish(),
      note: f.text(5_000).nullish(),
    }),
    redact: 'standard',
    examples: [{ summary: 'New version', args: { deliverableId: 'dlv_1', note: 'Bigger logo' } }],
  }),
  det({
    id: 'approvals.deliverables.approvers.list',
    title: 'List possible approvers',
    description: 'List the client people on the project who have approval authority.',
    input: pathOnly('deliverableId'),
    redact: 'standard',
    examples: [{ summary: 'Approvers', args: { deliverableId: 'dlv_1' } }],
  }),
  det({
    id: 'approvals.deliverables.delete',
    title: 'Delete a deliverable',
    description:
      'Delete a deliverable made by mistake; it leaves the team list and the client portal and ' +
      'can be restored. Owner or project manager; never once the client approved it. Confirm-class.',
    input: pathOnly('deliverableId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { deliverableId: 'dlv_1' } }],
  }),
  det({
    id: 'approvals.deliverables.import_drive',
    title: 'Add a Google Drive file for a new version',
    description:
      'Copy a picked Google Drive file into TManage, through the usual file checks, for the ' +
      "deliverable's next version. Add the version once the copy is ready.",
    input: bodyArgs(['deliverableId'], { fileId: f.text(128) }),
    redact: 'standard',
    examples: [{ summary: 'From Drive', args: { deliverableId: 'dlv_1', fileId: 'drv_1' } }],
  }),
  det({
    id: 'approvals.deliverables.import_onedrive',
    title: 'Add a OneDrive file for a new version',
    description:
      'Copy a picked OneDrive file into TManage, through the usual file checks, for the ' +
      "deliverable's next version. Add the version once the copy is ready.",
    input: bodyArgs(['deliverableId'], { driveId: f.text(255), itemId: f.text(255) }),
    redact: 'standard',
    examples: [
      {
        summary: 'From OneDrive',
        args: { deliverableId: 'dlv_1', driveId: 'od_drive', itemId: 'od_item' },
      },
    ],
  }),
  det({
    id: 'approvals.deliverables.restore',
    title: 'Restore a deleted deliverable',
    description: 'Bring back a deliverable that was deleted, with its shared versions.',
    input: pathOnly('deliverableId'),
    redact: 'standard',
    examples: [{ summary: 'Restore', args: { deliverableId: 'dlv_1' } }],
  }),
  det({
    id: 'approvals.deliverables.share.create',
    title: 'Share a version with the client',
    description:
      'Put the newest version in the client portal so the client can open it. ' +
      'No approval is asked and nobody is emailed. Confirm-class.',
    input: pathOnly('deliverableId', 'versionId'),
    redact: 'client_safe',
    examples: [{ summary: 'Share v2', args: { deliverableId: 'dlv_1', versionId: 'dv_2' } }],
  }),
  det({
    id: 'approvals.deliverables.send.create',
    title: 'Send a version for client approval',
    description:
      'Publish the newest version to the client and ask the chosen approvers to decide. ' +
      'Confirm-class; the approvers are emailed unless notify is false.',
    input: bodyArgs(['deliverableId', 'versionId'], {
      approverIds: z.array(f.id()).min(1).max(50),
      dueDate: f.iso().nullish(),
      checkNote: f.text(2_000).nullish(),
      notify: f.bool().optional(),
    }),
    redact: 'client_safe',
    notifies: true,
    examples: [
      {
        summary: 'Send v2',
        args: { deliverableId: 'dlv_1', versionId: 'dv_2', approverIds: ['user_9'] },
      },
    ],
  }),
  det({
    id: 'approvals.deliverables.resend_email.create',
    title: 'Resend the approval e-mail',
    description:
      'E-mail the approvers of a version that is still waiting for the client again. Refused ' +
      'while the previous e-mail is still on its way or once the client decided. Confirm-class.',
    input: pathOnly('deliverableId', 'approvalId'),
    redact: 'client_safe',
    notifies: true,
    examples: [{ summary: 'Resend', args: { deliverableId: 'dlv_1', approvalId: 'apr_1' } }],
  }),
  // 52-26: simple e-sign. Requests are created and cancelled only with confirmation; the
  // signature itself is never an AI op.
  det({
    id: 'esign.requests.create',
    title: 'Request a signature',
    description:
      'Ask named client contacts to sign one deliverable version. Each contact is e-mailed. ' +
      'Confirm-class.',
    input: bodyArgs([], {
      deliverableVersionId: f.id(),
      signerUserIds: z.array(f.id()).min(1).max(10),
      expiresInDays: z.number().int().min(1).max(30).optional(),
      title: f.shortText(200).optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      { summary: 'One signer', args: { deliverableVersionId: 'dv_1', signerUserIds: ['user_7'] } },
    ],
  }),
  det({
    id: 'esign.requests.list',
    title: 'List signature requests',
    description: 'The signature requests on one deliverable version, with who signed.',
    input: queryArgs([], { deliverableVersionId: f.id() }),
    redact: 'standard',
    examples: [{ summary: 'By version', args: { deliverableVersionId: 'dv_1' } }],
  }),
  det({
    id: 'esign.requests.get',
    title: 'Get a signature request',
    description: 'One signature request: its signers and each sealed signature record.',
    input: pathOnly('signatureRequestId'),
    redact: 'standard',
    examples: [{ summary: 'By id', args: { signatureRequestId: 'sr_1' } }],
  }),
  det({
    id: 'esign.requests.cancel',
    title: 'Cancel a signature request',
    description: 'Cancel a pending signature request. Signatures already made stay recorded.',
    input: pathOnly('signatureRequestId'),
    redact: 'standard',
    examples: [{ summary: 'Cancel', args: { signatureRequestId: 'sr_1' } }],
  }),
  det({
    id: 'esign.requests.remind',
    title: 'Remind signers',
    description: 'E-mail the signers who have not signed yet. Once a day at most.',
    input: pathOnly('signatureRequestId'),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Remind', args: { signatureRequestId: 'sr_1' } }],
  }),
  det({
    id: 'esign.portal.list',
    title: 'My signature requests',
    description: 'The documents the caller is asked to sign, and whether each is signed.',
    input: noArgs(),
    redact: 'client_safe',
    examples: [{ summary: 'Mine', args: {} }],
  }),
  det({
    id: 'esign.portal.get',
    title: 'Get my signature request',
    description: 'One document the caller is asked to sign, and its state.',
    input: pathOnly('signatureRequestId'),
    redact: 'client_safe',
    examples: [{ summary: 'By id', args: { signatureRequestId: 'sr_1' } }],
  }),
];
