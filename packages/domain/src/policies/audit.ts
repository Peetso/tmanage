/**
 * The audit vocabulary and the safe-metadata rule — AUD-001.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC` §12 is one paragraph and it does two separate
 * things. It lists the decisions that *must* leave an audit record, and it constrains what
 * such a record may contain:
 *
 *   "Role changes, invitations, external publish, approval decision/invalidation, restricted
 *    export download, client membership change, policy change, offboarding, export,
 *    API/webhook credentials, admin impersonation, cross-tenant support action, and any
 *    emergency database procedure require audit. Denied sensitive attempts are security
 *    events with safe metadata."
 *
 * This file is where both halves become code rather than intention.
 *
 * ## Why the action vocabulary is closed
 *
 * `audit_events.action` is a `VARCHAR(190)`, so the database would accept anything. A closed
 * union is the difference between an audit trail and a log: a query for "every role change in
 * this organization last quarter" is only answerable if every writer spelled the action the
 * same way, and the only reliable way to make writers agree is to make disagreement a
 * compile error. Adding an action is a deliberate edit here, in the file that also records
 * which §12 clause requires it.
 *
 * {@link AUDIT_ACTION_CATALOG} pairs each action with the object type it describes and the
 * clause that demands it. The object type is part of the definition rather than a free
 * parameter because `ix_audit_events_org_object` is `(organization_id, object_type,
 * object_id)` — an object type that varies by call site makes that index useless for the one
 * question it exists to answer, "what happened to this row".
 *
 * ## Why the metadata rule is a refusal rather than a convention
 *
 * §12's "safe metadata" and `24-EVENT-CATALOG` §1's "Secrets, full message bodies, raw file
 * content, and unnecessary personal data are forbidden" are the same requirement stated
 * twice. Both are easy to satisfy on the day the writer is reviewed and easy to lose six
 * months later, when someone adds `reason` to a metadata object and a user's sentence ends up
 * in an append-only table that no credential in this system is permitted to amend.
 *
 * So {@link assertSafeAuditMetadata} refuses. It admits identifiers and classifications —
 * UUIDs, slugs, enum members, counts, flags — and nothing that looks like prose. The
 * denylist of key names is the second line, not the first: the value shape is what actually
 * stops a message body, because a message body cannot be spelled with the permitted
 * character set at the permitted length whatever the key is called.
 *
 * This is deliberately *not* `findForbiddenClientFields` from `audience.ts`. That function
 * answers a different question — "may a client see this payload" — against camelCase domain
 * fields, and it is a search that reports rather than a gate that refuses. Reusing it here
 * would couple two rules that are allowed to change independently.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors the `result` enum in `0002_platform_primitives.sql`.
 *
 * `denied` is the case §12's last sentence is about, and it is a *result* rather than a
 * separate action on purpose: the interesting security question is "who tried to do this and
 * was refused", which is only answerable if the attempt and the success share an action name.
 */
