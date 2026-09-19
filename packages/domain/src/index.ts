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
  isServableVersion,
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

export {
  InadmissibleRichTextError,
  RICH_TEXT_LINK_PROTOCOLS,
  RICH_TEXT_MAX_DEPTH,
  RICH_TEXT_MAX_HREF_LENGTH,
  RICH_TEXT_MAX_NODES,
  RICH_TEXT_MAX_TEXT_LENGTH,
  richTextToPlainText,
  sanitizeRichText,
} from './value-objects/rich-text.js';
export type {
  RichTextBlock,
  RichTextBlockquote,
  RichTextCodeBlock,
  RichTextDocument,
  RichTextHardBreak,
  RichTextInline,
  RichTextLinkMark,
  RichTextList,
  RichTextListItem,
  RichTextMark,
  RichTextParagraph,
  RichTextSimpleMark,
  RichTextSimpleMarkType,
  RichTextText,
} from './value-objects/rich-text.js';

// Audit — 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md §12, 24-EVENT-CATALOG.md §1
export {
  AUDIT_ACTION_CATALOG,
  AUDIT_ACTIONS,
  AUDIT_RESULTS,
  UnsafeAuditMetadataError,
  assertSafeAuditMetadata,
  auditObjectTypeFor,
  isAuditAction,
  isSafeAuditMetadata,
} from './policies/audit.js';
export type {
  AuditAction,
  AuditActionDefinition,
  AuditMetadata,
  AuditMetadataScalar,
  AuditMetadataValue,
  AuditResult,
} from './policies/audit.js';

// Outbox events — 24-EVENT-CATALOG.md, PLAT-004
export {
  OUTBOX_EVENT_CATALOG,
  OUTBOX_EVENT_TYPES,
  isOutboxEventType,
  outboxAggregateTypeFor,
} from './events/outbox.js';
export type {
  ClientRequestSubmittedV1,
  ClientRequestTransitionedV1,
  FileReadyV1,
  FileRejectedV1,
  MessageConvertedV1,
  MessageCreatedV1,
  OutboxEventDefinition,
  OutboxEventPayloads,
  OutboxEventType,
  UploadCompletedV1,
  UsageStorageCommittedV1,
  UsageStorageReleasedV1,
  UsageStorageReservedV1,
  WorkItemBlockedV1,
  WorkItemUpdatedV1,
} from './events/outbox.js';

// Quiet hours — INBOX-001, the honouring half of NOTIF-001
export {
  QUIET_HOURS_BYPASS_EVENT_TYPES,
  eventTypeBypassesQuietHours,
  isInQuietHours,
  isValidTimeZone,
  quietHoursResumeAt,
} from './notifications/quiet-hours.js';
export type { QuietHoursPreferences } from './notifications/quiet-hours.js';
