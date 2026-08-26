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
