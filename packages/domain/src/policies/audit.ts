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
  /**
   * R4 slice 4. A viewer opened a TManage-made preview of a file (a page image, a thumbnail, a
   * sanitised SVG). One `allowed` row per principal and file per short window — not one per tile —
   * and a `denied` row for every refused manifest or preview read, the cause on `audit_code`. Ids,
   * the version, the preview kind and the principal's kind only.
   */
  /**
   * R4 slice 5. Somebody opened a proofing thread on a file (a pin, a box, a drawing, a moment, a
   * cell, or no place) with its first comment. Ids, the audience, the anchor kind and the number of
   * people mentioned only — never the text. `denied` rows carry the refusal on `audit_code`.
   */
  'review.thread_created': {
    objectType: 'review_thread',
    clause:
      '§12 — client-visible collaboration on a file is a disclosure; R4 SPEC §3.4 audit ' +
      'review.thread_created',
  },
  /** R4 slice 5. A reply on a proofing thread. Ids and the mention count only. */
  'review.comment_added': {
    objectType: 'review_thread',
    clause: '§12 — collaboration on a file; R4 SPEC §3.4 audit review.comment_added',
  },
  /** R4 slice 5. A proofing thread was resolved or reopened (`resolved` in metadata). */
  'review.thread_resolved': {
    objectType: 'review_thread',
    clause: '§12 — a review state change on a file; R4 SPEC §3.4 audit review.thread_resolved',
  },
  /**
   * R4 slice 11. Somebody approved a version of a plain file or asked for changes on it. Ids, the
   * decision and the principal's kind only — never the note.
   */
  'review.decision_recorded': {
    objectType: 'file_asset',
    clause:
      '§12 — a client or team decision on a file version; R4 SPEC §3.4 audit ' +
      'review.decision_recorded',
  },
  /**
   * R4 slice 13. A member connected or disconnected their own Figma token (`connected` in
   * metadata). The token never appears; the hint does not either.
   */
  'figma.connection_changed': {
    objectType: 'figma_connection',
    clause: '§12 — a stored third-party credential changed; R4 SPEC §3.3 figma/connection',
  },
  /** R4 slice 13. A Figma file was attached to a project (ids, audience, frame count only). */
  'figma.link_attached': {
    objectType: 'figma_link',
    clause: '§12 — design content attached to a project; R4 SPEC §3.4 audit figma.link_attached',
  },
  /** R4 slice 13. A Figma link was removed from a project. */
  'figma.link_removed': {
    objectType: 'figma_link',
    clause: '§12 — design content removed from a project; R4 SPEC §3.3 DELETE figma/links',
  },
  /**
   * Security review M2 (2026-11-14). "Refresh from Figma" read a link's file again (counts of
   * frames added, updated, removed and queued; no names).
   */
  'figma.link_refreshed': {
    objectType: 'figma_link',
    clause: "§12 — design content read again from Figma with the link creator's token",
  },
  /** R4 slice 13. A frame snapshot was stored (ids, size, whether the frame changed). */
  'figma.snapshot_taken': {
    objectType: 'figma_frame',
    clause: '§12 — a copy of client design content stored; R4 SPEC §3.4 audit figma.snapshot_taken',
  },
  'file_preview.viewed': {
    objectType: 'file_asset',
    clause:
      '§12 — a rendered preview discloses file content the way a download does; R4 SPEC §3.3 ' +
      'audit file_preview.viewed',
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
  /**
   * 0356 (51-17). An owner or admin asks another admin to take the company storage connection
   * over, and that admin's own consent completes it (the root stays). Metadata is the provider and
   * the two user ids — never the token or an e-mail.
   */
  'storage_connection.handover_requested': {
    objectType: 'storage_connection',
    clause: '§12 organization settings — naming who takes over the company storage connection',
  },
  'storage_connection.handover': {
    objectType: 'storage_connection',
    clause: '§12 organization settings — the company storage connection changed hands',
  },
  /**
   * 0364 (57-13b). An owner or admin started moving the files TManage still holds into the
   * company's connected Drive or OneDrive. Metadata is the provider and the file count.
   */
  'storage_migration.started': {
    objectType: 'storage_migration_job',
    clause: '§12 organization settings — moving the company files to its own storage',
  },
  /** 0364 (57-13b). The move job finished or stopped; metadata is the counts and the reason. */
  'storage_migration.finished': {
    objectType: 'storage_migration_job',
    clause: '§12 — a system job moved tenant files and deleted their local copies',
  },
  /**
   * 0366 (56-26). An owner or admin cleared a bounce suppression: the company mails that address
   * again. No object row id (the record is keyed by an address hash, never logged); metadata says
   * only whether the address was suppressed.
   */
  'mail_bounce.cleared': {
    objectType: 'mail_recipient_bounce',
    clause: '§12 organization settings — letting the company mail an address that bounced',
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
   * FIX6 C1. A picked Google Drive or OneDrive file fetched on the server with the company
   * connection and stored as a checked TManage copy: for a work item, or for a deliverable's next
   * version. Metadata: provider, the SHA-256 of the external id, the work item or deliverable id.
   */
  'work_item.drive_file_imported': {
    objectType: 'file_asset',
    clause: '§12 — content brought into a tenant record from an external store',
  },
  'deliverable.drive_version_imported': {
    objectType: 'file_asset',
    clause: '§12 — content brought in from an external store to become what a client approves',
  },
  /**
   * FIX6 C3. A Google Drive or OneDrive folder attached to a work item (its children are read live)
   * or removed from it. Metadata: provider, the SHA-256 of the folder id, the work item id.
   */
  'work_item.cloud_folder_attached': {
    objectType: 'work_item',
    clause: '§12 — an external store linked live into a tenant record',
  },
  'work_item.cloud_folder_removed': {
    objectType: 'work_item',
    clause: '§12 — the same link removed (the folder itself is never touched)',
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
  /** 53-14. A person turned their due-date mirror on or off. Metadata: provider, enabled. */
  'calendar_connection.mirror_changed': {
    objectType: 'calendar_connection',
    clause: '§12 53-14 — work item due dates shown (or no longer) in a personal calendar',
  },
  /** 53-14. A person created or replaced their secret calendar feed address (hash stored only). */
  'calendar_feed.issued': {
    objectType: 'calendar_feed',
    clause: '§12 53-14 — a read-only calendar feed address issued; any earlier one stops working',
  },
  'calendar_feed.revoked': {
    objectType: 'calendar_feed',
    clause: '§12 53-14 — the calendar feed address revoked',
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
  /**
   * FIX6 item 1. The company owner's choice of which files clients can receive (`checked` or
   * `virus_scanned`). Metadata is the previous and the new value — closed tokens, never prose.
   */
  'organization.client_file_policy_changed': {
    objectType: 'organization',
    clause: '§12 organization settings — which files may reach clients is a policy change',
  },
  /** FIX-2026-11-10. The owner set automatic time tracking off, optional or required. */
  'organization.auto_time_tracking_policy_changed': {
    objectType: 'organization',
    clause: '§12 organization settings — whether time is tracked automatically is a policy change',
  },
  /**
   * 52-01. The owner chose the manual timer's rounding step (minutes; 1 = no rounding). Metadata
   * is the previous and the new step — numbers, never prose.
   */
  'organization.time_rounding_changed': {
    objectType: 'organization',
    clause: '§12 organization settings — how manual timer time is rounded changes what is billed',
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
  /** FIX6 item 8. A deliverable deleted (soft, with Undo) or brought back. Metadata: project id. */
  'deliverable.deleted': {
    objectType: 'deliverable',
    clause: '§12 — deleting a deliverable takes it out of the client portal',
  },
  'deliverable.restored': {
    objectType: 'deliverable',
    clause: '§12 — restoring a deliverable puts its shared versions back in the portal',
  },
  /** UX-1. A version put in the client portal by "Share with client" (no approval, no e-mail). */
  'deliverable.shared_with_client': {
    objectType: 'deliverable',
    clause: '§12 disclosure — publishing a version to the client portal',
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
  /**
   * QA-FIX-O H1. "Resend email" on a pending approval: the approval-request e-mail was queued
   * again for its approvers (ids only: the send's id and how many approvers).
   */
  'approval.email_resent': {
    objectType: 'approval',
    clause: '§12 disclosure — e-mailing a client person again about a version to decide',
  },
  /** 52-19. An approval's evidence bundle (record PDF, approved file, chain proof) was downloaded. */
  'approval.evidence_exported': {
    objectType: 'approval',
    clause:
      '§12 export — a copy of the sealed approval record and the approved file left the system',
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
  /** FIX3 item 6. A document was archived out of the Docs lists, or brought back (ids only). */
  'document.archived': {
    objectType: 'document',
    clause: '§12 — archiving hides a document from the whole project; it is a trail',
  },
  'document.unarchived': {
    objectType: 'document',
    clause: '§12 — bringing an archived document back is a trail',
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
  /**
   * 56-18 follow-up (0358). The retention purge removed audit entries older than the
   * organization's explicitly set window. Metadata: how many, the cutoff and the window — never
   * the removed rows' content.
   */
  'audit.purged': {
    objectType: 'organization',
    clause: '§12 retention — removing old security-log entries is itself a security event',
  },
  /** Wave 9 S8 (F53). The usage counters left the system as a CSV (row count and window only). */
  'usage.exported': {
    objectType: 'organization',
    clause: '§12 export — a bulk copy of the usage counters',
  },
  /** 54-29. A project's work items left the system as CSV or JSON (format and row count only). */
  'project.exported': {
    objectType: 'project',
    clause: '§12 export — a bulk copy of one project’s work items',
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
  /**
   * 2026-10-31 live test (10-admin). The access policy (session length, invite domains, outside
   * people) was changed. Metadata: the keys changed and the new session length.
   */
  'organization.access_policy_changed': {
    objectType: 'organization',
    clause: '§12 policy change — how long sign-ins last and who may be let in',
  },
  /** 2026-10-31 live test (10-admin). A trusted network range was added (the range, never a label). */
  'ip_allowlist.entry_added': {
    objectType: 'ip_allowlist_entry',
    clause: '§12 policy change — a network the company trusts was added',
  },
  /** 2026-10-31 live test (10-admin). A trusted network range was removed. */
  'ip_allowlist.entry_removed': {
    objectType: 'ip_allowlist_entry',
    clause: '§12 policy change — a network the company trusts was removed',
  },
  /** 2026-10-31 live test (10-admin). The billing tax details were saved (country only in metadata). */
  'billing_tax_details.updated': {
    objectType: 'organization',
    clause: '§12 — the legal name and tax details invoices carry were changed',
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
  // ---- platform-admin v2 · PA-04 ----
  /**
   * PA-04. A custom role was deleted from the permission editor: its holders were moved to the
   * replacement role first (one `membership.role_changed` each), then the role was retired.
   * Metadata: how many holders were reassigned.
   */
  'custom_role.deleted': {
    objectType: 'custom_role',
    clause: '§12 role and permission changes — a set of capabilities nobody can hold any more',
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
  // ---- platform-admin v2 · PA-08 ----
  /**
   * PA-08 (SPEC §5.4). Content moderation from the Platform admin content browser, written under
   * the Support session's tenant context: `effective_actor_id` is the platform admin, the before
   * and after values go to `audit_event_changes`. The delete side of the kinds that had no delete
   * action yet, and the edits that had none.
   */
  'message.edited': {
    objectType: 'message',
    clause: '§12 moderation — somebody else changed what a person said; before and after kept',
  },
  'work_item.updated': {
    objectType: 'work_item',
    clause: '§12 cross-tenant support access — support changed a work item; before and after kept',
  },
  'decision.updated': {
    objectType: 'decision',
    clause: '§12 cross-tenant support access — support changed a recorded decision',
  },
  'meeting.updated': {
    objectType: 'meeting',
    clause: '§12 cross-tenant support access — support changed a meeting',
  },
  'direct_message.deleted': {
    objectType: 'direct_message',
    clause: '§12 moderation — a direct message taken down',
  },
  'comment.deleted': {
    objectType: 'comment',
    clause: '§12 moderation — a comment taken down (work, document, decision, file, request)',
  },
  'document.deleted': {
    objectType: 'document',
    clause: '§12 — a document leaves the project; who removed it must be traceable',
  },
  'decision.deleted': {
    objectType: 'decision',
    clause: '§12 — a decision leaves the register; who removed it must be traceable',
  },
  'meeting.deleted': {
    objectType: 'meeting',
    clause: '§12 — a meeting leaves the calendar; who removed it must be traceable',
  },
  'file_asset.deleted': {
    objectType: 'file_asset',
    clause: '§12 — a file is no longer reachable; who removed it must be traceable',
  },
  'attachment.deleted': {
    objectType: 'attachment',
    clause: '§12 — a Drive or OneDrive file link removed from a work item',
  },
  'request_message.deleted': {
    objectType: 'request_message',
    clause: '§12 moderation — a request message taken down, possibly one the client saw',
  },
  // ---- 56-07 · public links ----
  'public_link.created': {
    objectType: 'public_link',
    clause: '§12 56-07 — a link an outsider can open was issued for one object',
  },
  'public_link.opened': {
    objectType: 'public_link',
    clause: '§12 56-07 — an outsider opened a public link (100 % of outsider actions are audited)',
  },
  'public_link.decided': {
    objectType: 'public_link',
    clause: '§12 56-07 — the one terminal decision an outsider made through a link',
  },
  'public_link.revoked': {
    objectType: 'public_link',
    clause: '§12 56-07 — a public link was cancelled before it expired',
  },
  'public_link.expiry_changed': {
    objectType: 'public_link',
    clause: '§12 56-07p — an owner or admin moved the day a public link stops working',
  },
  // ---- 52-08 · quotes ----
  'quote.created': {
    objectType: 'quote',
    clause: '§12 52-08 — a quote was drafted for a client or lead',
  },
  'quote.updated': {
    objectType: 'quote',
    clause: '§12 52-08 — a draft quote was changed (lines, totals, validity or terms)',
  },
  'quote.sent': {
    objectType: 'quote',
    clause: '§12 52-08 — a quote was frozen and an accept link issued to an outsider',
  },
  'quote.accepted': {
    objectType: 'quote',
    clause: '§12 52-08 — a client accepted a quote through its link (business acceptance)',
  },
  'quote.declined': {
    objectType: 'quote',
    clause: '§12 52-08 — a client declined a quote through its link',
  },
  'quote.converted': {
    objectType: 'quote',
    clause: '§12 52-08 — an accepted quote was turned into a project (lines became work items)',
  },
  // ---- 52-23 · money foundations ----
  'finance_profile.updated': {
    objectType: 'finance_profile',
    clause: '§12 52-23 — the organization finance profile was changed (TRN kept as last four)',
  },
  'tax_rate.created': {
    objectType: 'tax_rate',
    clause: '§12 52-23 — a tax rate was added',
  },
  'tax_rate.updated': {
    objectType: 'tax_rate',
    clause: '§12 52-23 — a tax rate was changed or restored',
  },
  'tax_rate.archived': {
    objectType: 'tax_rate',
    clause: '§12 52-23 — a tax rate was archived',
  },
  'exchange_rate.created': {
    objectType: 'exchange_rate',
    clause: '§12 52-23 — a manual exchange rate was recorded',
  },
  // ---- 52-01 · timer ----
  'time_timer.started': {
    objectType: 'time_timer',
    clause: '§12 52-01 — a member started their timer (ids only)',
  },
  'time_timer.auto_stopped': {
    objectType: 'time_timer',
    clause: '§12 52-01 — the worker stopped a forgotten timer and filed an entry to review',
  },
  /**
   * UX test T-P1-1. A member threw away their own running timer: nothing was filed. Metadata is
   * the elapsed seconds only.
   */
  'time_timer.discarded': {
    objectType: 'time_timer',
    clause: '§12 52-01 — a member discarded their running timer; no time was filed',
  },
  'time_log.created': {
    objectType: 'time_log',
    clause: '§12 52-01 — a time entry was logged (manual or a stopped timer)',
  },
  // ---- R13-s4 · 53-02 ----
  'working_calendar.updated': {
    objectType: 'working_calendar',
    clause: '§12 53-02 — the company or a project working calendar or its holidays changed',
  },
  'working_calendar.holidays_imported': {
    objectType: 'working_calendar',
    clause: '§12 53-02 — a holiday pack was imported (pack key and pack version recorded)',
  },
  // ---- 62-27 (B05) · signals engine ----
  'work_signal_settings.updated': {
    objectType: 'organization',
    clause: '§12 62-27 — the owner changed the alert rules (on/off, threshold, who is told)',
  },
  // ---- R13-s2 · outbound webhooks v2 (54-03 + 56-08) ----
  'webhook.secret_rotated': {
    objectType: 'webhook_endpoint',
    clause: '§12 56-08 — a webhook signing secret was rotated (key ids only, never the secret)',
  },
  'webhook.paused': {
    objectType: 'webhook_endpoint',
    clause: '§12 56-08 — a webhook endpoint was paused by an admin',
  },
  'webhook.resumed': {
    objectType: 'webhook_endpoint',
    clause: '§12 56-08 — a paused webhook endpoint was resumed',
  },
  'webhook.replayed': {
    objectType: 'webhook_endpoint',
    clause: '§12 54-03 — past events were queued again for a webhook endpoint',
  },
  // ---- R14-b · API tokens (56-09 follow-up) ----
  /**
   * A personal access token was created. Metadata: the scopes, `never_expires`, and `network_limited`
   * (limited to a network allowlist). Never the token, its hash or its prefix.
   */
  'personal_access_token.created': {
    objectType: 'personal_access_token',
    clause: '§12 API credentials — a personal access token was issued',
  },
  /**
   * A personal access token was revoked: `by` is `owner` (its member), `admin` (the org overview,
   * with `target_membership_id`) or `session_ended` (N04: the creating session ended mid-create).
   */
  'personal_access_token.revoked': {
    objectType: 'personal_access_token',
    clause: '§12 API credentials — a personal access token was withdrawn',
  },
  /** A connected AI app (MCP OAuth grant) was disconnected from the org token overview by an admin. */
  'oauth_grant.revoked': {
    objectType: 'oauth_grant',
    clause: '§12 API credentials — a connected app and its tokens were withdrawn by an admin',
  },
  // ---- R15-b · 52-03 period locks ----
  /** A window of whole months was closed. Metadata: `period_start`, `period_end`, `entries_locked`. */
  'time_period.locked': {
    objectType: 'time_period_lock',
    clause: '§12 52-03 — a time period was locked (window and entry count)',
  },
  /** A closed window was reopened. The typed why lives on the row, never in the metadata. */
  'time_period.unlocked': {
    objectType: 'time_period_lock',
    clause: '§12 52-03 — a locked time period was reopened (the why is kept on the lock row)',
  },
  'time_period.unlock_requested': {
    objectType: 'time_period_lock',
    clause: '§12 52-03 — a member asked finance to reopen a locked time period',
  },
  // ---- R15-a · 52-04 rates ----
  'rate_card.created': {
    objectType: 'rate_card',
    clause: '§12 52-04 — a rate card was created',
  },
  'rate_card.updated': {
    objectType: 'rate_card',
    clause: '§12 52-04 — a rate card was renamed, archived or assigned to a project',
  },
  'rate_card.entry_added': {
    objectType: 'rate_card',
    clause: '§12 52-04 — a rate was added to a rate card',
  },
  'rate_card.entry_removed': {
    objectType: 'rate_card',
    clause: '§12 52-04 — a rate was removed from a rate card',
  },
  /** A member's internal cost rate changed. The amount is redacted in the changes, never stored. */
  'cost_rate.changed': {
    objectType: 'membership',
    clause: '§12 52-04 — a member cost rate (salary proxy) was changed',
  },
  /** Unbilled, unlocked time entries were re-priced; metadata carries the count only. */
  'rates.repriced': {
    objectType: 'organization',
    clause: '§12 52-04 — unbilled time entries were re-priced',
  },
  'work_item.billable_changed': {
    objectType: 'work_item',
    clause: '§12 52-04 — whether a work item is billable was changed',
  },
  // ---- R15-c · 54-05 / 54-06 Phase 0 — Slack / Teams channel notices ----
  /** A channel link was created. Metadata: kind, url_host, event count — never the URL. */
  'channel_link.created': {
    objectType: 'integration_channel_link',
    clause: '§12 54-05 — a Slack or Teams channel was connected by a pasted webhook URL',
  },
  'channel_link.removed': {
    objectType: 'integration_channel_link',
    clause: '§12 54-05 — a Slack or Teams channel link was removed',
  },
  'channel_link.paused': {
    objectType: 'integration_channel_link',
    clause: '§12 54-05 — a Slack or Teams channel link was paused',
  },
  'channel_link.resumed': {
    objectType: 'integration_channel_link',
    clause: '§12 54-05 — a paused Slack or Teams channel link was resumed',
  },
  // ---- R16-e · 54-10 GitHub Phase 0 — repository webhooks, work keys, code links ----
  /** A repository webhook was added. Metadata: repo, project count — never the secret. */
  'github_hook.created': {
    objectType: 'github_repo_hook',
    clause: '§12 54-10 — a GitHub repository webhook was connected',
  },
  'github_hook.removed': {
    objectType: 'github_repo_hook',
    clause: '§12 54-10 — a GitHub repository webhook was removed',
  },
  'github_hook.secret_rotated': {
    objectType: 'github_repo_hook',
    clause: '§12 54-10 — a GitHub repository webhook secret was rotated',
  },
  /**
   * FIX5. An owner or admin connected GitHub in one click (an org-wide OAuth token into the
   * vault) or disconnected it. Metadata: the provider and whether a stored token was replaced —
   * never the token, its hint or the account.
   */
  'github_connection.connected': {
    objectType: 'connector_installation',
    clause: '§12 — a stored org-wide third-party credential was added or replaced',
  },
  'github_connection.disconnected': {
    objectType: 'connector_installation',
    clause: '§12 — a stored org-wide third-party credential was removed',
  },
  'project.work_key_prefix_set': {
    objectType: 'project',
    clause: '§12 54-10 — a project work-key prefix was set',
  },
  'work_item.code_link_removed': {
    objectType: 'work_item',
    clause: '§12 54-10 — a code link was removed from a work item',
  },
  // ---- R16-a · 52-02 timesheets / 52-03 approvals ----
  /**
   * Entries of a week were edited (batch edit, unsorted move or copy from another week). Metadata:
   * `before_minutes`, `after_minutes`, `entries_changed`, and `edited_for_membership_id` when a
   * manager edited somebody else's week. Never a note.
   */
  'timesheet.entries_edited': {
    objectType: 'timesheet',
    clause: '§12 52-02 — time entries of a week were edited (minutes before and after)',
  },
  'timesheet.submitted': {
    objectType: 'timesheet',
    clause: '§12 52-02 — a member submitted a week of time',
  },
  'timesheet.approved': {
    objectType: 'timesheet',
    clause: '§12 52-03 — a manager approved a week of time',
  },
  /** The typed note lives on the timesheet row, never in the metadata. */
  'timesheet.changes_requested': {
    objectType: 'timesheet',
    clause: '§12 52-03 — a manager asked for changes to a week of time',
  },
  /** A week was downloaded as CSV (an export; no notes leave). */
  'timesheet.exported': {
    objectType: 'timesheet',
    clause: '§12 52-02 — a week of time was exported as CSV',
  },
  // ---- R16-c · 52-07 expenses ----
  /**
   * An expense was recorded, changed, submitted, decided, deleted or exported. Amounts and receipt
   * ids may appear in the changes; a note never does (redacted).
   */
  'expense.created': {
    objectType: 'expense',
    clause: '§12 52-07 — a member recorded an expense',
  },
  'expense.updated': {
    objectType: 'expense',
    clause: '§12 52-07 — an expense was changed (amount edits bump its version)',
  },
  'expense.submitted': {
    objectType: 'expense',
    clause: '§12 52-07 — an expense was submitted for approval',
  },
  'expense.approved': {
    objectType: 'expense',
    clause: '§12 approval decision — an expense was approved (by a manager or the threshold)',
  },
  'expense.rejected': {
    objectType: 'expense',
    clause: '§12 approval decision — an expense was rejected (the why stays on the row)',
  },
  'expense.deleted': {
    objectType: 'expense',
    clause: '§12 52-07 — a member deleted an own draft expense',
  },
  'expense.exported': {
    objectType: 'organization',
    clause: '§12 export — expenses were exported as CSV',
  },
  // ---- R16-b · 52-05 budgets and burn ----
  /** A project budget was saved. Metadata: budget type, thresholds, client visibility, phase count. */
  'budget.updated': {
    objectType: 'project',
    clause: '§12 52-05 — a project budget (type, thresholds, client visibility) was changed',
  },
  /** The burn sweep raised a threshold alert. System actor; metadata: threshold and used bp. */
  'budget.alert_raised': {
    objectType: 'project',
    clause: '§12 52-05 — a project budget crossed an alert threshold',
  },
  // ---- R16-f · 54-11 Phase 0 — contact suggestions ----
  /** A person imported a contacts file into their own suggestions. Metadata: counts and source only. */
  'contacts.imported': {
    objectType: 'contact_suggestion',
    clause:
      '§12 54-11 — a contacts file was imported into invite suggestions (counts, never emails)',
  },
  'contacts.cleared': {
    objectType: 'contact_suggestion',
    clause: '§12 54-11 — a person cleared their own invite suggestions',
  },
  // ---- R16-d · 53-04 typed dependencies and cascade ----
  /** An edge was added. Metadata: depended-on id, kind, lag, source. */
  'work_item.dependency_added': {
    objectType: 'work_item',
    clause: '§12 53-04 — a typed dependency (kind and lag) now constrains this item’s dates',
  },
  /** An edge's kind or lag changed. Metadata: dependency id, kind and lag before and after. */
  'work_item.dependency_changed': {
    objectType: 'work_item',
    clause: '§12 53-04 — a dependency’s kind or lag changed, so the schedule it drives changed',
  },
  /** A cascade moved this item's dates. Metadata: start/due before and after, the root item. */
  'work_item.rescheduled': {
    objectType: 'work_item',
    clause: '§12 53-04 — a schedule cascade moved this item’s start and due dates',
  },
  // ---- R17-a · 52-14 profitability and utilisation reports ----
  /** A finance report was exported as CSV. Metadata: report, group-by, range; never a figure. */
  'finance.report_exported': {
    objectType: 'organization',
    clause: '§12 52-14 export — a profitability / unbilled / utilisation report left as CSV',
  },
  /** The finance facts were rebuilt on demand. Metadata: the window (from, to) and rows written. */
  'finance.facts_rebuilt': {
    objectType: 'organization',
    clause: '§12 52-14 — the nightly finance facts were recomputed on demand',
  },
  // ---- R17-c · 53-05 baselines on the timeline ----
  /** A baseline was saved. Metadata: kind, item and milestone counts; never the label or note. */
  'baseline.created': {
    objectType: 'project_baseline',
    clause: '§12 53-05 — a project schedule baseline was frozen',
  },
  /** A baseline became the project's current one (the timeline overlay). */
  'baseline.activated': {
    objectType: 'project_baseline',
    clause: '§12 53-05 — a baseline became the current one the timeline compares against',
  },
  /** A baseline (and its frozen items) was deleted. */
  'baseline.deleted': {
    objectType: 'project_baseline',
    clause: '§12 53-05 — a project schedule baseline was deleted',
  },
  // ---- R17-d · 52-06 retainers ----
  /** A retainer was created. Metadata: client org, period, hours, rollover, project count, amount. */
  'retainer.created': {
    objectType: 'retainer',
    clause: '§12 52-06 — a client retainer (allowance, period, covered projects) was created',
  },
  /** A retainer was edited. Metadata: the changed fields (hours, amount, rollover, visibility). */
  'retainer.updated': {
    objectType: 'retainer',
    clause: '§12 52-06 — a retainer’s allowance, rollover, visibility or projects changed',
  },
  'retainer.paused': {
    objectType: 'retainer',
    clause: '§12 52-06 — a retainer was paused (its periods stop rolling)',
  },
  'retainer.resumed': {
    objectType: 'retainer',
    clause: '§12 52-06 — a paused retainer was resumed',
  },
  'retainer.ended': {
    objectType: 'retainer',
    clause: '§12 52-06 — a retainer was ended (no further period opens)',
  },
  /** The hourly roll closed a period. System actor; metadata: period id, used/overage, rollover. */
  'retainer.period_closed': {
    objectType: 'retainer',
    clause: '§12 52-06 — a retainer period closed and its usage was frozen',
  },
  // ---- R17-b · 53-06 critical path ----
  /** A manager recomputed a project's critical path on demand. Metadata: project, batch, items. */
  'schedule.recomputed': {
    objectType: 'project',
    clause: '§12 53-06 — a project’s critical path and float were recomputed on demand',
  },
  // ---- R17-e · 53-09 recurring work v2 ----
  /** A repeat rule was set or changed. Metadata: freq, spawn mode, holiday policy. */
  'recurrence.updated': {
    objectType: 'work_item',
    clause: '§12 53-09 — a work item’s repeat rule (who it spawns as, how often) was changed',
  },
  /** Paused by a member, or by the spawner when the owner lost `work.create` (cause in metadata). */
  'recurrence.paused': {
    objectType: 'work_item',
    clause: '§12 53-09 / doc 25 §10 — a repeat rule was paused (fail closed on a lost capability)',
  },
  'recurrence.resumed': {
    objectType: 'work_item',
    clause: '§12 53-09 — a paused repeat rule was resumed',
  },
  'recurrence.ended': {
    objectType: 'work_item',
    clause: '§12 53-09 — a repeat rule was ended (no further occurrence spawns)',
  },
  /** One occurrence was skipped ahead of time. Metadata: occurrence key. */
  'recurrence.skipped': {
    objectType: 'work_item',
    clause: '§12 53-09 — one occurrence of a repeat rule was skipped',
  },
  /** The spawner created an occurrence. Service actor; metadata: entry point, key, series item. */
  'recurrence.spawned': {
    objectType: 'work_item',
    clause: '§12 53-09 / doc 25 §10 — the recurrence spawner created a work item for a series',
  },
  // ---- R18-a · 52-09 client invoices ----
  /** A draft invoice was created. Metadata: client org, kind, language, currency. */
  'client_invoice.created': {
    objectType: 'client_invoice',
    clause: '§12 52-09 — a client invoice draft was created',
  },
  /** An invoice was issued. Metadata: number, total, currency, recipient count, mail or mark-sent. */
  'client_invoice.sent': {
    objectType: 'client_invoice',
    clause: '§12 52-09 — a client invoice was numbered, frozen and sent (or marked sent)',
  },
  /** A payment was recorded. Metadata: amount, method, the state it moved to. */
  'client_invoice.payment_recorded': {
    objectType: 'client_invoice',
    clause: '§12 52-09 — a payment against a client invoice was recorded',
  },
  /** A draft was voided; its source links were released. */
  'client_invoice.voided': {
    objectType: 'client_invoice',
    clause: '§12 52-09 — a draft client invoice was voided',
  },
  /** A credit note was issued. Metadata: credit-note number, total, whether it credits in full. */
  'client_invoice.credited': {
    objectType: 'client_invoice',
    clause: '§12 52-09 — a credit note was issued against a client invoice',
  },
  /** A manual payment reminder was mailed. Metadata: recipient count. */
  'client_invoice.reminder_sent': {
    objectType: 'client_invoice',
    clause: '§12 52-09 — a payment reminder for a client invoice was sent',
  },
  /**
   * 52-11 (R19-b). An accounting export was downloaded. Metadata: export id, target and the record
   * count per kind — never any exported content.
   */
  'finance.exported': {
    objectType: 'finance_export',
    clause: '§12 52-11 — an accounting export of invoices, payments or expenses was downloaded',
  },
  /** 52-28 (R19-a). A draft's document label changed. Metadata: before/after label. */
  'client_invoice.label_changed': {
    objectType: 'client_invoice',
    clause: '§12 52-28 — the tax-document label of a draft client invoice changed',
  },
  /**
   * 52-28 (R19-a). A tax registration reference was recorded (post-send allowed); the label may
   * have moved to tax invoice. Metadata: before/after label, registered day. The ref is not logged.
   */
  'client_invoice.tax_registered': {
    objectType: 'client_invoice',
    clause: '§12 52-28 — a tax registration reference was recorded on a client invoice',
  },
  /**
   * 56-25 (R18-e). The sign-in policy changed: allowed methods and who must use two-step.
   * Metadata: before/after method lists and scopes, and whether a grace period began. No names.
   */
  'org.sign_in_policy_changed': {
    objectType: 'organization',
    clause: '§12 policy change 56-25 — how members may sign in and who must use two-step',
  },
  /**
   * 56-06 (R19-e). File safety changed: the enabled type presets and whether clients download
   * only scanned-clean files. Metadata: before/after preset names and booleans. No names.
   */
  'org.file_safety_changed': {
    objectType: 'organization',
    clause: '§12 policy change 56-06 — which file types are accepted and what clients may download',
  },
  // ---- R19-d · 53-21 iterations (light sprints) and points ----
  /** An iteration was created. Metadata: project id, dates; never the name or goal. */
  'iteration.created': {
    objectType: 'iteration',
    clause: '§12 53-21 — an iteration (light sprint) was planned for a project',
  },
  /** An iteration's name, goal or dates changed. Metadata: the changed field names and dates. */
  'iteration.updated': {
    objectType: 'iteration',
    clause: '§12 53-21 — an iteration was edited',
  },
  /** Work items were added to or removed from an iteration. Metadata: counts, never titles. */
  'iteration.items_moved': {
    objectType: 'iteration',
    clause: '§12 53-21 — work items moved into or out of an iteration',
  },
  /** An iteration was completed. Metadata: unfinished items moved, finished items left. */
  'iteration.completed': {
    objectType: 'iteration',
    clause: '§12 53-21 — an iteration was completed and its unfinished work rolled on',
  },
  /** A project's story points were switched on or off. Metadata: before/after. */
  'project.points_setting_changed': {
    objectType: 'project',
    clause: '§12 53-21 — story points were switched on or off for a project',
  },
  // ---- R19-c · 53-07 milestones and phases on the timeline ----
  /** A milestone's committed date moved. Metadata: had_projection; before/after + reason in changes. */
  'milestone.date_changed': {
    objectType: 'project_milestone',
    clause: '§12 53-07 — a milestone’s committed date moved, with the client-safe reason',
  },
  /** A milestone's client copy was published (or refreshed). Metadata: status. */
  'milestone.published': {
    objectType: 'project_milestone',
    clause: '§12 53-07 — a milestone was published to the client timeline',
  },
  /** A milestone's client copy was removed. */
  'milestone.unpublished': {
    objectType: 'project_milestone',
    clause: '§12 53-07 — a milestone was removed from the client timeline',
  },
  /** A phase's dates or colour changed. Metadata: which fields; values in changes. */
  'phase.updated': {
    objectType: 'project_phase',
    clause: '§12 53-07 — a timeline phase’s dates or colour changed',
  },
  // ---- R20-b · 53-08 workload hours ----
  /** A tentative people allocation was confirmed. Metadata: project id; status before/after in changes. */
  'person_allocation.confirmed': {
    objectType: 'person_allocation',
    clause: '§12 53-08 — a tentative allocation was confirmed and now counts toward planned hours',
  },
  // ---- R21-b · 53-08 allocation edit/remove ----
  /** A people allocation's percent, dates, hours or note changed. Values in changes. */
  'person_allocation.updated': {
    objectType: 'person_allocation',
    clause: '§12 53-08 — an allocation’s share, dates, hours or note changed',
  },
  /** A people allocation was removed. The removed row's values as `before` in changes. */
  'person_allocation.deleted': {
    objectType: 'person_allocation',
    clause: '§12 53-08 — an allocation was removed from the project',
  },
  // ---- R21-f · 54-12 inbound e-mail ----
  /** The organization's inbound address was created. Metadata: has_default_project. */
  'inbound_email_address.created': {
    objectType: 'inbound_email_address',
    clause: '§12 54-12 — an inbound request address was created for the organization',
  },
  /** The inbound address was rotated; the old one stops accepting mail. Metadata: old id. */
  'inbound_email_address.rotated': {
    objectType: 'inbound_email_address',
    clause: '§12 54-12 — the inbound request address was rotated',
  },
  /** A held inbound mail was trusted by a person. Metadata: outcome, attachments released. */
  'inbound_email.trusted': {
    objectType: 'inbound_email',
    clause: '§12 54-12a — a held inbound e-mail was trusted by a person',
  },
  // ---- R22-d · 54-12a inbound attachment scan, download, ask-resend ----
  /** The scan pass cleared an inbound attachment; it now lives in the private zone. Metadata: scanner, size. */
  'inbound_email.attachment_clean': {
    objectType: 'inbound_email_attachment',
    clause: '§12 54-12a — an inbound e-mail attachment passed the malware scan',
  },
  /** The scan pass found malware; the bytes were removed. Metadata: scanner, size. Never the detection name. */
  'inbound_email.attachment_blocked': {
    objectType: 'inbound_email_attachment',
    clause: '§12 54-12a — an inbound e-mail attachment was blocked as a threat',
  },
  /** A member downloaded a clean inbound attachment (`file.download`). Metadata: source, size. */
  'inbound_email.attachment_downloaded': {
    objectType: 'inbound_email_attachment',
    clause: '§12 54-12a — a clean inbound e-mail attachment was downloaded (file.download)',
  },
  /** A member asked the sender to re-send blocked attachments. Metadata: attachment count. */
  'inbound_email.ask_resend': {
    objectType: 'inbound_email',
    clause: '§12 54-12a — the sender was asked to re-send attachments in an allowed format',
  },
  // ---- R22-a · 52-12 ZATCA signing certificate ----
  /** The ZATCA certificate was stored or replaced. Metadata: fingerprint, sandbox — never the PEM. */
  'org_secret.certificate_replaced': {
    objectType: 'org_secret',
    clause: '§12 52-12 — the organization’s ZATCA signing certificate was stored or replaced',
  },
  /** The ZATCA certificate was revoked; new documents go out unsigned. Metadata: fingerprint. */
  'org_secret.certificate_revoked': {
    objectType: 'org_secret',
    clause: '§12 52-12 — the organization’s ZATCA signing certificate was revoked',
  },
  /** Signing a sent invoice or credit note failed; it went out `ready`. Metadata: error code. */
  'client_invoice.sign_failed': {
    objectType: 'client_invoice',
    clause: '§12 52-12 — an issued document could not be signed and was left unsigned',
  },
  // ---- R23-e · 54-24 import undo ----
  /** A committed import was undone inside its 7-day window. Metadata: job id, source kind, count. */
  'import.undo': {
    objectType: 'import_job',
    clause: '§12 54-24 — what one import created was deleted in bulk (counts only)',
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
  'organization.auto_time_tracking_policy_changed': 'Changed automatic time tracking',
  'organization.time_rounding_changed': 'Changed how timer time is rounded',
  'organization.renamed': 'Renamed the organization',
  'organization.logo_changed': 'Changed the organization logo',
  'project.created': 'Created a project',
  'work_item.created': 'Created a work item',
  'work_item.transitioned': 'Moved a work item to a new stage',
  'work_item.audience_changed': 'Changed who can see a work item',
  'work_item.deleted': 'Deleted a work item',
  'organization.client_file_policy_changed': 'Changed which files clients can receive',
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
  'file_preview.viewed': 'Viewed a file preview',
  'review.thread_created': 'Commented on a file',
  'review.comment_added': 'Replied on a file comment',
  'review.thread_resolved': 'Resolved or reopened a file comment',
  'review.decision_recorded': 'Approved a file or asked for changes',
  'figma.connection_changed': 'Connected or disconnected Figma',
  'figma.link_attached': 'Attached a Figma file',
  'figma.link_removed': 'Removed a Figma file',
  'figma.snapshot_taken': 'Saved a Figma frame snapshot',
  'figma.link_refreshed': 'Refreshed a Figma file',
  'file_asset.scan_disputed': "A file's scan result changed",
  'file_asset.purged': 'Deleted stored file data',
  'upload_session.expired': 'Cleaned up an expired upload',
  'usage_counter.drift_corrected': 'Corrected a storage counter',
  'usage.threshold_reached': 'Storage reached its limit',
  'storage_connection.connected': 'Connected Google Drive',
  'storage_connection.settings_changed': 'Changed where files are stored',
  'storage_connection.disconnected': 'Disconnected Google Drive',
  'storage_connection.handover_requested': 'Asked an admin to take over company storage',
  'storage_connection.handover': 'Took over the company storage connection',
  'storage_migration.started': 'Started moving files to company storage',
  'storage_migration.finished': 'Finished moving files to company storage',
  'mail_bounce.cleared': 'Cleared a bounced email address',
  'drive_attachment.attached': 'Attached a Google Drive file',
  'drive_attachment.removed': 'Removed a Google Drive file',
  'onedrive_attachment.attached': 'Attached a OneDrive file',
  'onedrive_attachment.removed': 'Removed a OneDrive file',
  'work_item.drive_file_imported': 'Added a file from cloud storage to a work item',
  'deliverable.drive_version_imported': 'Added a file from cloud storage for a deliverable',
  'work_item.cloud_folder_attached': 'Attached a cloud storage folder to a work item',
  'work_item.cloud_folder_removed': 'Removed a cloud storage folder from a work item',
  'calendar_connection.connected': 'Connected a calendar',
  'calendar_connection.disconnected': 'Disconnected a calendar',
  'calendar_connection.mirror_changed': 'Changed due dates in a calendar',
  'calendar_feed.issued': 'Created a calendar feed address',
  'calendar_feed.revoked': 'Turned off a calendar feed address',
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
  'deliverable.shared_with_client': 'Shared a deliverable with the client',
  'deliverable.deleted': 'Deleted a deliverable',
  'deliverable.restored': 'Restored a deleted deliverable',
  'deliverable.sent_for_approval': 'Sent a deliverable for client approval',
  'approval.approved': 'Approved a deliverable',
  'approval.changes_requested': 'Requested changes on a deliverable',
  'approval.invalidated': 'Cancelled an approval after a new version',
  'approval.evidence_exported': 'Downloaded the evidence of an approval',
  'approval.email_resent': 'Sent the approval e-mail again',
  'member.password_reset_sent': 'Sent a member a password reset',
  'member.profile_updated': 'Updated their own profile',
  'document.renamed': 'Renamed a document',
  'document.archived': 'Archived a document',
  'document.unarchived': 'Brought back an archived document',
  'workflow_condition.deleted': 'Removed a condition from an automation rule',
  'privacy_export.requested': 'Asked for a data export',
  'privacy_export.ready': 'A data export was ready to download',
  'privacy_export.failed': 'A data export could not be made',
  'privacy_export.downloaded': 'Downloaded a data export',
  'privacy_deletion.requested': 'Asked for a deletion',
  'privacy_deletion.cancelled': 'Cancelled a deletion request',
  'privacy_deletion.executed': 'A requested deletion was carried out',
  'audit.exported': 'Exported the audit log',
  'audit.purged': 'Old audit entries were removed by the retention setting',
  'usage.exported': 'Exported the usage figures',
  'project.exported': 'Exported a project',
  'member_admin_note.created': 'Added a private note about a member',
  'member_admin_note.deleted': 'Deleted a private note about a member',
  'organization.security_settings_changed': 'Changed how people sign in',
  'organization.access_policy_changed': 'Changed the access policy',
  'ip_allowlist.entry_added': 'Added a trusted network range',
  'ip_allowlist.entry_removed': 'Removed a trusted network range',
  'billing_tax_details.updated': 'Changed the billing tax details',
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
  // ---- platform-admin v2 · PA-04 ----
  'custom_role.deleted': 'Deleted a custom role',
  // ---- platform-admin v2 · PA-05 ----
  'support.session_started': 'TManage support entered the workspace',
  'support.session_ended': 'TManage support left the workspace',
  // ---- platform-admin v2 · PA-08 ----
  'message.edited': 'Edited a message',
  'work_item.updated': 'Changed a work item',
  'decision.updated': 'Changed a decision',
  'meeting.updated': 'Changed a meeting',
  'direct_message.deleted': 'Deleted a direct message',
  'comment.deleted': 'Deleted a comment',
  'document.deleted': 'Deleted a document',
  'decision.deleted': 'Deleted a decision',
  'meeting.deleted': 'Deleted a meeting',
  'file_asset.deleted': 'Deleted a file',
  'attachment.deleted': 'Removed an attachment',
  'request_message.deleted': 'Deleted a request message',
  'public_link.created': 'Created a public link',
  'public_link.opened': 'A public link was opened',
  'public_link.decided': 'A decision was made through a public link',
  'public_link.revoked': 'Revoked a public link',
  'public_link.expiry_changed': 'Changed when a public link expires',
  'quote.created': 'Created a quote',
  'quote.updated': 'Edited a draft quote',
  'quote.sent': 'Sent a quote',
  'quote.accepted': 'A quote was accepted',
  'quote.declined': 'A quote was declined',
  'quote.converted': 'Turned a quote into a project',
  'finance_profile.updated': 'Changed the finance settings',
  'tax_rate.created': 'Added a tax rate',
  'tax_rate.updated': 'Changed a tax rate',
  'tax_rate.archived': 'Archived a tax rate',
  'exchange_rate.created': 'Recorded an exchange rate',
  'time_timer.started': 'Started a timer',
  'time_timer.auto_stopped': 'A forgotten timer was stopped',
  'time_timer.discarded': 'Discarded a timer without saving time',
  'time_log.created': 'Logged time',
  'working_calendar.updated': 'Changed the working calendar',
  'working_calendar.holidays_imported': 'Imported a holiday list',
  'work_signal_settings.updated': 'Changed the alert rules',
  'webhook.secret_rotated': 'Rotated a webhook signing secret',
  'webhook.paused': 'Paused a webhook',
  'webhook.resumed': 'Resumed a webhook',
  'webhook.replayed': 'Replayed events to a webhook',
  'personal_access_token.created': 'Created an API token',
  'personal_access_token.revoked': 'Revoked an API token',
  'oauth_grant.revoked': 'Disconnected an AI app',
  'time_period.locked': 'Locked a time period',
  'time_period.unlocked': 'Reopened a locked time period',
  'time_period.unlock_requested': 'Asked to reopen a locked time period',
  'rate_card.created': 'Created a rate card',
  'rate_card.updated': 'Changed a rate card',
  'rate_card.entry_added': 'Added a rate',
  'rate_card.entry_removed': 'Removed a rate',
  'cost_rate.changed': "Changed a person's cost rate",
  'rates.repriced': 'Re-priced unbilled time',
  'work_item.billable_changed': 'Changed whether a work item is billable',
  'channel_link.created': 'Linked a chat channel (retired feature)',
  'channel_link.removed': 'Removed a chat channel link (retired feature)',
  'channel_link.paused': 'Paused a chat channel link (retired feature)',
  'channel_link.resumed': 'Resumed a chat channel link (retired feature)',
  'github_hook.created': 'Connected a GitHub repository',
  'github_hook.removed': 'Removed a GitHub repository',
  'github_hook.secret_rotated': 'Rotated a GitHub webhook secret',
  'github_connection.connected': 'Connected GitHub',
  'github_connection.disconnected': 'Disconnected GitHub',
  'project.work_key_prefix_set': 'Set a project work-key prefix',
  'work_item.code_link_removed': 'Removed a code link from a work item',
  'timesheet.entries_edited': 'Edited time on a timesheet',
  'timesheet.submitted': 'Submitted a timesheet',
  'timesheet.approved': 'Approved a timesheet',
  'timesheet.changes_requested': 'Asked for changes to a timesheet',
  'timesheet.exported': 'Exported a timesheet',
  'expense.created': 'Recorded an expense',
  'expense.updated': 'Changed an expense',
  'expense.submitted': 'Submitted an expense',
  'expense.approved': 'Approved an expense',
  'expense.rejected': 'Rejected an expense',
  'expense.deleted': 'Deleted an expense',
  'expense.exported': 'Exported expenses',
  'budget.updated': 'Changed a project budget',
  'budget.alert_raised': 'A project budget crossed an alert threshold',
  'contacts.imported': 'Imported contacts for invite suggestions',
  'contacts.cleared': 'Cleared their invite suggestions',
  'work_item.dependency_added': 'Added a work item dependency',
  'work_item.dependency_changed': 'Changed a work item dependency',
  'work_item.rescheduled': 'Rescheduled a work item through its dependencies',
  'finance.report_exported': 'Exported a profitability report',
  'finance.facts_rebuilt': 'Rebuilt the finance report figures',
  'baseline.created': 'Saved a schedule baseline',
  'baseline.activated': 'Made a baseline the current one',
  'baseline.deleted': 'Deleted a schedule baseline',
  'retainer.created': 'Created a retainer',
  'retainer.updated': 'Updated a retainer',
  'retainer.paused': 'Paused a retainer',
  'retainer.resumed': 'Resumed a retainer',
  'retainer.ended': 'Ended a retainer',
  'retainer.period_closed': 'Closed a retainer period',
  'schedule.recomputed': "Recomputed the project's critical path",
  'recurrence.updated': 'Changed a repeat rule',
  'recurrence.paused': 'Paused a repeat rule',
  'recurrence.resumed': 'Resumed a repeat rule',
  'recurrence.ended': 'Ended a repeat rule',
  'recurrence.skipped': 'Skipped one occurrence of a repeat rule',
  'recurrence.spawned': 'Created the next task of a repeat rule',
  'client_invoice.created': 'Created a client invoice draft',
  'client_invoice.sent': 'Sent a client invoice',
  'client_invoice.payment_recorded': 'Recorded a payment on a client invoice',
  'client_invoice.voided': 'Voided a client invoice draft',
  'client_invoice.credited': 'Issued a credit note',
  'client_invoice.reminder_sent': 'Sent a payment reminder',
  'finance.exported': 'Downloaded an accounting export',
  'client_invoice.label_changed': 'Changed the document label of an invoice draft',
  'client_invoice.tax_registered': 'Recorded a tax registration reference on an invoice',
  'org.sign_in_policy_changed': 'Changed the sign-in policy',
  'org.file_safety_changed': 'Changed the file safety settings',
  'iteration.created': 'Planned an iteration',
  'iteration.updated': 'Edited an iteration',
  'iteration.items_moved': 'Moved work into or out of an iteration',
  'iteration.completed': 'Completed an iteration',
  'project.points_setting_changed': 'Switched story points on or off for a project',
  'milestone.date_changed': 'Moved a milestone’s committed date',
  'milestone.published': 'Published a milestone to the client timeline',
  'milestone.unpublished': 'Removed a milestone from the client timeline',
  'phase.updated': 'Changed a timeline phase’s dates',
  'person_allocation.confirmed': 'Confirmed a tentative allocation',
  'person_allocation.updated': 'Changed an allocation',
  'person_allocation.deleted': 'Removed an allocation',
  'inbound_email_address.created': 'Created the inbound request address',
  'inbound_email_address.rotated': 'Rotated the inbound request address',
  'inbound_email.trusted': 'Trusted a held inbound e-mail',
  'inbound_email.attachment_clean': 'An inbound e-mail attachment passed the virus scan',
  'inbound_email.attachment_blocked': 'Blocked an inbound e-mail attachment as a threat',
  'inbound_email.attachment_downloaded': 'Downloaded an inbound e-mail attachment',
  'inbound_email.ask_resend': 'Asked an e-mail sender to re-send attachments',
  'org_secret.certificate_replaced': 'Stored the ZATCA signing certificate',
  'org_secret.certificate_revoked': 'Revoked the ZATCA signing certificate',
  'client_invoice.sign_failed': 'Could not sign an issued invoice',
  'import.undo': 'Undid an import',
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
