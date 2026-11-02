// State machines — 23-ERD-AND-STATE-MACHINES.md
export { StateMachine } from './state-machines/state-machine.js';
export type {
  StateMachineDefinition,
  TransitionContext,
  TransitionDefinition,
  TransitionResult,
} from './state-machines/state-machine.js';

export {
  workItemStateMachine,
  WORK_ITEM_STATES,
  isWorkItemState,
} from './state-machines/work-item.js';
export type { WorkItemState } from './state-machines/work-item.js';

export {
  clientRequestStateMachine,
  CLIENT_REQUEST_STATES,
  isClientRequestState,
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
  evaluateReviewerDecision,
  reviewerOutcomes,
} from './state-machines/approval.js';
export type {
  AggregateOutcome,
  ApprovalPolicy,
  ApprovalState,
  RecordedReviewerDecision,
  ReviewerDecision,
  ReviewerDecisionRefusal,
  ReviewerDecisionVerdict,
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
  CLIENT_GROUP_CHAT_CAPABILITIES,
  CLIENT_ROLES,
  INTERNAL_ROLES,
  INTERNAL_ONLY_CAPABILITIES,
  PROJECT_CREATOR_ROLE,
  PROJECT_ROLES,
  capabilitiesFor,
  capabilitySetFor,
  customRoleIdOf,
  customRoleKey,
  hasCapability,
  isClientRole,
  isCustomRoleId,
  isCustomRoleKey,
  isInternalOnlyCapability,
  isInternalRole,
  isProjectRole,
  isRole,
  parseCustomRoleCapabilities,
} from './policies/capabilities.js';
export type {
  Capability,
  ClientRole,
  CustomRoleKey,
  InternalRole,
  PrincipalKind,
  PrincipalRole,
  ProjectRole,
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

export { authorize, isAuthorized, mayGrantCapability } from './policies/authorize.js';
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
  auditActionLabel,
  auditObjectTypeFor,
  describeAuditEvent,
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

// C1 automation rule conditions (API + worker)
export {
  conditionsMatch,
  evaluateCondition,
  isAutomationConditionOp,
} from './policies/automation-conditions.js';
export type {
  AutomationConditionOp,
  ConditionEvent,
  ConditionPredicate,
} from './policies/automation-conditions.js';

// BK3 direct-message relation rule (API + worker)
export { mayDirectMessage } from './policies/direct-message-relation.js';
export type { DirectParty } from './policies/direct-message-relation.js';

// Outbox events — 24-EVENT-CATALOG.md, PLAT-004
export {
  OUTBOX_EVENT_CATALOG,
  OUTBOX_EVENT_TYPES,
  MAX_MENTIONS_PER_TEXT,
  extractMentionedUserIds,
  isOutboxEventType,
  outboxAggregateTypeFor,
} from './events/outbox.js';
export type {
  DirectMessageCreatedV1,
  ClientRequestSubmittedV1,
  ClientRequestTransitionedV1,
  ClientRequestMessagePostedV1,
  DocumentCommentCreatedV1,
  DocumentPublishedV1,
  DocumentRenamedV1,
  FilePurgedV1,
  FileReadyV1,
  FileRejectedV1,
  MeetingAttendeeInvitedV1,
  MeetingChangedV1,
  MeetingScheduledV1,
  MessageConvertedV1,
  MessageCreatedV1,
  OutboxEventDefinition,
  OutboxEventPayloads,
  OutboxEventType,
  ProjectMemberAddedV1,
  ReviewCommentAddedV1,
  ReviewThreadCreatedV1,
  ReviewThreadResolvedV1,
  UploadCompletedV1,
  UsageStorageCommittedV1,
  UsageStorageReleasedV1,
  UsageStorageReservedV1,
  UsageThresholdReachedV1,
  WorkItemBlockedV1,
  WorkItemClientActionRequestedV1,
  WorkItemCreatedV1,
  WorkItemUpdatedV1,
} from './events/outbox.js';

// Quiet hours — INBOX-001, the honouring half of NOTIF-001
export {
  QUIET_HOURS_BYPASS_EVENT_TYPES,
  QUIET_HOURS_BYPASS_PAYLOAD_PREDICATES,
  eventBypassesQuietHours,
  eventTypeBypassesQuietHours,
  isInQuietHours,
  isValidTimeZone,
  quietHoursResumeAt,
} from './notifications/quiet-hours.js';
export type {
  QuietHoursBypassPredicate,
  QuietHoursPreferences,
} from './notifications/quiet-hours.js';

// Public legal documents — x188, rendered server-side by the web and served by the API
export { LEGAL_DOCUMENTS } from './legal/legal-content.js';
export type { LegalDocument, LegalDocumentKey } from './legal/legal-content.js';

// ---- platform-admin v2 · PA-01 ----
// SPEC §3.3: the permission matrix layout, per-member overrides and "what can this person do".
export {
  ASSIGNABLE_INTERNAL_ROLES,
  MATRIX_NEW_CAPABILITIES,
  PLATFORM_SUPPORT_ROLE,
  isPlatformSupportRole,
} from './policies/capabilities.js';
export { effectiveCapabilitySet, principalHoldsCapability } from './policies/authorize.js';
export type { PermissionOverrides } from './policies/authorize.js';
export {
  MATRIX,
  MATRIX_ACTIONS,
  MATRIX_AREAS,
  MATRIX_MERGED_CELLS,
  MATRIX_MIRRORED_CELLS,
  actionCapabilities,
  areaCapabilities,
  capabilitiesWithoutCell,
  capabilityCell,
  cellsOfCapability,
} from './policies/permission-matrix-layout.js';
export type {
  MatrixAction,
  MatrixArea,
  MatrixCell,
  MatrixRow,
} from './policies/permission-matrix-layout.js';
export { computeEffectivePermissions } from './policies/effective-permissions.js';
export type {
  ComputeEffectivePermissionsInput,
  EffectivePermissionEntry,
  EffectivePermissionScope,
  EffectivePermissionSource,
  EffectivePermissionsView,
  SimulatedProject,
} from './policies/effective-permissions.js';

// ---- platform-admin v2 · PA-02 ----
// Platform permissions — who may do what in the Platform admin (SPEC §3.1)
export {
  EDITABLE_PLATFORM_PRESETS,
  PLATFORM_PERMISSION_AREAS,
  PLATFORM_PERMISSIONS,
  PLATFORM_PRESET_NAMES,
  PLATFORM_PRESETS,
  SUPER_ADMIN_ONLY_PERMISSIONS,
  isPlatformPermission,
  isPlatformPreset,
  normalizePlatformPermissions,
  platformPermissionsFor,
} from './policies/platform-permissions.js';
export type {
  EditablePlatformPreset,
  PlatformNamedPreset,
  PlatformPermission,
  PlatformPreset,
} from './policies/platform-permissions.js';
// ---- platform-admin v2 · PA-03 ----
export {
  LEGAL_COPY_AR,
  LEGAL_DOCUMENTS_AR,
  LEGAL_DOCUMENTS_BY_LOCALE,
  LEGAL_EFFECTIVE_DATE,
  LEGAL_ENGLISH_PREVAILS_AR,
  LEGAL_LOCALES,
  OPERATOR_ACCESS_CLAUSE,
  OPERATOR_ACCESS_SECTION_ID,
  legalDocumentFor,
  legalLocaleOf,
} from './legal/legal-content.js';
export type { ArabicLegalCopy, LegalLocale } from './legal/legal-content.js';

// Money — 52-FEATURE-GAPS-AGENCY-CORE.md §4 (52-23)
export {
  CURRENCY_DIGITS,
  MoneyError,
  addMoney,
  computeLineTax,
  currencyDigits,
  divideHalfUp,
  formatMoney,
  isCurrencyCode,
  lineNetFromQuantity,
  money,
  parseMoney,
  sumLines,
} from './money/money.js';
export type { DocumentTotals, LineAmounts, Money, MoneyDigits } from './money/money.js';

// Interface language suggestion — R12 (R2, SPEC D6)
export {
  DEFAULT_SUGGESTED_LOCALE,
  localeForAcceptLanguage,
  localeForCountry,
} from './i18n/country-locale.js';
export type { SuggestedLocale } from './i18n/country-locale.js';

// One CSV cell-escaping rule for every export — 52-29 (R13-s1)
export { CSV_BOM, CSV_RECORD_SEPARATOR, escapeCsvCell, toCsv } from './export/csv.js';
export type { CsvValue, ToCsvOptions } from './export/csv.js';