export const AUDIT_RESULTS = ['allowed', 'denied', 'error'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditActionDefinition {
  /** The row kind this action describes. Fixed per action — see the note at the top. */
  readonly objectType: string;
  /** The §12 clause that requires it, quoted closely enough to be found by search. */
  readonly clause: string;
}

/**
 * A note on a field that is deliberately **not** here.
 *
 * A first draft gave each action a `deniedAttemptIsSecurityEvent` flag, meaning "a refused
 * attempt at this is itself worth an audit row". It was removed before it shipped, because
 * its polarity could not be made coherent for `security.capability_denied` — an action whose
 * only legal result *is* `denied`, and for which "was the denial denied" is not a question.
 * Nothing in the application consumed it either; the decision about which refusals to record
 * currently lives in `CapabilityGuard`, which is where the facts to make it are.
 *
 * When a second producer needs that decision, it should arrive as a rule with one meaning
 * rather than as a boolean that means something different for one member of the set.
 */

/**
 * Every action this system may write today, and why.
 *
 * The list is shorter than §12's, and the gap is honest rather than accidental: an action is
 * added when the code that writes it exists. Approvals, publication, exports and webhook
 * credentials have no implementation yet, so naming them here would create a vocabulary whose
 * members no query could ever return, and a reader could not tell "never happened" from
 * "never built".
 */
export const AUDIT_ACTION_CATALOG = {
  /**
   * TEN-001's provisioning transaction.
   *
   * The first row an organization ever has, and the only audit row whose `organization_id`
   * names a row created in the same transaction. §12 lists "organization settings" among the
   * changes that must be recorded, and there is no settings change more consequential than
   * the one that decides who owns the organization in the first place.
   */
  'organization.provisioned': {
    objectType: 'organization',
    clause: '§12 organization settings — the founding grant is the first and largest of them',
  },
  /**
   * PROJ-001. A project is the container every later object lives in — work items,
   * deliverables, approvals, the client's whole view — so "who created this project, and
   * when" is the first question any later investigation of its contents has to answer.
   */
  'project.created': {
    objectType: 'project',
    clause: '§12 organization settings — a project is the unit every later object belongs to',
  },
  /**
   * WORK-001. Three actions, and the shape of the set is the argument.
   *
   * Creation, state transitions and deletion are recorded; **field edits are not**. §12 lists
   * the changes that are security events — roles, permissions, exports, publication,
   * credentials — and retitling a task is none of them. Auditing every edit would bury the
   * rows that matter under rows that do not, and the row already carries `updated_at` and a
   * version.
   *
   * An audience change **is** recorded, and separately, because widening a work item to
   * `client_visible` is a publication decision rather than a field edit.
   */
  'work_item.created': {
    objectType: 'work_item',
    clause: '§12 — the first record of a unit of work a client may later be shown',
  },
  'work_item.transitioned': {
    objectType: 'work_item',
    clause:
      '§12 — a state change is what the work means; "who marked this done, and when" is ' +
      'the question asked when a deliverable turns out to be wrong. The move itself is ' +
      'permitted by §5 of 23-ERD, but the accounting for it is §12’s',
  },
  'work_item.audience_changed': {
    objectType: 'work_item',
    clause: '§12 publication — widening an item to client_visible is a disclosure decision',
  },
  'work_item.deleted': {
    objectType: 'work_item',
    clause:
      '§12 — a soft delete removes the item from every list without being part of the ' +
      'lifecycle anyone can see, so it is the removal that most needs accounting for',
  },
  /**
   * WORK-003. Adding an edge is not here — the row itself records who and when, the same
   * judgement as work-item field edits. Removing one IS here, for
   * `project_membership.revoked`'s reason: the DELETE destroys the only record of the
   * edge, and an edge quietly removed is a health claim quietly changed.
   */
  'work_item.dependency_removed': {
    objectType: 'work_item',
    clause:
      '§12 — the hard delete erases the edge, so the removal row is the only remaining ' +
      'evidence a health signal once had a reason',
  },
  /**
   * A comment written through a connected AI app (the hosted connector). Ordinary comments are
   * not audited — the row records who and when — but one an AI app wrote on a member's behalf is
   * accountable to that member and the app, so the activity feed can say "from Claude via the
   * connector". Metadata: the comment's id (`entry_id`) and the stamped channel and app only.
   */
  'work_item.commented': {
    objectType: 'work_item',
    clause: '§12 — an action taken for a member by an AI app is attributed to both',
  },
  /**
   * CLIENT-001. The access-granting half of the system, and every one of these is §12's
   * "role changes" or a disclosure decision rather than a field edit.
   *
   * A client organization's *name* changing is recorded because the row is the boundary
   * object — it is what memberships and shares hang off, and "which company was this" is the
   * first question asked when a grant is investigated. That is a narrower rule than auditing
   * every edit, and it is the same rule work items follow: record what decides access.
   */
  'client_organization.created': {
    objectType: 'client_organization',
    clause: '§12 organization settings — a client organization is the boundary access hangs off',
  },
  'client_organization.updated': {
    objectType: 'client_organization',
    clause: '§12 — the name is what a grant is investigated by, so a rename is part of the trail',
  },
  'client_organization.archived': {
    objectType: 'client_organization',
    clause:
      '§12 — archiving ends a relationship without ending access, so the record has to say ' +
      'when the relationship ended and leave the separate question of the grants visible',
  },
  'client_membership.invited': {
    objectType: 'client_membership',
    clause: '§12 role changes — this is the row that lets somebody outside the company in',
  },
  'client_membership.role_changed': {
    objectType: 'client_membership',
    clause: '§12 role changes — a client reviewer can approve work; a client viewer cannot',
  },
  'client_membership.expiry_changed': {
    objectType: 'client_membership',
    clause:
      '§12 role changes — removing an expiry converts a bounded grant into an open-ended ' +
      'one, which is a larger change than most role changes and is invisible in the role',
  },
  'client_membership.status_changed': {
    objectType: 'client_membership',
    clause: '§12 role changes — activation, suspension and offboarding are all access decisions',
  },
  /**
   * Wave 10 R5 (F27b). A person holds an active internal membership and a live client membership in
   * the same company; the resolver acts as the staff member and ignores the client row named here.
   * Metadata: the client organization and the internal membership id — ids only.
   */
  'client_membership.shadowed_by_internal': {
    objectType: 'client_membership',
    clause: '§12 client membership change — a client grant that no longer applies to staff',
  },
  /**
   * ADM-12/13 (x121). Offboarding an *internal* member — the mirror of
   * `client_membership.status_changed`'s offboarding case for the staff side.
   *
   * It is its own action rather than a shared `membership.status_changed` because offboarding
   * is the only internal membership transition that revokes access irreversibly:
   * `OFFBOARDING_NEVER_AUTO_RESTORES_ACCESS`, and `offboarded` is terminal in the storage
   * layer's `ALLOWED_TRANSITIONS`. "Who revoked this person, and when" is the question a
   * disputed access removal is settled by, and the row is written only when a real transition
   * occurs — re-offboarding a member already terminal writes nothing, so the count of these
   * rows is the count of actual revocations.
   */
  'membership.offboarded': {
    objectType: 'membership',
    clause:
      '§12 role changes — offboarding revokes an internal member’s access irreversibly, the ' +
      'largest access decision the staff side has',
  },
  /**
   * ADM-11 (CQ-06). Custom roles and who holds them. A custom role is a named set of
   * capabilities, so defining one, changing its set and handing it to people are each a
   * permission change §12 names — and the Control Center's audit header says everything is
   * logged. A clone is a `custom_role.created` whose metadata names the source role.
   */
  'custom_role.created': {
    objectType: 'custom_role',
    clause: '§12 role and permission changes — a new set of capabilities anyone can be given',
  },
  'custom_role.updated': {
    objectType: 'custom_role',
    clause: '§12 role and permission changes — every holder of the role gains or loses with it',
  },
  'membership.role_changed': {
    objectType: 'membership',
    clause: '§12 role changes — the role a staff member holds decides what they can reach',
  },
  'project.client_linked': {
    objectType: 'project_client',
    clause:
      '§12 publication — this row is the whole of why a client principal can reach a ' +
      'project, so linking one is the broadest disclosure decision in the system',
  },
  'project.client_unlinked': {
    objectType: 'project_client',
    clause: '§12 publication — withdrawing access, and the moment it stopped',
  },
  /**
   * TEN-003. An invitation is how somebody outside an organization gets into it, so every
   * step of its life is §12's "role changes" — the row is the grant itself before there is a
   * membership to point at.
   *
   * The **address is never in the metadata.** It is personal data about somebody who may not
   * even have an account yet, and §12's metadata rule is identifiers and classifications; the
   * row's own `email` column holds it under the tenant's own access controls.
   */
  'invitation.issued': {
    objectType: 'invitation',
    clause: '§12 role changes — issuing a token that grants membership is the grant itself',
  },
  'invitation.emailed': {
    objectType: 'invitation',
    clause:
      '§12 role changes — the delivery attempt for a token that grants membership: result ' +
      'says whether a mail server accepted it, metadata says which kind, never the address',
  },
  'invitation.accepted': {
    objectType: 'invitation',
    clause:
      '§12 role changes — the moment somebody outside the organization became somebody ' +
      'inside it, and the only record of which token did it',
  },
  'invitation.revoked': {
    objectType: 'invitation',
    clause: '§12 role changes — withdrawing a live token, and whether it was withdrawn or replaced',
  },
  'invitation.expired': {
    objectType: 'organization',
    clause:
      '§12 — a sweep rather than a decision, recorded because the count is the only evidence ' +
      'the bookkeeping ran at all',
  },
  'project_membership.granted': {
    objectType: 'project_membership',
    clause: '§12 role changes — a project grant is the narrowest role change in the system',
  },
  'project_membership.role_changed': {
    objectType: 'project_membership',
    clause: '§12 role changes',
  },
  /**
   * The one that closes a gap recorded in code rather than in a document.
   * `ProjectMembershipsRepository.remove()` is a real `DELETE` — the only one in this
   * codebase — and the note above it says that trade "only holds if the revocation is
   * recorded somewhere else, and today it is not". This is somewhere else.
   */
  'project_membership.revoked': {
    objectType: 'project_membership',
    clause: '§12 role changes — the grant is erased, so the revocation is the only record',
  },
  /**
   * REQ-001. Two actions, and the asymmetry between them is the argument.
   *
   * A submission is recorded because it is the moment somebody outside the company put an
   * obligation on it, and because `12-PERMISSION-MATRIX` §2 makes "Submit client request" the
   * one thing every client role can do — so it is also the only client-initiated write in the
   * system, and the only place a client's own capability is exercised rather than read.
   *
   * A transition is recorded because it is the *answer*, and `23-ERD` §6 makes three of them
   * decisions only an internal manager may take: accepted, deferred, declined. "Who declined
   * this, when, and had the client been asked to clarify first" is the question a disputed
   * scope is settled by, and it is unanswerable from the row alone once a later transition
   * overwrites the reason.
   *
   * Neither carries prose. The title, the description, the urgency reason, the clarification
   * question and the client-safe reason are all sentences written by a person, and §12's
   * metadata rule is identifiers and classifications. The row holds them under the tenant's
   * own access controls; the audit trail holds which decision was taken and against what.
   */
  'client_request.submitted': {
    objectType: 'client_request',
    clause:
      '§12 — the only write a client principal can make, and the moment an obligation on ' +
      'the organization begins',
  },
  'client_request.transitioned': {
    objectType: 'client_request',
    clause:
      '§12 — accepting, deferring and declining are decisions only an internal manager may ' +
      'take (23-ERD §6), and the accounting for them is what a disputed scope is settled by',
  },
  /**
   * CHAT-001. Three actions, and — as with `work_item.*` — the shape of the set is the
   * argument.
   *
   * **A message being posted is not here, and that is deliberate.** §12 lists the changes that
   * are security events, and somebody speaking in a channel they belong to is not one of them.
   * A row per message would be an audit table growing faster than the table it audits, and it
   * would bury the rows that matter. `24-EVENT-CATALOG` does name `message.created.v1` — as a
   * **durable event** for realtime, mentions and search, which is a different mechanism with a
   * different purpose, and one nothing publishes yet because `PLAT-004`'s relay is unwritten.
   *
   * **A message being taken down is here.** Moderation is somebody exercising authority over
   * what another person said, which is exactly §12's subject. The row records who and when;
   * `messages.deleted_at` survives, so the record cannot be completed by deleting it.
   *
   * **Conversation membership is here** for the reason `project_membership.*` is: it decides
   * who can read the content, so it is an access grant rather than a preference.
   */
  'conversation.created': {
    objectType: 'conversation',
    clause: '§12 organization settings — a channel is a room, and creating one decides it exists',
  },
  'conversation.member_added': {
    objectType: 'conversation',
    clause: '§12 permission change — conversation membership is who may read the content',
  },
  'conversation.member_removed': {
    objectType: 'conversation',
    clause:
      '§12 permission change — the DELETE destroys the grant, so the row that records it is ' +
      'the only remaining evidence the person was ever in the room',
  },
  'message.deleted': {
    objectType: 'message',
    clause:
      '§12 — moderation is authority exercised over what somebody else said, and "who took ' +
      'this down, and when" is the question a disputed removal turns on',
  },
  /**
   * FILE-001. Two actions, and the shape of the set is again the argument.
   *
   * **Creating an upload session is not here.** §12 does not list an ordinary upload, and
   * a row per session would be `message.created`'s problem over again. **A refusal on quota
   * is here**, because `49-PRICING` §7 makes the 100% block an event the owner is told
   * about, and "when did we start refusing uploads" is what a billing dispute turns on.
   * **A completed upload is here** because `24-EVENT-CATALOG` §4 grades
   * `upload.completed.v1` as a security log: an object now exists under the tenant's
   * prefix, uploaded by a named person, and the scan that decides whether it is safe has
   * not run yet.
   */
  'upload_session.refused': {
    objectType: 'upload_session',
    // Recorded as `denied` with no object id: the session that was refused never became a row.
    clause:
      '§12 denied sensitive attempts; 49-PRICING §7 — the 100% block is a recorded refusal; ' +
      '26-THREAT-MODELS §5 quota abuse — so is the open-upload cap',
  },
  'upload_session.abort_failed': {
    objectType: 'upload_session',
    // `error`. Two producers: a reservation that was refused and never became a row (no
    // object id), and a release whose best-effort abort the provider refused (the session
    // is the object id). Either way the provider still holds an upload; the handle is the
    // metadata.
    clause:
      '§12 — an upload the provider holds open that no row names is a fact only the log ' +
      'can carry; 49-PRICING §6 step 7 abort; 50-BOOTSTRAP §4 lifecycle-abort is the backstop',
  },
  'file_asset.uploaded': {
    objectType: 'file_asset',
    // A stored file is content a client may later be shown; the row is the disclosure's start.
    clause:
      '§12 publication — a file that reaches the store is the first record of a disclosure; ' +
      '24-EVENT-CATALOG §4 grades upload.completed.v1 a security log',
  },
  /**
   * FILE-002, slice A — the verification pass, one row per asset it judges, `actorUserId:
   * null` (a job under a service context). The metadata is tokens: the digest as bare hex
   * (`sha256`, exactly the 64-character cap), the detected type as a family token
   * (`detected_type: pdf | png | … | text_plain`, never a MIME type — `VALUE_PATTERN`
   * admits no `/`), the rejection under `rejection_code`; never the declared name, never
   * a scanner's or a sniffer's free text.
   */
  'file_asset.verified': {
    objectType: 'file_asset',
    clause:
      '§12 — the checksum and the detected type are the facts a later disclosure rests on; ' +
      '03-ARCHITECTURE §108 checksum/MIME/size verification; 27-TEST-CATALOG INT-12',
  },
  'file_asset.rejected': {
    objectType: 'file_asset',
    // `denied`: a file the pass refused is exactly a "denied sensitive attempt" — the
    // attempt was the upload, the refusal is here, and the bytes stay in quarantine as
    // evidence (49-PRICING §5: still counted until FILE-003's deletion).
    clause:
      '§12 denied sensitive attempts are security events with safe metadata; ' +
      '24-EVENT-CATALOG §4 file.rejected.v1 is audited; 27-TEST-CATALOG SEC-06',
  },
  'file_asset.scan_failed': {
    objectType: 'file_asset',
    // `error`: the pass could not judge — the object is missing, the store is down, the
    // size on disk is not the row's; since slice B, the scanner could not answer, or no
    // scanner is configured (`cause: no_scanner`, recorded once per version under
    // `MALWARE_SCAN_DRIVER=none`). Nothing moves; the row stays where it was for a re-run,
    // and this is the only trace of why.
    clause:
      "§12 — a system job that could not verify a tenant's file with no actor is what the " +
      'log exists to explain; 03-ARCHITECTURE §108 unscanned uploads are quarantined',
  },
  /**
   * FILE-002, slice B — the scan pass. One `scanned` row per version a scanner cleared:
   * `actorUserId: null`, `scanner` as a token (`stub`, `clamav`), `verdict: clean`, and
   * the zone the object now lives in. An infected verdict is not a second action: it is
   * `file_asset.rejected` (`denied`) with `rejection_code: malware_detected` — the
   * scanner's signature name is never in the log (a token, never its free text; the
   * stderr line of the pass names it for an operator). `scan_disputed` is the loud case:
   * a scan of a version with a standing verdict reached a different one — a signature
   * update, or two passes overlapping — and the standing verdict is the one that holds.
   */
  'file_asset.scanned': {
    objectType: 'file_asset',
    clause:
      '§12 — the scan verdict and the promotion are the facts a later disclosure rests on; ' +
      '03-ARCHITECTURE §108 malware scan; 24-EVENT-CATALOG §4 file.ready.v1 security metadata',
  },
  /**
   * FILE-002 slice C. One row per download attempt: `allowed` before the first byte leaves,
   * `denied` for every refusal with the cause on `audit_code` alone. The metadata names the
   * project, the purpose, the version, the size, the principal's kind and the delivery —
   * never the filename, the type, the key or the address.
   */
  'file_asset.downloaded': {
    objectType: 'file_asset',
    clause:
      '§12 — a download of file content is a disclosure; 25-AUTHORIZATION §115 restricted ' +
      'export/download is audited; 27-TEST-CATALOG SEC-10 mass-download evidence',
  },
  'file_asset.scan_disputed': {
    objectType: 'file_asset',
    clause:
      '§12 — a verdict that a second scan would have changed is a security signal with safe ' +
      'metadata; 27-TEST-CATALOG SEC-06; 26-THREAT-MODELS §79 immutable verdicts',
  },
  /**
   * FILE-003. The retention-lifecycle job's one row per rejected/quarantined object whose
   * provider bytes it deleted, `actorUserId: null` (a job under a service context, as an
   * expiry's and a drift correction's are). It is the only trace that a tenant's counted
   * bytes were physically removed and its quota counter decremented — `49-PRICING` §6 step 8:
   * "A physical version deletion reduces usage only after provider deletion is confirmed". The
   * metadata is ids, the size, the counter answer and a fixed `reason` token
   * (`retention_expired`); never the `rejection_code` or any detection name — the rejection is
   * already recorded on `file_asset.rejected`, and re-stating why the file was quarantined here
   * would put the detection's name on a second row this job writes with no actor.
   */
  'file_asset.purged': {
    objectType: 'file_asset',
    clause:
      "§12 — a system-initiated deletion of a tenant's stored bytes with no actor is exactly " +
      'what the log exists to explain; 49-PRICING §6 step 8 (delete then reduce usage), §5 ' +
      '(rejected bytes counted until FILE-003); 26-THREAT-MODELS §5 quarantine lifecycle',
  },
  /**
   * USAGE-001. The sweeper's one row per session it expires. Nobody acted — the actor is
   * null, the documented system case — and it is the only trace that a leaver's abandoned
   * reservation was cleaned rather than left counted against the tenant forever
   * (implementation-status, FILE-001b decision 7). `24-EVENT-CATALOG` §4 grades
   * `usage.storage_released.v1` audit "conditional"; expiry is the condition, because a
   * cancel is a person's act on the API and an expiry is nobody's.
   */
  'upload_session.expired': {
    objectType: 'upload_session',
    clause:
      "§12 — a system-initiated change to a tenant's quota with no actor is exactly what the " +
      'log exists to explain; 49-PRICING §6 step 7 expiry, 24-EVENT-CATALOG §4 audit conditional',
  },
  /**
   * USAGE-001 slice 3. The reconciler's one row when it corrects a `usage_counters` value to
   * its append-only ledger sums. Nobody acted — the actor is null, the documented system case,
   * as with an expiry — and this is the only trace that a tenant's quota counter was silently
   * repaired towards the ledger (`49-PRICING` §6 reconciled counters). The metadata carries the
   * before/after and the per-counter drift, safe scalars only.
   */
  'usage_counter.drift_corrected': {
    objectType: 'usage_counter',
    clause:
      "§12 — a system-initiated correction to a tenant's quota counter with no actor is exactly " +
      'what the log exists to explain; 49-PRICING §6 reconciled counters, 27-TEST-CATALOG CONC-06',
  },
  /**
   * USAGE-001 slice 4. The one row written when an organization's storage usage first crosses
   * 100% of quota — the band the reservation guard already refuses at. Nobody acted: the actor
   * is null, the documented system case, as with an expiry or a drift correction, because the
   * crossing is a consequence of the reserve/commit/reconcile that produced it, not a request
   * of its own. `24-EVENT-CATALOG` §4 grades `usage.threshold_reached.v1` audit "yes at 100%";
   * this is the "yes". Metadata carries the band and the counter numbers, safe scalars only.
   */
  'usage.threshold_reached': {
    objectType: 'usage_counter',
    clause:
      "§12 — a system-observed change to a tenant's quota standing with no actor is exactly " +
      'what the log exists to explain; 49-PRICING §6 (100% blocks new reservations), ' +
      '24-EVENT-CATALOG §4 audit "yes at 100%"',
  },
  /**
   * 0210. Google Drive as company storage. Connecting, changing and disconnecting where a
   * company's files live is an organization-settings change; the metadata is ids, the provider,
   * the storage mode and whether a Shared Drive is used — never the account's token.
   */
  'storage_connection.connected': {
    objectType: 'storage_connection',
    clause: '§12 organization settings — connecting an external store for company files',
  },
  'storage_connection.settings_changed': {
    objectType: 'storage_connection',
    clause: '§12 organization settings — changing where new company files are stored',
  },
  'storage_connection.disconnected': {
    objectType: 'storage_connection',
    clause: '§12 organization settings — removing the external store and wiping its token',
  },
  /** 0210. A Drive file attached to, or detached from, a work item (ids and type only). */
  'drive_attachment.attached': {
    objectType: 'google_drive_attachment',
    clause: '§12 — a file linked into a tenant record from an external store',
  },
  'drive_attachment.removed': {
    objectType: 'google_drive_attachment',
    clause: '§12 — the same link removed (the Drive file itself is never deleted)',
  },
  /**
   * 0236. A OneDrive file attached to, or detached from, a work item (ids and type only). The
   * connection itself reuses `storage_connection.*` with `provider: 'onedrive'`.
   */
  'onedrive_attachment.attached': {
    objectType: 'onedrive_attachment',
    clause: '§12 — a file linked into a tenant record from an external store',
  },
  'onedrive_attachment.removed': {
    objectType: 'onedrive_attachment',
    clause: '§12 — the same link removed (the OneDrive file itself is never deleted)',
  },
  /**
   * 0237. A person connects or disconnects their OWN Google or Microsoft calendar (provider in the
   * metadata, never the account's token or address), and a meeting is cancelled or re-sent to it.
   */
  'calendar_connection.connected': {
    objectType: 'calendar_connection',
    clause: '§12 — a personal external calendar linked to TManage meetings',
  },
  'calendar_connection.disconnected': {
    objectType: 'calendar_connection',
    clause: '§12 — the same link removed and its token wiped',
  },
  'meeting.cancelled': {
    objectType: 'meeting',
    clause: '§12 — a meeting cancelled; its calendar event is deleted and guests are told',
  },
  'meeting.synced': {
    objectType: 'meeting',
    clause: '§12 — a meeting re-sent to, and re-read from, the organizer calendar',
  },
  /**
   * NV10 (wave 10 R9). A short-lived company Drive token handed to a person's browser for the file
   * picker. Google has no per-project Drive token, so each issuance is recorded: the connection,
   * the provider and the target project id — never the token.
   */
  'drive_picker.session_issued': {
    objectType: 'storage_connection',
    clause: '§12 API credentials — a company Drive access token issued to a browser',
  },
  /**
   * B3. The company owner's choice of what a download does before a virus scan (`allow_labeled`
   * or `block`). Metadata is the previous and the new value — closed tokens, never prose.
   */
  'organization.download_scan_policy_changed': {
    objectType: 'organization',
    clause:
      '§12 organization settings — whether unscanned files may be downloaded is a policy change',
  },
  /** A11. The company was renamed from the Organization card. No names in metadata. */
  'organization.renamed': {
    objectType: 'organization',
    clause: '§12 organization settings — the company name shown to members and clients',
  },
  /** A11. The company logo was set or removed. Metadata is `change`: `set` or `removed`. */
  'organization.logo_changed': {
    objectType: 'organization',
    clause: '§12 organization settings — the company logo shown to members and clients',
  },
  'security.capability_denied': {
    objectType: 'capability',
    // Recorded as `denied`, never as `allowed`; `AuditEventsRepository.append` refuses the
    // latter, because a row reading "this denial succeeded" describes nothing that happens.
    clause: '§12 "Denied sensitive attempts are security events with safe metadata"',
  },
  /**
   * ADM-11 (CQ-08). Billing module 19 (x284). A plan-change request is a recorded intent to move
   * an organization to another plan — the owner-only decision §12's "organization settings" names,
   * and the audit header promises every admin change is logged. Two actions, submitting and
   * cancelling; neither carries the free-text note (prose), only the target plan and the date.
   */
  'plan_change_request.submitted': {
    objectType: 'billing_plan_change_request',
    clause:
      '§12 organization settings — moving the organization to another plan is an admin change',
  },
  'plan_change_request.cancelled': {
    objectType: 'billing_plan_change_request',
    clause:
      '§12 organization settings — withdrawing a pending plan change is the same decision undone',
  },
  /**
   * MCP S14 FU1. One row per `tools/call` an AI client runs through /mcp with a token: who (the
   * token's user), which tool, and the outcome. Metadata never carries the token, args or body.
   */
  'mcp.tool_called': {
    objectType: 'mcp_tool_call',
    clause: '§12 API credentials — an AI client acting with a token',
  },
  /**
   * Q3. Deliverables and client approval (0211). What the studio sent the client, and what the
   * client decided, is the disclosure trail §12 asks for. Metadata is ids, a version number, a
   * reviewer count and a due date — never the title, the note or the client's feedback.
   */
  'deliverable.created': {
    objectType: 'deliverable',
    clause: '§12 — a deliverable is the record a client approval hangs off',
  },
  'deliverable.version_added': {
    objectType: 'deliverable',
    clause: '§12 — a new version changes what the client is asked to approve',
  },
  /** C7 (0228). A new version of a plain attachment — which file a download of it now serves. */
  'file_asset.version_added': {
    objectType: 'file_asset',
    clause: '§12 — a new version changes which file a work item, request or document serves',
  },
  'deliverable.sent_for_approval': {
    objectType: 'deliverable',
    clause: '§12 disclosure — publishing a version to the client and naming who decides',
  },
  'approval.approved': {
    objectType: 'approval',
    clause: '§12 — a client sign-off is a decision the organization relies on',
  },
  'approval.changes_requested': {
    objectType: 'approval',
    clause: '§12 — a client change request is the same decision, answered the other way',
  },
  'approval.invalidated': {
    objectType: 'approval',
    clause: '§12 — a newer version cancelled an approval still waiting on an older one',
  },
  /** Q4. A workspace admin sent a member a password-reset email (ids only, never the address). */
  'member.password_reset_sent': {
    objectType: 'membership',
    clause: '§12 security — starting a credential reset on somebody else is a sensitive action',
  },
  /** t2-b. A member changed their own name or job title (which fields changed, never the values). */
  'member.profile_updated': {
    objectType: 'membership',
    clause: '§12 — a change to how a person is named to the whole studio is worth a trail',
  },
  /** B4. A document's title was changed (ids only — never the old or new title). */
  'document.renamed': {
    objectType: 'document',
    clause: '§12 — a document title is how the whole project finds it; renaming it is a trail',
  },
  /** C1. A condition was removed from an automation rule (ids, field and operator — never the value). */
  'workflow_condition.deleted': {
    objectType: 'workflow_condition',
    clause: '§12 policy change — removing a condition widens who and what an automation acts on',
  },
  /** D5. An owner (or a member, about themselves) asked for a data export (kind + ids only). */
  'privacy_export.requested': {
    objectType: 'privacy_export',
    clause: '§12 data rights — who asked for a copy of whose data',
  },
  /** D5. The privacy job finished an export archive (size and scan status, never contents). */
  'privacy_export.ready': {
    objectType: 'privacy_export',
    clause: '§12 data rights — an archive of personal data now exists',
  },
  /** D5. The privacy job could not build or clear an export archive (a failure token only). */
  'privacy_export.failed': {
    objectType: 'privacy_export',
    clause: '§12 data rights — a request that was not fulfilled',
  },
  /** D5. Someone downloaded an export archive. */
  'privacy_export.downloaded': {
    objectType: 'privacy_export',
    clause: '§12 data export — a bulk copy of personal data left the system',
  },
  /** D5. A company or account deletion was requested, with its grace-period end. */
  'privacy_deletion.requested': {
    objectType: 'privacy_deletion_request',
    clause: '§12 data rights — a deletion request starts the grace period',
  },
  /** D5. A pending deletion was cancelled within its grace period. */
  'privacy_deletion.cancelled': {
    objectType: 'privacy_deletion_request',
    clause: '§12 data rights — a deletion request was withdrawn',
  },
  /** D5. The privacy job carried out a deletion after its grace period ended. */
  'privacy_deletion.executed': {
    objectType: 'privacy_deletion_request',
    clause: '§12 data rights — the deletion itself, after the grace period',
  },
  /**
   * Wave 9 S8 (F53). The audit trail left the system as a CSV. Metadata: which export, the row
   * count, whether actor/entity/action filters were set and the window bounds — never row content.
   */
  'audit.exported': {
    objectType: 'organization',
    clause: '§12 export — a bulk copy of the security log is itself a security event',
  },
  /** Wave 9 S8 (F53). The usage counters left the system as a CSV (row count and window only). */
  'usage.exported': {
    objectType: 'organization',
    clause: '§12 export — a bulk copy of the usage counters',
  },
  /** Wave 9 S8 (F56). A private admin note about a member was written (ids only, never the text). */
  'member_admin_note.created': {
    objectType: 'member_admin_note',
    clause: '§12 — a confidential note about a person exists from this moment',
  },
  /** Wave 9 S8 (F56). A private admin note about a member was deleted (ids only). */
  'member_admin_note.deleted': {
    objectType: 'member_admin_note',
    clause: '§12 — removing a confidential note must leave a trace',
  },
  /**
   * Wave 9 S8 (F09). The owner changed the company's sign-in policy (two-step requirement, trusted
   * networks). Metadata: previous and new two-step state and the allowlist entry count.
   */
  'organization.security_settings_changed': {
    objectType: 'organization',
    clause: '§12 policy change — who must use two-step sign-in, and from where',
  },
  // ---- platform-admin v2 · PA-01 ----
  /**
   * PA-01. One member's per-person permission overrides were changed (0242). Metadata: the target
   * user, how many overrides were added and removed; the `changes[]` rows name each capability.
   */
  'membership.permission_overrides_changed': {
    objectType: 'membership',
    clause: '§12 role and permission changes — one person gains or loses a permission',
  },
  // ---- platform-admin v2 · PA-03 ----
  /**
   * 0245 (SPEC P7): soft-deleted content is restored inside its window (`purge_after`). The
   * delete side already has its actions (`work_item.deleted`, `message.deleted`, …); a restore
   * brings content back into lists members read, so it is accounted for the same way.
   */
  'work_item.restored': {
    objectType: 'work_item',
    clause: '§12 — a deleted item returns to every list; who brought it back must be traceable',
  },
  'message.restored': {
    objectType: 'message',
    clause: '§12 moderation — a taken-down message shown again is a moderation decision reversed',
  },
  'direct_message.restored': {
    objectType: 'direct_message',
    clause: '§12 moderation — a removed direct message shown again',
  },
  'document.restored': {
    objectType: 'document',
    clause: '§12 — a deleted document returns to the project',
  },
  'decision.restored': {
    objectType: 'decision',
    clause: '§12 — a deleted decision returns to the register',
  },
  'meeting.restored': {
    objectType: 'meeting',
    clause: '§12 — a deleted meeting returns to the calendar',
  },
  'file_asset.restored': {
    objectType: 'file_asset',
    clause: '§12 — a deleted file is reachable again',
  },
  'comment.restored': {
    objectType: 'comment',
    clause:
      '§12 moderation — a deleted comment shown again (work, document, decision, file, request)',
  },
  'attachment.restored': {
    objectType: 'attachment',
    clause: '§12 — a detached file link returns (message, work item, meeting, Drive, OneDrive)',
  },
  'request_message.restored': {
    objectType: 'request_message',
    clause: '§12 — a removed request message shown again, possibly to the client',
  },
  // ---- platform-admin v2 · PA-05 ----
  /**
   * PA-05 (SPEC P3, §3.2). TManage support entered the organization through a hidden, time-limited
   * membership. The actor and the effective actor are the platform admin. Metadata: the support
   * session id, its length in minutes, and whether the admin's own membership was upgraded.
   */
  'support.session_started': {
    objectType: 'support_session',
    clause: '§12 cross-tenant support access — the owners must see that support was inside',
  },
  /** PA-05. The Support session ended (exit, expiry, sign-out or ended by another admin). */
  'support.session_ended': {
    objectType: 'support_session',
    clause: '§12 cross-tenant support access — when the operator access stopped, and how',
  },
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditAction = keyof typeof AUDIT_ACTION_CATALOG;

export const AUDIT_ACTIONS = Object.keys(AUDIT_ACTION_CATALOG) as readonly AuditAction[];

export function isAuditAction(value: string): value is AuditAction {
  return Object.hasOwn(AUDIT_ACTION_CATALOG, value);
}

/** The object type an action describes. Callers never choose it. */
export function auditObjectTypeFor(action: AuditAction): string {
  return AUDIT_ACTION_CATALOG[action].objectType;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plain-English labels — TXT-03 / ADM-11 (CQ-08)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A plain sentence for each action, for the admin audit viewer and the Control Center's
 * "recent changes" list (TXT-03 — "raw event codes" → "plain sentences with names").
 *
 * The raw action name (`custom_role.created`) is a stable machine key and the right thing to
 * filter and index by, but the wrong thing to show an owner reading the log. These are the
 * words shown instead. They are deliberately the *action* in human terms and nothing more — no
 * ids, no metadata — so this map stays non-sensitive and never needs the redaction the viewer
 * projection applies to everything else.
 *
 * `satisfies Record<AuditAction, string>` is the point: a new action added to the catalog is a
 * compile error here until it is given a label, so the viewer can never fall back to a raw code.
 */
const AUDIT_ACTION_LABELS = {
  'organization.provisioned': 'Set up the organization',
  'organization.download_scan_policy_changed': 'Changed downloads before a virus scan',
  'organization.renamed': 'Renamed the organization',
  'organization.logo_changed': 'Changed the organization logo',
  'project.created': 'Created a project',
  'work_item.created': 'Created a work item',
  'work_item.transitioned': 'Moved a work item to a new stage',
  'work_item.audience_changed': 'Changed who can see a work item',
  'work_item.deleted': 'Deleted a work item',
  'work_item.dependency_removed': 'Removed a work item dependency',
  'work_item.commented': 'Commented through an AI app',
  'client_organization.created': 'Added a client company',
  'client_organization.updated': 'Renamed a client company',
  'client_organization.archived': 'Archived a client company',
  'client_membership.invited': 'Invited a client contact',
  'client_membership.role_changed': "Changed a client contact's role",
  'client_membership.expiry_changed': "Changed a client contact's access expiry",
  'client_membership.status_changed': "Changed a client contact's access",
  'client_membership.shadowed_by_internal': 'Ignored a client access row held by a staff member',
  'membership.offboarded': 'Offboarded a member',
  'custom_role.created': 'Created a custom role',
  'custom_role.updated': 'Updated a custom role',
  'membership.role_changed': "Changed a member's role",
  'project.client_linked': 'Gave a client access to a project',
  'project.client_unlinked': "Removed a client's access to a project",
  'invitation.issued': 'Issued an invitation',
  'invitation.emailed': 'Sent an invitation email',
  'invitation.accepted': 'An invitation was accepted',
  'invitation.revoked': 'Revoked an invitation',
  'invitation.expired': 'Expired old invitations',
  'project_membership.granted': 'Added a member to a project',
  'project_membership.role_changed': "Changed a member's project role",
  'project_membership.revoked': 'Removed a member from a project',
  'client_request.submitted': 'A client submitted a request',
  'client_request.transitioned': 'Responded to a client request',
  'conversation.created': 'Created a channel',
  'conversation.member_added': 'Added someone to a channel',
  'conversation.member_removed': 'Removed someone from a channel',
  'message.deleted': 'Deleted a message',
  'upload_session.refused': 'Refused an upload',
  'upload_session.abort_failed': 'Could not cancel an upload',
  'file_asset.uploaded': 'Uploaded a file',
  'file_asset.verified': 'Verified a file',
  'file_asset.rejected': 'Rejected a file',
  'file_asset.scan_failed': 'Could not scan a file',
  'file_asset.scanned': 'Scanned a file',
  'file_asset.downloaded': 'Downloaded a file',
  'file_asset.scan_disputed': "A file's scan result changed",
  'file_asset.purged': 'Deleted stored file data',
  'upload_session.expired': 'Cleaned up an expired upload',
  'usage_counter.drift_corrected': 'Corrected a storage counter',
  'usage.threshold_reached': 'Storage reached its limit',
  'storage_connection.connected': 'Connected Google Drive',
  'storage_connection.settings_changed': 'Changed where files are stored',
  'storage_connection.disconnected': 'Disconnected Google Drive',
  'drive_attachment.attached': 'Attached a Google Drive file',
  'drive_attachment.removed': 'Removed a Google Drive file',
  'onedrive_attachment.attached': 'Attached a OneDrive file',
  'onedrive_attachment.removed': 'Removed a OneDrive file',
  'calendar_connection.connected': 'Connected a calendar',
  'calendar_connection.disconnected': 'Disconnected a calendar',
  'meeting.cancelled': 'Cancelled a meeting',
  'meeting.synced': 'Synced a meeting with a calendar',
  'drive_picker.session_issued': 'Opened the Google Drive file picker',
  'security.capability_denied': 'Blocked for a missing permission',
  'plan_change_request.submitted': 'Requested a plan change',
  'plan_change_request.cancelled': 'Cancelled a plan-change request',
  'mcp.tool_called': 'An AI app ran an action',
  'deliverable.created': 'Created a deliverable',
  'deliverable.version_added': 'Uploaded a new deliverable version',
  'file_asset.version_added': 'Uploaded a new file version',
  'deliverable.sent_for_approval': 'Sent a deliverable for client approval',
  'approval.approved': 'Approved a deliverable',
  'approval.changes_requested': 'Requested changes on a deliverable',
  'approval.invalidated': 'Cancelled an approval after a new version',
  'member.password_reset_sent': 'Sent a member a password reset',
  'member.profile_updated': 'Updated their own profile',
  'document.renamed': 'Renamed a document',
  'workflow_condition.deleted': 'Removed a condition from an automation rule',
  'privacy_export.requested': 'Asked for a data export',
  'privacy_export.ready': 'A data export was ready to download',
  'privacy_export.failed': 'A data export could not be made',
  'privacy_export.downloaded': 'Downloaded a data export',
  'privacy_deletion.requested': 'Asked for a deletion',
  'privacy_deletion.cancelled': 'Cancelled a deletion request',
  'privacy_deletion.executed': 'A requested deletion was carried out',
  'audit.exported': 'Exported the audit log',
  'usage.exported': 'Exported the usage figures',
  'member_admin_note.created': 'Added a private note about a member',
  'member_admin_note.deleted': 'Deleted a private note about a member',
  'organization.security_settings_changed': 'Changed how people sign in',
  // ---- platform-admin v2 · PA-01 ----
  'membership.permission_overrides_changed': "Changed one person's permissions",
  // ---- platform-admin v2 · PA-03 ----
  'work_item.restored': 'Restored a deleted work item',
  'message.restored': 'Restored a deleted message',
  'direct_message.restored': 'Restored a deleted direct message',
  'document.restored': 'Restored a deleted document',
  'decision.restored': 'Restored a deleted decision',
  'meeting.restored': 'Restored a deleted meeting',
  'file_asset.restored': 'Restored a deleted file',
  'comment.restored': 'Restored a deleted comment',
  'attachment.restored': 'Restored a removed attachment',
  'request_message.restored': 'Restored a deleted request message',
  // ---- platform-admin v2 · PA-05 ----
  'support.session_started': 'TManage support entered the workspace',
  'support.session_ended': 'TManage support left the workspace',
} as const satisfies Record<AuditAction, string>;

/** The plain sentence for an action, for display. Falls back to a de-coded action name. */
export function auditActionLabel(action: string): string {
  if (isAuditAction(action)) return AUDIT_ACTION_LABELS[action];
  // An action not in the catalog (an older row, a future producer) still reads as words rather
  // than as a dotted code: `foo.bar_baz` → `Foo bar baz`.
  const words = action.replace(/[_.]+/g, ' ').trim();
  return words.length === 0 ? action : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A one-line, non-sensitive gloss of an audit event for a human reader: the action in plain
 * words, with the outcome named when it is not a plain success. A refusal recorded against
 * `security.capability_denied` already reads as a block, so it is not suffixed twice.
 */
export function describeAuditEvent(action: string, result: AuditResult): string {
  const label = auditActionLabel(action);
  if (result === 'allowed' || action === 'security.capability_denied') return label;
  return result === 'denied' ? `${label} (refused)` : `${label} (failed)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe metadata
// ─────────────────────────────────────────────────────────────────────────────

export type AuditMetadataScalar = string | number | boolean | null;
export type AuditMetadataValue = AuditMetadataScalar | readonly AuditMetadataScalar[];
export type AuditMetadata = Readonly<Record<string, AuditMetadataValue>>;

export class UnsafeAuditMetadataError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(`Audit metadata is not safe to record: ${violations.join('; ')}`);
    this.name = 'UnsafeAuditMetadataError';
  }
}

/** Limits, in one place so a change to any of them is visible as a change to the rule. */
const MAX_KEYS = 20;
const MAX_KEY_LENGTH = 40;
const MAX_VALUE_LENGTH = 64;
const MAX_ARRAY_LENGTH = 20;

/** `snake_case`, matching the column names these values describe. */
const KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * Identifiers and classifications only.
 *
 * Letters, digits, and the four separators that appear in the identifiers this system
 * actually produces: `.` in an action name, `_` in an enum member, `-` in a UUID or slug, `:`
 * in a prefixed key. No space, so a sentence cannot pass; no `@`, so an address cannot; no
 * `/`, so a path or a URL cannot.
 */
const VALUE_PATTERN = /^[A-Za-z0-9._:-]*$/;

/**
 * Key names refused outright.
 *
 * This is the second line of defence — the value rules above already stop prose — and it
 * exists for the case where a short value is nonetheless disclosive: a six-character password
 * satisfies every shape rule in this file.
 *
 * Matched against the key's underscore-separated **segments**, singular or plural, rather
 * than as substrings. Substring matching was the first attempt and it was wrong in a way
 * worth recording: `ip` appears inside `membership`, so `membership_id` — the single most
 * common legitimate key this system will ever write — would have been refused. A denylist
 * that rejects the ordinary case gets deleted rather than fixed.
 *
 * Segment matching still costs a word occasionally, and one such collision is real and was
 * found by AUD-001's own first producer rather than by review. `subject` is here because an
 * email subject line is content; `subject_user_id` — the person an action was taken *upon* —
 * is not content at all, and it is the natural name for it. The resolution was to rename the
 * key to `target_user_id` rather than to admit `subject`, because the denylist is cheap to
 * work around and expensive to re-tighten: a rule relaxed once for a good reason is a rule
 * the next person relaxes for a worse one.
 */
const FORBIDDEN_KEY_SEGMENTS: readonly string[] = [
  'body',
  'content',
  'text',
  'message',
  'comment',
  'note',
  'reason',
  'rationale',
  'description',
  'subject',
  'title',
  'password',
  'secret',
  'token',
  'credential',
  'signature',
  'email',
  'phone',
  'address',
  'ip',
  'agent',
  'payload',
];

const FORBIDDEN_SEGMENT_SET: ReadonlySet<string> = new Set(
  // Both the singular and the plural, so `note` also refuses `notes`. Spelled out here
  // rather than by stripping a trailing `s` at match time, because that heuristic would
  // also turn `status` into `statu` and make the set's membership unreadable.
  FORBIDDEN_KEY_SEGMENTS.flatMap((segment) => [segment, `${segment}s`]),
);

function forbiddenSegment(key: string): string | undefined {
  return key.split('_').find((segment) => FORBIDDEN_SEGMENT_SET.has(segment));
}

/**
 * Refuse anything that is not identifiers and classifications.
 *
 * Reports every violation rather than the first, because a writer fixing metadata wants the
 * whole list; a rule that reveals its objections one round trip at a time gets worked around.
 */
export function assertSafeAuditMetadata(metadata: unknown): asserts metadata is AuditMetadata {
  const violations: string[] = [];

  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new UnsafeAuditMetadataError(['metadata must be a plain object']);
  }

  const entries = Object.entries(metadata);
  if (entries.length > MAX_KEYS) {
    violations.push(`metadata has ${entries.length} keys; the limit is ${MAX_KEYS}`);
  }

  for (const [key, value] of entries) {
    if (key.length > MAX_KEY_LENGTH) {
      violations.push(`key '${key}' is longer than ${MAX_KEY_LENGTH} characters`);
    }
    if (!KEY_PATTERN.test(key)) {
      violations.push(`key '${key}' is not snake_case`);
    }
    const forbidden = forbiddenSegment(key);
    if (forbidden !== undefined) {
      violations.push(`key '${key}' names '${forbidden}', which is content rather than a fact`);
    }

    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) {
        violations.push(
          `key '${key}' holds ${value.length} items; the limit is ${MAX_ARRAY_LENGTH}`,
        );
      }
      value.forEach((item, index) => {
        violations.push(...scalarViolations(`${key}[${index}]`, item));
      });
      continue;
    }

    violations.push(...scalarViolations(key, value));
  }

  if (violations.length > 0) throw new UnsafeAuditMetadataError(violations);
}

function scalarViolations(label: string, value: unknown): readonly string[] {
  if (value === null || typeof value === 'boolean') return [];

  if (typeof value === 'number') {
    // `NaN` and the infinities serialise to `null` in JSON, so a metric recorded as one would
    // read back as "absent" rather than as "wrong" — the worse of the two failures.
    return Number.isFinite(value) ? [] : [`'${label}' is not a finite number`];
  }

  if (typeof value === 'string') {
    const problems: string[] = [];
    if (value.length > MAX_VALUE_LENGTH) {
      problems.push(`'${label}' is longer than ${MAX_VALUE_LENGTH} characters`);
    }
    if (!VALUE_PATTERN.test(value)) {
      // The value itself is not quoted back. It is the thing under suspicion of being
      // content, and an error message is a place content leaks to just as readily.
      problems.push(`'${label}' contains characters outside identifiers and classifications`);
    }
    return problems;
  }

  return [`'${label}' is a ${typeof value}; only strings, numbers, booleans and null are safe`];
}

/**
 * The non-throwing form, for a caller that must not fail the operation it is describing.
 *
 * The exception filter is the reason this exists: a denial has already been decided by the
 * time it writes an audit row, and throwing there would turn a 403 into a 500 — telling the
 * caller *more* because the server tried to record that it told them less.
 */
export function isSafeAuditMetadata(metadata: unknown): metadata is AuditMetadata {
  try {
    assertSafeAuditMetadata(metadata);
    return true;
  } catch {
    return false;
  }
}
