/**
 * Dependency-injection tokens.
 *
 * Every provider in this application is registered under an explicit token and every injected
 * constructor parameter carries `@Inject(TOKEN)`. That is not a style preference — see
 * ADR-0003. vitest transforms TypeScript with esbuild, which does not implement
 * `emitDecoratorMetadata`, so DI that relied on `design:paramtypes` would resolve `undefined`
 * for every parameter in the one suite that exists to prove the request pipeline works.
 *
 * `Symbol.for` rather than `Symbol`: the database suite and the application can end up holding
 * two instances of this module under vitest's transform pipeline, and two distinct `Symbol()`
 * values would then look like two different providers with the same description — a
 * "Nest can't resolve dependencies" failure with no visible cause. The global registry makes
 * the token identity survive that.
 */

export const TENANT_DATABASE = Symbol.for('tmanage.TenantDatabase');
export const API_CONFIG = Symbol.for('tmanage.ApiConfig');
export const SESSION_SERVICE = Symbol.for('tmanage.SessionService');
export const AUTHENTICATION_SERVICE = Symbol.for('tmanage.AuthenticationService');
export const MEMBERSHIP_RESOLVER = Symbol.for('tmanage.MembershipResolver');
export const PRINCIPAL_REPOSITORY = Symbol.for('tmanage.PrincipalRepository');
export const PROVISIONING_SERVICE = Symbol.for('tmanage.ProvisioningService');
export const WORKSPACES_REPOSITORY = Symbol.for('tmanage.WorkspacesRepository');
export const ORGANIZATION_DIRECTORY_REPOSITORY = Symbol.for(
  'tmanage.OrganizationDirectoryRepository',
);
export const PROJECTS_REPOSITORY = Symbol.for('tmanage.ProjectsRepository');
export const CLIENT_ORGANIZATIONS_REPOSITORY = Symbol.for('tmanage.ClientOrganizationsRepository');
export const CLIENT_MEMBERSHIPS_REPOSITORY = Symbol.for('tmanage.ClientMembershipsRepository');
export const PROJECT_CLIENTS_REPOSITORY = Symbol.for('tmanage.ProjectClientsRepository');
export const CLIENTS_SERVICE = Symbol.for('tmanage.ClientsService');
export const PORTAL_SERVICE = Symbol.for('tmanage.PortalService');
export const INVITATIONS_REPOSITORY = Symbol.for('tmanage.InvitationsRepository');
export const INVITATIONS_SERVICE = Symbol.for('tmanage.InvitationsService');
export const PROJECTS_SERVICE = Symbol.for('tmanage.ProjectsService');
export const AUDIT_EVENTS_REPOSITORY = Symbol.for('tmanage.AuditEventsRepository');
export const AUDIT_SERVICE = Symbol.for('tmanage.AuditService');
export const PROJECT_MEMBERSHIPS_REPOSITORY = Symbol.for('tmanage.ProjectMembershipsRepository');
export const PROJECT_MEMBERSHIPS_SERVICE = Symbol.for('tmanage.ProjectMembershipsService');
export const WORK_ITEMS_REPOSITORY = Symbol.for('tmanage.WorkItemsRepository');
export const WORK_ITEMS_SERVICE = Symbol.for('tmanage.WorkItemsService');
export const CLIENT_REQUESTS_REPOSITORY = Symbol.for('tmanage.ClientRequestsRepository');
export const CLIENT_REQUESTS_SERVICE = Symbol.for('tmanage.ClientRequestsService');
export const CONVERSATIONS_REPOSITORY = Symbol.for('tmanage.ConversationsRepository');
export const CONVERSATIONS_SERVICE = Symbol.for('tmanage.ConversationsService');
export const OUTBOX_EVENTS_REPOSITORY = Symbol.for('tmanage.OutboxEventsRepository');
export const NOTIFICATIONS_REPOSITORY = Symbol.for('tmanage.NotificationsRepository');
export const INBOX_SERVICE = Symbol.for('tmanage.InboxService');
export const PORTAL_INBOX_SERVICE = Symbol.for('tmanage.PortalInboxService');
export const MAILER = Symbol.for('tmanage.Mailer');
export const INVITATION_MAILER = Symbol.for('tmanage.InvitationMailer');
export const OBJECT_STORE = Symbol.for('tmanage.ObjectStore');
/**
 * FILE-001b. The half of the filesystem driver the public PUT route talks to. Provided by
 * `StorageModule.forConfig` alone — a suite holding a fake, or a deployment with no
 * driver, leaves it unbound and the route answers 404 to everything, which is honest.
 */
export const LOCAL_PART_SINK = Symbol.for('tmanage.LocalPartSink');
export const UPLOAD_SESSIONS_REPOSITORY = Symbol.for('tmanage.UploadSessionsRepository');
export const FILE_ASSETS_REPOSITORY = Symbol.for('tmanage.FileAssetsRepository');
export const USAGE_COUNTERS_REPOSITORY = Symbol.for('tmanage.UsageCountersRepository');
export const FILES_SERVICE = Symbol.for('tmanage.FilesService');
/** USAGE-001. The expiry sweeper — resolved by `sweep.ts`, never by a controller. */
export const UPLOAD_SESSION_SWEEPER = Symbol.for('tmanage.UploadSessionSweeper');
/** FILE-002. The verification pass — resolved by `verify.ts`, never by a controller. */
export const FILE_VERIFIER = Symbol.for('tmanage.FileVerifier');
/** FILE-002 slice B. The scan pass — resolved by `verify.ts` after the verifier, on the same tick. */
export const FILE_SCANNER = Symbol.for('tmanage.FileScanner');
/** FILE-002 slice B. The malware scanner port, provided by `ScannerModule`. */
export const MALWARE_SCANNER = Symbol.for('tmanage.MalwareScanner');
