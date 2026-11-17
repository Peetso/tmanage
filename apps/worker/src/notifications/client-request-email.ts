import { workspaceReplyLine, workspaceSignOff } from '@tmanage/mail';
import type { MailMessage } from '@tmanage/mail';
import type { ClientRequestMailFacts } from '../common/database/mail-store.js';

/**
 * The three client-request templates from `35-NOTIFICATION-AND-EMAIL-COPY` §3, rendered.
 *
 * ## Only the client, only about their own request
 *
 * §3 names twelve templates. This file renders five: *Client request received*,
 * *Clarification required*, *Request accepted*, *Request declined* and *Request deferred*. All
 * five are addressed to the person who submitted the request, about the request they submitted,
 * and every fact in them is either that person's own words or something the product already
 * publishes to them by contract. REQ-03 added the last two: a decline or a deferral is an
 * outcome the client is owed, and the manager's `client_visible_reason` — written to be read by
 * exactly this person — is the fact each carries.
 *
 * The reason the internal fan-out is not here is §1's own sentence: "Every email includes …
 * preference/support route", and separately "use project/deliverable title only when tenant
 * policy permits". There is no preferences table in `contracts/tmanage-core.dbml` and no
 * tenant policy column anywhere, so a general notification email cannot satisfy either
 * clause honestly. These three can, for the same reason TEN-003's invitation could: they are
 * transactional — a direct answer to something the recipient did — which is exactly the
 * category §7 exempts from unsubscribe, and the route for the unexpected case is the studio
 * whose name is on the message.
 *
 * ## Five substitutions §3 asks for that this product cannot make
 *
 * Recorded here and in `docs/implementation-status.md` rather than invented:
 *
 * - **`{{manager}}`** (received). Nothing owns a request at submission — triage is a
 *   capability, not an assignment, and there is no people directory to name anyone from. The
 *   sentence names the studio instead, which is true and is the thing the client dealt with.
 * - **`{{questionCount}}`** (clarification). `client_requests.clarification_question` is one
 *   column holding one question, so "answer(s)" has no count to render. The sentence says
 *   "a question".
 * - **`{{timezone}}`** (accepted). Committed dates have been `DATE` columns since migration
 *   0012 and carry no zone — deliberately, so a reader west of UTC does not see a date a day
 *   early. There is no zone to print, so none is printed.
 * - **`{{committedDate}}` when the acceptance is `unscheduled`** (accepted). §3's body
 *   assumes a committed date. `23-ERD` §6 lets an acceptance commit to *doing* the work
 *   without committing to *when*, and the trigger on `client_requests` enforces that pairing.
 *   The unscheduled body says so instead of printing an empty date.
 * - **`{{scopeSummary}}` when the column is null** (accepted). `client_safe_scope_summary` is
 *   nullable, and §3's "Committed outcome: {{scopeSummary}}." has nothing to render when it
 *   is. The sentence becomes a plain statement that the studio accepted the request — never
 *   the word `null`, which is what an unguarded interpolation would print.
 *
 * ## Two CTAs say what the portal can actually do
 *
 * §3's clarification CTA is "Answer questions". The client portal cannot accept an answer —
 * no client role holds a conversation capability, which is the gap `CHAT-001` did not close
 * — and `ClientRequestDetailScreen` tells a client to reply however they normally reach the
 * studio. An email button promising something the destination does not offer is the phishing
 * shape in reverse, so the CTA reads "View request" and the body carries the same sentence
 * the screen does. When the portal can hold that conversation, this line changes with it.
 *
 * §3's accepted CTA is "View plan", and it becomes "View request" for the narrower version of
 * the same reason: the link goes to the client's own request in the portal, which is the only
 * page a client role can open. There is no client-facing plan view — `CL-01` and `CL-02` show
 * published work items, not a plan — so "View plan" would name a destination that does not
 * exist. The third CTA, "Track request", is §3's own word and is unchanged.
 */

/** Every message is one link into the portal; the producer owns the origin. */
export interface ClientRequestEmailFacts extends ClientRequestMailFacts {
  /** `${WEB_PUBLIC_URL}/${slug}/portal/requests/${requestId}` — built by the producer. */
  readonly link: string;
}

/**
 * Interpolations are flattened to one line before they reach a header or the body, for the
 * reason `invitation-email.ts` gives: a request title is a string a client typed, and a
 * newline in a subject is how one message grows a second recipient. `\s` covers U+2028 and
 * U+2029, which a header parser honours and a reviewer cannot see in a character class.
 */
function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

/** `client_requests.title` is `VARCHAR(300)`; a subject line that long is cut by the reader's mail client. */
const MAX_SUBJECT_TITLE = 120;

/**
 * A title fit for a subject line — REQ-16 and REQ-09.
 *
 * A request title can be three hundred characters, and a mail client that puts the whole of one
 * in a subject cuts it wherever the column runs out, mid-word, with no sign it did. So a long
 * title is shortened here, at a word boundary, and closed with a single ellipsis character
 * (`…`, never two dots — the "plans.." REQ-09 found) so the reader can see it was shortened.
 * A title already short enough is returned flattened and unchanged, which is every real title and
 * every title the template tests assert.
 */
function subjectTitle(value: string): string {
  const flat = oneLine(value);
  if (flat.length <= MAX_SUBJECT_TITLE) return flat;
  const cut = flat.slice(0, MAX_SUBJECT_TITLE);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!?-]+$/u, '');
  return `${trimmed}…`;
}

/**
 * §1's "why recipient" and "preference/support route" in one sentence, and the honest one:
 * the recipient submitted the request, and the route for anything unexpected is the studio
 * they submitted it to. No preference centre is linked because none exists — inventing a URL
 * that 404s would fail §1 more completely than naming the real route does.
 */
