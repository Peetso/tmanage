import { PLATFORM_SUPPORT_ROLE, capabilitySetFor, isInternalRole } from '@tmanage/domain';
import type { Mailer, MailLanguage } from '@tmanage/mail';
import {
  PERSON_MAIL_CATALOG,
  newsKind,
  type FeatureNewsNote,
  type PersonMailFacts,
  type PersonMailKind,
} from '../notifications/person-mail-catalog.js';
import { composePersonMail } from '../notifications/person-mail.js';

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
 */

export const PERSON_MAIL_BATCH = 100;
export const PERSON_MAIL_INTERVAL_MS = 3_600_000;
/** A feature-news note reaches members for this long after Send; later joiners do not get it. */
export const NEWS_DELIVERY_DAYS = 14;
export const AFTER_NEW_DEVICE_ID = 'security:after_new_device';
const AFTER_NEW_DEVICE_EVERY_DAYS = 30;
const DAY = 86_400_000;

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
  /** The platform switch "Tips and reminders" (`platform_settings` `mail.tips_enabled`). */
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
  /** Claim-then-send: true only when this call wrote the log row. */
  claim(candidate: PersonMailCandidate, tipId: string, at: Date): Promise<boolean>;
}

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
    if (kind.cap !== 'outside' && (!input.switchOn || !state.tipsEnabled)) continue;
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
  if (deps.mailer === null || candidates.length === 0) {
    await store.writeCursor(wrapped ? null : (candidates.at(-1)?.userId ?? null), now);
    return { looked: candidates.length, sent: 0, wrapped };
  }
  const switchOn = await store.tipsSwitchOn();
  const kinds = [...PERSON_MAIL_CATALOG, ...(await store.publishedNews(now)).map(newsKind)];
  const workspaces = new Map<string, WorkspaceFactsPart>();
  let sent = 0;
  for (const candidate of candidates) {
    let workspace = workspaces.get(candidate.organizationId);
    if (workspace === undefined) {
      workspace = await store.workspaceFacts(candidate.organizationId, now);
      workspaces.set(candidate.organizationId, workspace);
    }
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
    try {
      await deps.mailer.send(
        composePersonMail(decision.kind, {
          to: candidate.email,
          language: memberLanguage(candidate.locale),
          displayName: candidate.displayName,
          workspaceName: candidate.workspaceName,
          slug: candidate.slug,
          webOrigin: deps.webOrigin,
          organizationId: candidate.organizationId,
          userId: candidate.userId,
          count: decision.kind.count?.(facts) ?? 0,
        }),
      );
      sent += 1;
    } catch (error) {
      // Claimed and not sent: a tip is never sent twice, so this one is lost, never repeated.
      // A suppressed address (unsubscribed or bounced) lands here too.
      deps.onSendError?.(error);
    }
  }
  await store.writeCursor(wrapped ? null : (candidates.at(-1)?.userId ?? null), now);
  return { looked: candidates.length, sent, wrapped };
}

/** Loop mode: one run every {@link PERSON_MAIL_INTERVAL_MS}; stops on `signal`. */
export async function runPersonMailLoop(
  deps: {
    readonly store: PersonMailStore;
    readonly mailer: Mailer | null;
    readonly webOrigin: string;
  },
  signal: AbortSignal,
  onError: (error: unknown) => void = (error) =>
    console.error('[worker] person-mail sweep failed', error),
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await sweepPersonMail({ ...deps, now: new Date() });
      if (result.sent > 0) {
        console.warn(
          `[worker] person-mail sweep: ${String(result.looked)} member(s), ${String(result.sent)} sent`,
        );
      }
    } catch (error) {
      onError(error);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PERSON_MAIL_INTERVAL_MS);
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  }
}
