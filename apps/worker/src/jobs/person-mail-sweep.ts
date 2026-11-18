import { PLATFORM_SUPPORT_ROLE, capabilitySetFor, isInternalRole } from '@tmanage/domain';
import { MailRecipientSuppressedError, smtpRecipientRefusal } from '@tmanage/mail';
import type { MailDelivery, Mailer, MailLanguage } from '@tmanage/mail';
import {
  PERSON_MAIL_CATALOG,
  newsKind,
  type FeatureNewsNote,
  type PersonMailFacts,
  type PersonMailKind,
} from '../notifications/person-mail-catalog.js';
import { composePersonMail } from '../notifications/person-mail.js';
import type { SweepLock } from '../common/database/sweep-lock.js';

/**
 * EMAILBUILD2 — the hourly person-mail sweep (amendment 2): the one new timer, beside the relay.
 *
 * Each run looks at the next {@link PERSON_MAIL_BATCH} active team members after the stored cursor
 * (round-robin by user id, so every member is looked at about once a day), reads each workspace's
 * "used?" facts once and reuses them for all its members, decides at most one mail per member
 * ({@link decidePersonMail}) and sends it through the notification transport under template key
 * `tip` (the sender resolver signs it with the member's person for that topic).
 *
 * Limits, all here and unit-tested: each tip id once per user ever (`mail_tip_log`, claimed before
 * the send); nothing in a member's first 24 hours; one person mail per 3 days in the workspace's
 * first 14 days, then per 7 days; feature news outside that cap but at most one a day; the
 * after-new-device follow-up outside the cap and the preference, at most once per 30 days; the
 * preference "Tips from the TManage team" (`notification_kind_prefs` kind `tips`) and the platform
 * switch "Tips and reminders" stop everything else; a kind whose condition is no longer true is
 * simply never picked again.
 *
 * MAILREST — a send that fails after the claim is not lost: the row goes to 'retry' and is sent
 * again after {@link PERSON_MAIL_BACKOFF_MS} (1 h, 4 h, 12 h), at most
 * {@link PERSON_MAIL_MAX_ATTEMPTS} attempts in all, then ends 'gave_up'. A failure no retry can fix
 * (the address is suppressed, or the server refused the recipient) gives up at once. Each attempt
 * is its own claim (`reclaim`: only the run that moves the row from 'retry' to 'sending' sends),
 * and a row left at 'sending' is never retried, so a mail is never sent twice. A retry is checked
 * again before it goes (switch, preference, role, the kind still due) and counts as that member's
 * one mail of the run.
 */

export const PERSON_MAIL_BATCH = 100;
export const PERSON_MAIL_INTERVAL_MS = 3_600_000;
/** A feature-news note reaches members for this long after Send; later joiners do not get it. */
export const NEWS_DELIVERY_DAYS = 14;
export const AFTER_NEW_DEVICE_ID = 'security:after_new_device';
const AFTER_NEW_DEVICE_EVERY_DAYS = 30;
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The wait after attempt n (index n - 1); the claim is attempt 1. */
export const PERSON_MAIL_BACKOFF_MS: readonly number[] = [HOUR, 4 * HOUR, 12 * HOUR];
export const PERSON_MAIL_MAX_ATTEMPTS = PERSON_MAIL_BACKOFF_MS.length + 1;
/** Due retries handled per run, before the round-robin batch. */
export const PERSON_MAIL_RETRY_BATCH = 25;

/** One active team member of one live workspace. */
export interface PersonMailCandidate {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly role: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string | null;
  readonly slug: string;
  readonly workspaceName: string;
}

/** Per-member state the decision reads besides the facts. */
export interface PersonMailMemberState {
  /** `mail_tip_log` rows of this member: tip id to sent time. */
  readonly sent: ReadonlyMap<string, Date>;
  /** The preference "Tips from the TManage team" (no row = on). */
  readonly tipsEnabled: boolean;
}

export interface PersonMailStore {
  /**
   * The platform switch "Tips and reminders" (`platform_settings` `mail.tips_enabled`):
   * true only when the row says 'on'; absent = off. Off stops every person mail.
   */
  tipsSwitchOn(): Promise<boolean>;
  readCursor(): Promise<string | null>;
  writeCursor(userId: string | null, at: Date): Promise<void>;
  listCandidates(
    afterUserId: string | null,
    limit: number,
  ): Promise<readonly PersonMailCandidate[]>;
  /** Notes sent by a platform admin within the delivery window, oldest first. */
  publishedNews(now: Date): Promise<readonly FeatureNewsNote[]>;
  /** Workspace facts, read once per workspace per run. */
  workspaceFacts(organizationId: string, now: Date): Promise<WorkspaceFactsPart>;
  /** Member facts and state. */
  memberFacts(candidate: PersonMailCandidate, now: Date): Promise<MemberFactsPart>;
  /** Claim-then-send: true only when this call wrote the log row (status 'sending', attempt 1). */
  claim(candidate: PersonMailCandidate, tipId: string, at: Date): Promise<boolean>;
  /** 'retry' rows due by `now` whose member is still a live candidate, oldest due first. */
  dueRetries(now: Date, limit: number): Promise<readonly PersonMailRetry[]>;
  /** Takes a due row back to 'sending' as attempt `attempts + 1`; true only for the one winner. */
  reclaim(retry: PersonMailRetry, at: Date): Promise<boolean>;
  /** Ends attempt `attempts` of a 'sending' row. */
  settle(
    candidate: PersonMailCandidate,
    tipId: string,
    attempts: number,
    outcome: PersonMailOutcome,
    at: Date,
  ): Promise<void>;
}

