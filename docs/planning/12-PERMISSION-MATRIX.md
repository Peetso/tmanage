# TManage — Detailed Permission and Visibility Matrix

## 1. Roles

Internal: Owner, Org Admin, Workspace Admin, Manager/Project Admin, Moderator, Member, Guest. External: Client Admin, Client Reviewer, Client Member, Client Viewer.

Roles grant capability ceilings. Actual access also requires tenant membership, project/object relation, audience, direct share, policy, and active account.

## 2. Capability matrix

| Capability | Owner | Org Admin | Workspace Admin | Manager | Moderator | Member | Guest | Client Admin | Client Reviewer | Client Member | Client Viewer |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Billing/ownership | Full | Policy | No | No | No | No | No | No | No | No | No |
| Org security/SSO | Full | Full | No | No | No | No | No | No | No | No | No |
| Workspace settings | Full | Full | Full | Limited | No | No | No | No | No | No | No |
| Create project | Yes | Yes | Yes | Policy | No | No | No | No | No | No | No |
| Manage project members | Yes | Yes | Yes | Yes | Policy | No | No | No | No | No | No |
| View internal project | Scope | Scope | Scope | Member | Member | Member | Explicit | Never | Never | Never | Never |
| Moderate messages | Scope | Scope | Scope | Project | Project | Own only | Own only | No | No | Own only | No |
| Create/edit work | Scope | Scope | Scope | Project | Policy | Assigned/member | Explicit | No | No | Client requests/actions | No |
| Publish to client | Policy | Policy | Policy | Yes | Optional | Optional | No | No | No | No | No |
| View client projection | Scope | Scope | Scope | Project | Project | Project | Explicit | Client org | Assigned/shared | Shared | Shared |
| Submit client request | No | No | No | No | No | No | No | Yes | Yes | Yes | Policy |
| Approve governed version | If reviewer | If reviewer | If reviewer | If reviewer | If reviewer | If reviewer | If reviewer | Policy | Assigned | If assigned | No |
| Invite client users | Policy | Policy | Policy | Policy | No | No | No | Within own client org/policy | No | No | No |
| View audit log | Full | Full | Workspace scope | Project sensitive subset | No | Own activity | No | Client-side subset | Own decisions | Own activity | No |
| Export tenant | Owner | Policy | No | No | No | No | No | No | No | No | No |

## 3. Audience rules

- `internal`: never visible to external principals.
- `client_visible`: visible only through a project/client projection to related active client members.
- `client_action_required`: same visibility plus action-queue inclusion for assigned authority.
- Direct share cannot cross tenant or client-organization relation.
- Comments inherit object audience; internal note is a separate object, not a hidden flag inside a client comment.

## 4. Field-level redaction

Client projection excludes internal cost/margin, internal estimate notes, staff review, private channel/thread, internal risk rationale, security metadata, hidden custom fields, and other-client data. Public/client title, summary, milestone state, committed/forecast date, published risk, deliverable version, decision, and approved contacts are explicit allowlisted fields.

## 5. Permission-change safeguards

External publish, bulk visibility change, client invitation, role elevation, ownership transfer, export, API credential, and SSO policy require reauthorization or confirmation according to risk. Permission decisions are re-evaluated on every action; stale token claims do not authorize changed access.

## 6. Test matrix rule

For every endpoint and search/index path, test each role against: same project, different project same tenant, different client same tenant, different tenant, suspended member, expired share, archived object, deleted object, and changed permission after session issuance.
