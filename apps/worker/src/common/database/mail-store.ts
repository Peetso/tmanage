import type { WorkerTransaction } from './worker-database.js';

/**
 * The one statement the client-request mail consumers need.
 *
 * ## Why it is one statement and not four
 *
 * The recipient, the organization, the project and the request are four rows, and a mail
 * consumer needs every one of them or none: with no address there is nothing to send, and
 * with no project name there is no sentence. Reading them together keeps the consumer's
 * database time inside the batch transaction to a single round trip, which matters because
 * every millisecond spent here is a millisecond the claim's row locks are held.
 *
 * ## Everything here is already the client's own, or already published to them
 *
 * `24-EVENT-CATALOG` §6 and `35-NOTIFICATION-AND-EMAIL-COPY` §1 between them forbid an email
 * carrying confidential content, and an email — unlike a notification row — has no display
 * time at which access can be re-checked. Whatever it says is delivered permanently. So this
 * statement returns only facts the recipient is already entitled to, and the entitlement is
 * true by construction rather than by a check:
 *
 * - `title` and `desiredAt` are what the client typed into the request form themselves.
 * - `projectName` names a project shared with their client organization — the read the
 *   portal already performs, and the caller checks that share is *still* live before this
 *   row is used.
 * - `clientSafeScopeSummary` is the field REQ-002 exists to publish to the client, named
 *   client-safe on the column.
 * - `hasClarificationQuestion` is a boolean, never the question's prose. The prose is on the
 *   row and the portal shows it; the email says only that one is waiting.
 * - `organizationName` and `organizationSlug` are the tenant the client already signs in to.
 *
 * The internal columns of `client_requests` — `urgency_reason`, `description`,
 * `client_visible_reason` — are deliberately absent. Two of them are the client's own words
 * and would be safe; leaving them out keeps the projection's rule ("what the templates need,
 * and nothing a future template might reach for") legible.
 */
export interface ClientRequestMailFacts {
  readonly recipientEmail: string;
  readonly recipientName: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly projectName: string;
  readonly title: string;
  /** `'YYYY-MM-DD'` or null — a `DATE` column since 0012, read as a string by the driver. */
  readonly desiredAt: string | null;
  /** `'YYYY-MM-DD'` or null. Null with `commitment = 'unscheduled'` is a legal acceptance. */
  readonly committedAt: string | null;
  readonly commitment: string | null;
  /** Whether a question is waiting — never the question itself. */
  readonly hasClarificationQuestion: boolean;
  readonly clientSafeScopeSummary: string | null;
}

/**
 * A `DATE` column as the `'YYYY-MM-DD'` string this module promises to return.
 *
 * The pool is configured with `dateStrings: ['DATE']`, which makes this a pass-through today.
 * It is here anyway because the promise belongs to this module: a driver option changed three
 * files away would otherwise turn a calendar date into a local timestamp inside an email, with
 * nothing between the change and the recipient. `toISOString().slice(0, 10)` is the right
 * narrowing for the fallback — mysql2 inflates a DATE at UTC midnight when `timezone: 'Z'`,
 * so the UTC calendar day is the stored one.
 */
function asCalendarDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return null;
}

/**
 * The facts for one request and its submitter, or `null` when any of the four rows is gone.
 *
 * `INNER JOIN` throughout on purpose: a request whose project, organization or submitter has
 * vanished between the event and its delivery has nothing safe to say about itself, and the
 * consumer's answer to `null` is silence.
 */
export async function findClientRequestMailFacts(
  tx: WorkerTransaction,
  organizationId: string,
  requestId: string,
): Promise<ClientRequestMailFacts | null> {
  interface Row {
    readonly recipient_email: string;
    readonly recipient_name: string;
    readonly organization_name: string;
    readonly organization_slug: string;
    readonly project_name: string;
    readonly title: string;
    // Typed loosely on purpose: `asCalendarDate` is what turns either driver shape into the
    // string this module's interface promises.
    readonly desired_at: unknown;
    readonly committed_at: unknown;
    readonly commitment: string | null;
    readonly has_clarification_question: number;
    readonly client_safe_scope_summary: string | null;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT u.email                                AS recipient_email,
            u.display_name                         AS recipient_name,
            o.name                                 AS organization_name,
            o.slug                                 AS organization_slug,
            p.name                                 AS project_name,
            r.title,
            r.desired_at,
            r.committed_at,
            r.commitment,
            (r.clarification_question IS NOT NULL) AS has_clarification_question,
            r.client_safe_scope_summary
       FROM client_requests r
       JOIN users u          ON u.id = r.submitted_by_user_id
       JOIN organizations o  ON o.id = r.organization_id
       JOIN projects p       ON p.id = r.project_id
                            AND p.organization_id = r.organization_id
      WHERE r.organization_id = ? AND r.id = ?`,
    [organizationId, requestId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    recipientEmail: row.recipient_email,
    recipientName: row.recipient_name,
    organizationName: row.organization_name,
    organizationSlug: row.organization_slug,
    projectName: row.project_name,
    title: row.title,
    desiredAt: asCalendarDate(row.desired_at),
    committedAt: asCalendarDate(row.committed_at),
    commitment: row.commitment,
    hasClarificationQuestion: Boolean(row.has_clarification_question),
    clientSafeScopeSummary: row.client_safe_scope_summary,
  };
}