/** A tip whose send failed and is due again. */
export interface PersonMailRetry {
  readonly candidate: PersonMailCandidate;
  readonly tipId: string;
  /** Attempts already started (the claim was the first). */
  readonly attempts: number;
}

/** How one attempt ended. `error` is a short, address-free token. */
export type PersonMailOutcome =
  | { readonly status: 'sent' }
  | { readonly status: 'retry'; readonly nextAttemptAt: Date; readonly error: string }
  | { readonly status: 'gave_up'; readonly error: string };

export type WorkspaceFactsPart = Pick<
  PersonMailFacts,
  | 'workspaceCreatedAt'
  | 'activeMembers'
  | 'openTeamInvitations'
  | 'workspaceUsed'
  | 'tenFiles'
  | 'hasSignInPolicy'
  | 'workspaceLastSignInAt'
>;

export type MemberFactsPart = Pick<
  PersonMailFacts,
  | 'joinedAt'
  | 'ownStaleInvitations'
  | 'personalUsed'
  | 'userLastSignInAt'
  | 'newDeviceNoticeAt'
  | 'profileTimezoneSet'
> &
  PersonMailMemberState;

export interface PersonMailDecision {
  readonly kind: PersonMailKind;
  /** The `mail_tip_log` id (the after-new-device follow-up carries the notice day). */
  readonly tipId: string;
}

function audienceAllows(kind: PersonMailKind, role: string): boolean {
  // Clients are never candidates; the hidden Support-session role is never a reader either.
  if (!isInternalRole(role) || role === PLATFORM_SUPPORT_ROLE) return false;
  if (kind.audience === 'owner') return role === 'owner';
  if (kind.audience === 'owner_admin') {
    return role === 'owner' || role === 'org_admin' || role === 'workspace_admin';
  }
  return true;
}

function roleAllows(kind: PersonMailKind, role: string): boolean {
  return kind.capability === null || capabilitySetFor(role).has(kind.capability);
}

function newest(sent: ReadonlyMap<string, Date>, match: (id: string) => boolean): Date | null {
  let best: Date | null = null;
  for (const [id, at] of sent) {
    if (match(id) && (best === null || at.getTime() > best.getTime())) best = at;
  }
  return best;
}

const isNews = (id: string): boolean => id.startsWith('news:');
const isAfterNewDevice = (id: string): boolean => id.startsWith(AFTER_NEW_DEVICE_ID);

/**
 * The one mail (or none) for one member now. Pure: every limit of the header is decided here.
 * `kinds` is the catalog plus this run's news notes.
 */
export function decidePersonMail(input: {
  readonly kinds: readonly PersonMailKind[];
  readonly role: string;
  readonly facts: PersonMailFacts;
  readonly state: PersonMailMemberState;
  readonly switchOn: boolean;
}): PersonMailDecision | null {
  const { facts, state, role } = input;
  // The platform switch off (or never set) stops every kind, the security follow-up included.
  if (!input.switchOn) return null;
  const now = facts.now.getTime();
  // None in a member's first 24 hours, whatever the kind.
  if (now - facts.joinedAt.getTime() < DAY) return null;
  const firstFortnight = now - facts.workspaceCreatedAt.getTime() < 14 * DAY;
  const gap = (firstFortnight ? 3 : 7) * DAY;
  const lastNormal = newest(state.sent, (id) => !isNews(id) && !isAfterNewDevice(id));
  const lastNews = newest(state.sent, isNews);
  const lastDevice = newest(state.sent, isAfterNewDevice);
  const ordered = [...input.kinds]
    .filter((kind) => kind.enabled)
    .sort(
      (a, b) =>
        Number(b.cap === 'outside') - Number(a.cap === 'outside') ||
        a.priority - b.priority ||
        a.id.localeCompare(b.id),
    );
  for (const kind of ordered) {
    if (kind.cap !== 'outside' && !state.tipsEnabled) continue;
    if (!audienceAllows(kind, role) || !roleAllows(kind, role)) continue;
    const tipId =
      kind.id === AFTER_NEW_DEVICE_ID && facts.newDeviceNoticeAt !== null
        ? `${AFTER_NEW_DEVICE_ID}:${facts.newDeviceNoticeAt.toISOString().slice(0, 10)}`
        : kind.id;
    if (state.sent.has(tipId)) continue;
    if (kind.cap === 'normal' && lastNormal !== null && now - lastNormal.getTime() < gap) continue;
    if (kind.cap === 'news' && lastNews !== null && now - lastNews.getTime() < DAY) continue;
    if (
      kind.cap === 'outside' &&
      lastDevice !== null &&
      now - lastDevice.getTime() < AFTER_NEW_DEVICE_EVERY_DAYS * DAY
    ) {
      continue;
    }
    if (!kind.when(facts)) continue;
    return { kind, tipId };
  }
  return null;
}