function whyAndSupport(organization: string): string {
  // EMAILBUILD (c): then the agency's sign-off [WS] with reply line R3 (replies are not read).
  const signature = workspaceSignOff(
    'en',
    organization,
    workspaceReplyLine('en', 'none', { workspaceName: organization }),
  );
  return [
    `You are receiving this because you submitted this request to ${organization} using ` +
      `this address. If you did not, contact ${organization} directly.`,
    signature.join('\n'),
  ].join('\n\n');
}

/** `Request received: {{requestTitle}}` — §3, on submission. */
export function composeClientRequestReceivedEmail(facts: ClientRequestEmailFacts): MailMessage {
  const organization = oneLine(facts.organizationName);
  const project = oneLine(facts.projectName);
  const title = subjectTitle(facts.title);

  // §3's sentence is written around a requested date. With none given there is no wish to
  // caveat, so the caveat goes rather than becoming a sentence about nothing — and CL-09's
  // rule that the date is a wish is still said, in the one place it can be said. REQ-16: no
  // "yet", which read as a promise the studio had not made.
  const desired =
    facts.desiredAt === null
      ? `You did not ask for a particular date.`
      : `${facts.desiredAt} is a requested date, not a confirmed commitment.`;

  return {
    to: facts.recipientEmail,
    subject: `Request received: ${title}`,
    text: [
      `We received your request for ${project}. ${desired} The ${organization} team will ` +
        `review the scope and confirm what happens next.`,
      `Track request: ${facts.link}`,
      whyAndSupport(organization),
    ].join('\n\n'),
  };
}

/** `Your input is needed for {{requestTitle}}` — §3, on the move to `needs_clarification`. */
export function composeClarificationRequiredEmail(facts: ClientRequestEmailFacts): MailMessage {
  const organization = oneLine(facts.organizationName);
  const title = subjectTitle(facts.title);

  return {
    to: facts.recipientEmail,
    subject: `Your input is needed for ${title}`,
    text: [
      `The ${organization} team needs an answer to a question before it can confirm scope ` +
        `and timing. The question is on your request in the portal.`,
      // See the module doc: the portal shows the question and does not take the answer. REQ-16:
      // no "yet", which promised an in-portal reply the product has not committed to building.
      `You cannot reply inside the portal — send your answer to ${organization} the way ` +
        `you normally reach them.`,
      `View request: ${facts.link}`,
      whyAndSupport(organization),
    ].join('\n\n'),
  };
}

/** `Request accepted: {{requestTitle}}` — §3, on the move to `accepted`. */
export function composeRequestAcceptedEmail(facts: ClientRequestEmailFacts): MailMessage {
  const organization = oneLine(facts.organizationName);
  const title = subjectTitle(facts.title);

  // The summary is REQ-002's client-safe field. It is written to be read by this person, but
  // it is nullable on the column, and an email is not the place to render the word "null".
  const outcome =
    facts.clientSafeScopeSummary === null
      ? `${organization} accepted your request.`
      : `Committed outcome: ${oneLine(facts.clientSafeScopeSummary)}.`;

  // REQ-16: no "yet". An unscheduled acceptance has committed to the work and not to a date,
  // which is a settled state, not a date that is on its way.
  const date =
    facts.committedAt === null
      ? `No date is committed. ${organization} accepted the work without committing to a date.`
      : `Current committed date: ${facts.committedAt}.`;

  return {
    to: facts.recipientEmail,
    subject: `Request accepted: ${title}`,
    text: [`${outcome} ${date}`, `View request: ${facts.link}`, whyAndSupport(organization)].join(
      '\n\n',
    ),
  };
}

/**
 * `Request declined: {{requestTitle}}` — REQ-03, on the move to `declined`.
 *
 * The outcome the client is owed, with the manager's `client_visible_reason` when there is one.
 * The reason is a client-safe field written to be read by this person; it is nullable, so a
 * decline with none recorded says plainly that the request was declined rather than rendering
 * the word "null". The CTA is "View request", the one page a client role can open.
 */
export function composeRequestDeclinedEmail(facts: ClientRequestEmailFacts): MailMessage {
  const organization = oneLine(facts.organizationName);
  const title = subjectTitle(facts.title);

  const outcome =
    facts.clientVisibleReason === null
      ? `${organization} has declined this request.`
      : `${organization} has declined this request. Reason: ${oneLine(facts.clientVisibleReason)}`;

  return {
    to: facts.recipientEmail,
    subject: `Request declined: ${title}`,
    text: [outcome, `View request: ${facts.link}`, whyAndSupport(organization)].join('\n\n'),
  };
}

/**
 * `Request deferred: {{requestTitle}}` — REQ-03, on the move to `deferred`.
 *
 * As the decline, with the deferral's own verb: the request is not refused, it is parked, and
 * the manager's client-safe reason says why when one was written. Same nullable-reason guard,
 * same portal CTA.
 */
export function composeRequestDeferredEmail(facts: ClientRequestEmailFacts): MailMessage {
  const organization = oneLine(facts.organizationName);
  const title = subjectTitle(facts.title);

  const outcome =
    facts.clientVisibleReason === null
      ? `${organization} has deferred this request.`
      : `${organization} has deferred this request. Reason: ${oneLine(facts.clientVisibleReason)}`;

  return {
    to: facts.recipientEmail,
    subject: `Request deferred: ${title}`,
    text: [outcome, `View request: ${facts.link}`, whyAndSupport(organization)].join('\n\n'),
  };
}
