// State machines — 23-ERD-AND-STATE-MACHINES.md
export { StateMachine } from './state-machines/state-machine.js';
export type {
  StateMachineDefinition,
  TransitionContext,
  TransitionDefinition,
  TransitionResult,
} from './state-machines/state-machine.js';

export { workItemStateMachine, WORK_ITEM_STATES } from './state-machines/work-item.js';
export type { WorkItemState } from './state-machines/work-item.js';

export {
  clientRequestStateMachine,
  CLIENT_REQUEST_STATES,
  CLIENT_ALLOWED_CLIENT_REQUEST_TRANSITIONS,
  MANAGER_ONLY_CLIENT_REQUEST_TRANSITIONS,
} from './state-machines/client-request.js';
export type { ClientRequestState } from './state-machines/client-request.js';

export {
  deliverableStateMachine,
  DELIVERABLE_STATES,
  CLIENT_EXPOSED_DELIVERABLE_STATES,
} from './state-machines/deliverable.js';
export type { DeliverableState } from './state-machines/deliverable.js';

export {
  approvalStateMachine,
  APPROVAL_STATES,
  PENDING_APPROVAL_STATES,
  aggregateApprovalOutcome,
  activeReviewers,
} from './state-machines/approval.js';
export type {
  AggregateOutcome,
  ApprovalPolicy,
  ApprovalState,
  ReviewerDecision,
  ReviewerOutcome,
} from './state-machines/approval.js';

export {
  uploadStateMachine,
  UPLOAD_STATES,
  SERVABLE_UPLOAD_STATES,
  isServable,
} from './state-machines/upload.js';
export type { UploadState } from './state-machines/upload.js';

export { invitationStateMachine, INVITATION_STATES } from './state-machines/invitation.js';
export type { InvitationState } from './state-machines/invitation.js';

export {
  offboardingStateMachine,
  OFFBOARDING_STATES,
  OFFBOARDING_NEVER_AUTO_RESTORES_ACCESS,
} from './state-machines/offboarding.js';
export type { OffboardingState } from './state-machines/offboarding.js';

// Policies — 12-PERMISSION-MATRIX.md, 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md
export {
  CAPABILITIES,
  CLIENT_ROLES,
  INTERNAL_ROLES,
  INTERNAL_ONLY_CAPABILITIES,
  capabilitiesFor,
  hasCapability,
  isClientRole,
  isInternalOnlyCapability,
  isInternalRole,
  isRole,
} from './policies/capabilities.js';
export type {
  Capability,
  ClientRole,
  InternalRole,
  PrincipalKind,
  Role,
} from './policies/capabilities.js';

export {
  AUDIENCES,
  DEFAULT_AUDIENCE,
  FORBIDDEN_CLIENT_FIELDS,
  findForbiddenClientFields,
  inheritedCommentAudience,
  isClientReadableAudience,
  isVisibilityWidening,
} from './policies/audience.js';
export type { Audience } from './policies/audience.js';

export { authorize, isAuthorized } from './policies/authorize.js';
export type {
  AuthorizationDecision,
  AuthorizationRequest,
  DenialCode,
  OrganizationPolicy,
  Principal,
  ResourceContext,
} from './policies/authorize.js';

// Value objects
export { isUuid, isUuidV7, timestampFromUuidV7, uuidv7 } from './value-objects/uuid-v7.js';
export {
  abbreviateContentHash,
  assertContentHash,
  contentHashEquals,
  isContentHash,
} from './value-objects/content-hash.js';
export type { ContentHash } from './value-objects/content-hash.js';