/** The language a member reads: Arabic readers always get Arabic mail. */
export function memberLanguage(locale: string | null): MailLanguage {
  return locale !== null && /^ar(?:-|$)/iu.test(locale) ? 'ar' : 'en';
}

export interface PersonMailSweepResult {
  readonly looked: number;
  readonly sent: number;
  readonly wrapped: boolean;
}

/** A short, address-free token for `mail_tip_log.last_error` (ASCII, at most 32). */
export function personMailErrorToken(error: unknown): string {
  if (error instanceof MailRecipientSuppressedError) return 'suppressed';
  const smtp = error as { readonly responseCode?: unknown; readonly code?: unknown } | null;
  if (typeof smtp?.responseCode === 'number') return `smtp_${String(smtp.responseCode)}`;
  if (typeof smtp?.code === 'string' && /^[A-Z_]{2,26}$/u.test(smtp.code)) {
    return `smtp_${smtp.code}`;
  }
  const name = error instanceof Error ? error.name.replaceAll(/[^A-Za-z0-9_]/gu, '') : '';
  return (name || 'error').slice(0, 32);
}

/** The outcome of a failed attempt: retry with back-off, or give up when retrying cannot help. */
export function failedAttemptOutcome(
  error: unknown,
  attempts: number,
  now: Date,
): PersonMailOutcome {
  const token = personMailErrorToken(error);
  const final =
    error instanceof MailRecipientSuppressedError || smtpRecipientRefusal(error) !== null;
  const wait = PERSON_MAIL_BACKOFF_MS[attempts - 1];
  if (final || attempts >= PERSON_MAIL_MAX_ATTEMPTS || wait === undefined) {
    return { status: 'gave_up', error: token };
  }
  return { status: 'retry', nextAttemptAt: new Date(now.getTime() + wait), error: token };
}

/** The kind a logged tip id names, among the catalog and this run's news. */
function kindForTip(kinds: readonly PersonMailKind[], tipId: string): PersonMailKind | undefined {
  const id = tipId.startsWith(`${AFTER_NEW_DEVICE_ID}:`) ? AFTER_NEW_DEVICE_ID : tipId;
  return kinds.find((kind) => kind.id === id);
}

/** One run: at most {@link PERSON_MAIL_BATCH} members, one mail each at most. */
export async function sweepPersonMail(deps: {
  readonly store: PersonMailStore;
  readonly mailer: Mailer | null;
  readonly webOrigin: string;
  readonly now: Date;
  readonly batch?: number;
  readonly onSendError?: (error: unknown) => void;
}): Promise<PersonMailSweepResult> {
  const { store, now } = deps;
  const batch = deps.batch ?? PERSON_MAIL_BATCH;
  const cursor = await store.readCursor();
  const candidates = await store.listCandidates(cursor, batch);
  const wrapped = candidates.length < batch;
  // An empty batch still runs: due retries do not wait for candidates.
  if (deps.mailer === null) {
    await store.writeCursor(wrapped ? null : (candidates.at(-1)?.userId ?? null), now);
    return { looked: candidates.length, sent: 0, wrapped };
  }
  const switchOn = await store.tipsSwitchOn();
  const mailer = deps.mailer;
  const kinds = [...PERSON_MAIL_CATALOG, ...(await store.publishedNews(now)).map(newsKind)];
  const workspaces = new Map<string, WorkspaceFactsPart>();
  const workspaceOf = async (organizationId: string): Promise<WorkspaceFactsPart> => {
    let workspace = workspaces.get(organizationId);
    if (workspace === undefined) {
      workspace = await store.workspaceFacts(organizationId, now);
      workspaces.set(organizationId, workspace);
    }
    return workspace;
  };
  const settle = async (
    candidate: PersonMailCandidate,
    tipId: string,
    attempts: number,
    outcome: PersonMailOutcome,
  ): Promise<void> => {
    try {
      await store.settle(candidate, tipId, attempts, outcome, now);
    } catch (error) {
      // The row stays 'sending': never retried, so never sent twice.
      deps.onSendError?.(error);
    }
  };
  /** One attempt of a claimed tip; true when the mail left. */
  const deliver = async (
    candidate: PersonMailCandidate,
    kind: PersonMailKind,
    tipId: string,
    facts: PersonMailFacts,
    attempts: number,
  ): Promise<boolean> => {
    let delivery: MailDelivery;
    try {
      delivery = await mailer.send(
        composePersonMail(kind, {
          to: candidate.email,
          language: memberLanguage(candidate.locale),
          displayName: candidate.displayName,
          workspaceName: candidate.workspaceName,
          slug: candidate.slug,
          webOrigin: deps.webOrigin,
          organizationId: candidate.organizationId,
          userId: candidate.userId,
          count: kind.count?.(facts) ?? 0,
        }),
      );
    } catch (error) {
      deps.onSendError?.(error);
      await settle(candidate, tipId, attempts, failedAttemptOutcome(error, attempts, now));
      return false;
    }
    // 'none': the transport held it (the address unsubscribed); final, nothing to retry.
    await settle(
      candidate,
      tipId,
      attempts,
      delivery === 'sent' ? { status: 'sent' } : { status: 'gave_up', error: 'unsubscribed' },
    );
    return delivery === 'sent';
  };
  let sent = 0;
  // ---- due retries first; each counts as that member's one mail of the run ----
  const retried = new Set<string>();
  if (switchOn) {
    for (const retry of await store.dueRetries(now, PERSON_MAIL_RETRY_BATCH)) {
      const { candidate, tipId } = retry;
      if (!(await store.reclaim(retry, now))) continue;
      const attempts = retry.attempts + 1;
      retried.add(`${candidate.organizationId}:${candidate.userId}`);
      const member = await store.memberFacts(candidate, now);
      const facts: PersonMailFacts = {
        ...(await workspaceOf(candidate.organizationId)),
        ...member,
        now,
      };
      const kind = kindForTip(kinds, tipId);
      const due =
        kind !== undefined &&
        kind.enabled &&
        (kind.cap === 'outside' || member.tipsEnabled) &&
        audienceAllows(kind, candidate.role) &&
        roleAllows(kind, candidate.role) &&
        kind.when(facts);
      if (!due) {
        await settle(candidate, tipId, attempts, { status: 'gave_up', error: 'no_longer_due' });
        continue;
      }
      if (await deliver(candidate, kind, tipId, facts, attempts)) sent += 1;
    }
  }
  for (const candidate of candidates) {
    if (retried.has(`${candidate.organizationId}:${candidate.userId}`)) continue;
    const workspace = await workspaceOf(candidate.organizationId);
    const member = await store.memberFacts(candidate, now);
    const facts: PersonMailFacts = { ...workspace, ...member, now };
    const decision = decidePersonMail({
      kinds,
      role: candidate.role,
      facts,
      state: member,
      switchOn,
    });
    if (decision === null) continue;
    if (!(await store.claim(candidate, decision.tipId, now))) continue;
    if (await deliver(candidate, decision.kind, decision.tipId, facts, 1)) sent += 1;
  }
  await store.writeCursor(wrapped ? null : (candidates.at(-1)?.userId ?? null), now);
  return { looked: candidates.length, sent, wrapped };
}

/**
 * Loop mode: one run every {@link PERSON_MAIL_INTERVAL_MS}; stops on `signal`. With a `lock`
 * (LOGQUIET-a) each run takes the `person-mail` named lock, and a run another process holds is
 * skipped silently.
 */
export async function runPersonMailLoop(
  deps: {
    readonly store: PersonMailStore;
    readonly mailer: Mailer | null;
    readonly webOrigin: string;
    readonly lock?: Pick<SweepLock, 'run'>;
  },
  signal: AbortSignal,
  onError: (error: unknown) => void = (error) =>
    console.error('[worker] person-mail sweep failed', error),
): Promise<void> {
  const { lock, ...sweepDeps } = deps;
  const pass = () => sweepPersonMail({ ...sweepDeps, now: new Date() });
  while (!signal.aborted) {
    try {
      const outcome = lock
        ? await lock.run('person-mail', pass)
        : { ran: true, result: await pass() };
      const result = outcome.ran ? outcome.result : undefined;
      if (result !== undefined && result.sent > 0) {
        console.warn(
          `[worker] person-mail sweep: ${String(result.looked)} member(s), ${String(result.sent)} sent`,
        );
      }
    } catch (error) {
      onError(error);
    }
    // A stop during the run already fired its abort event: do not wait the hour for it.
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PERSON_MAIL_INTERVAL_MS);
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  }
}
