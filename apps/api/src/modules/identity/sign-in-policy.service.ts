import {
  SIGN_IN_POLICY_KEYS,
  authorize,
  isSignInMethod,
  isTwoStepTightened,
  parseSignInPolicy,
  twoStepGraceUntil,
  validateSignInPolicyPatch,
} from '@tmanage/domain';
import type { Principal, SignInMethod, SignInPolicy, TwoStepRoleScope } from '@tmanage/domain';
import { anchored, designedPlainMail, mailEyebrow, signOff } from '@tmanage/mail';
import type { Mailer } from '@tmanage/mail';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OrgPolicyValue } from '../../common/database/schema.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import { DEFAULT_POLICY, normalizePolicy } from '../admin/policies.allowlist.js';
import { PoliciesRepository } from '../admin/policies.repository.js';
import { verifyReauthToken } from './reauth-token.js';
import { SignInPolicyRepository } from './sign-in-policy.repository.js';
import type { OwnerRecipient } from './sign-in-policy.repository.js';

/**
 * 56-25 (R18-e) — the organization sign-in policy: read and change it.
 *
 * Capability `org.security.manage` on both routes (the security-admin gate; no capabilities.ts
 * edit). The change is step-up gated (a fresh `POST /v1/auth/reauth` token in `x-reauth-token`,
 * bound to this person and this session), refuses a list that would lock members out (409
 * `members_without_method` with the count, nothing written) and an empty list (400), merges the
 * three keys into the organization's access-policy document (every other key kept), audits
 * `org.sign_in_policy_changed` with no names, and mails every owner on the `auth` lane.
 *
 * Session length is read-only here: `PUT …/policies` owns `session_max_hours` / idle sign-out.
 */

/** What the policy read returns. Not a `…View`: backend-only until the Figma page exists. */
export interface SignInPolicyState {
  readonly allowedMethods: readonly SignInMethod[];
  readonly requireTwoStepRoles: TwoStepRoleScope;
  readonly graceUntil: string | null;
  readonly sessionMaxHours: number;
  readonly idleSignOutMinutes: number;
  /** Active non-owner members with no allowed method other than a password. */
  readonly membersWithoutAlternative: number;
  /** A16: the methods the person asking can sign in with themselves (password, linked providers). */
  readonly ownMethods: readonly SignInMethod[];
}

/**
 * A16 — the owner keeps a way in. The change is refused when no allowed method is one the owner
 * making it actually has (a password, or a linked provider), so the last method they use is never
 * switched off from under them. Pure, so the rule is proved without a database.
 */
export function keepsOwnerAWayIn(
  allowed: readonly SignInMethod[],
  own: readonly SignInMethod[],
): boolean {
  return allowed.some((method) => own.includes(method));
}

/** The linked-identity providers among the allowed methods (everything but `password`). */
function providersOf(methods: readonly SignInMethod[]): SignInMethod[] {
  return methods.filter((method) => method !== 'password');
}

/** Whether a reauth token proves this person, in this session, within the last five minutes. */
export function isStepUpFresh(input: {
  readonly token: string | undefined;
  readonly secret: string | undefined;
  readonly userId: string;
  readonly sessionId: string | undefined;
}): boolean {
  if (input.secret === undefined || input.token === undefined || input.sessionId === undefined) {
    return false;
  }
  const verified = verifyReauthToken(input.token, input.secret);
  return (
    verified.ok &&
    verified.claims.userId === input.userId &&
    verified.claims.sessionId === input.sessionId
  );
}

export class SignInPolicyService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly audit?: Pick<AuditService, 'record'>,
    private readonly mailer: Mailer | null = null,
    private readonly repository: SignInPolicyRepository = new SignInPolicyRepository(),
    private readonly policies: Pick<PoliciesRepository, 'upsert'> = new PoliciesRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(context: TenantContext, principal: Principal): Promise<SignInPolicyState> {
    requireSecurityManage(principal, context);
    return this.database.read(context, async (runner) => {
      const raw = await this.repository.readDocument(runner, context);
      const policy = parseSignInPolicy(raw);
      const without = await this.repository.countMembersWithout(
        runner,
        context,
        providersOf(policy.allowedMethods),
      );
      const own = await this.ownMethods(runner, principal.userId);
      return stateOf(policy, raw, without, own);
    });
  }

  async update(
    context: TenantContext,
    principal: Principal,
    body: unknown,
    stepUpFresh: boolean,
  ): Promise<SignInPolicyState> {
    requireSecurityManage(principal, context);
    // A16: the company owner decides how people sign in; others holding the capability only read.
    if (principal.kind !== 'internal' || principal.role !== 'owner') {
      throw new ApiError(
        403,
        'forbidden',
        'Only the company owner can change this setting.',
        undefined,
        'sign_in_policy.write:not_owner',
      );
    }
    if (!stepUpFresh) {
      throw new ApiError(
        403,
        'reauthentication_required',
        'Confirm your password to change how people sign in.',
        undefined,
        'sign_in_policy.step_up',
      );
    }
    const patch = validateSignInPolicyPatch(body);
    if (!patch.ok) {
      throw new ApiError(400, 'validation_failed', 'That sign-in policy is not allowed.', [
        { field: patch.field, message: patch.message },
      ]);
    }

    const { state, before, after, owners } = await this.database.transaction(
      context,
      async (tx) => {
        const raw = await this.repository.readDocument(tx, context);
        const previous = parseSignInPolicy(raw);
        const providers = providersOf(patch.allowedMethods);

        // No lock-out: dropping `password` is refused while anyone would be left without a way in.
        if (!patch.allowedMethods.includes('password')) {
          const count = await this.repository.countMembersWithout(tx, context, providers);
          if (count > 0) {
            throw new ApiError(
              409,
              'members_without_method',
              'Some members have no other way to sign in yet.',
              [{ field: 'count', message: String(count) }],
              'sign_in_policy.lock_out',
            );
          }
        }

        // A16: never switch off the last method the owner making the change signs in with.
        const own = await this.ownMethods(tx, principal.userId);
        if (!keepsOwnerAWayIn(patch.allowedMethods, own)) {
          throw new ApiError(
            409,
            'conflict',
            'Keep at least one way you sign in yourself.',
            [{ field: 'ownMethods', message: own.join(',') }],
            'sign_in_policy.owner_lock_out',
          );
        }

        const graceUntil = isTwoStepTightened(
          previous.requireTwoStepRoles,
          patch.requireTwoStepRoles,
        )
          ? twoStepGraceUntil(this.now())
          : patch.requireTwoStepRoles === 'nobody'
            ? null
            : previous.graceUntil;
        const next: SignInPolicy = {
          allowedMethods: patch.allowedMethods,
          requireTwoStepRoles: patch.requireTwoStepRoles,
          graceUntil,
        };

        // Merge onto the stored document: every other key (session length, `pat.*`, …) is kept.
        // The raw document, not the normalised one, so keys owned by other slices survive too.
        const kept: Record<string, unknown> = { ...DEFAULT_POLICY, ...documentOf(raw) };
        delete kept[SIGN_IN_POLICY_KEYS.graceUntil];
        const merged = {
          ...kept,
          [SIGN_IN_POLICY_KEYS.allowedMethods]: [...next.allowedMethods],
          [SIGN_IN_POLICY_KEYS.requireTwoStepRoles]: next.requireTwoStepRoles,
          ...(graceUntil === null ? {} : { [SIGN_IN_POLICY_KEYS.graceUntil]: graceUntil }),
        } as unknown as OrgPolicyValue;
        await this.policies.upsert(tx, context, { policy: merged, updatedBy: principal.userId });

        const changed =
          JSON.stringify(previous.allowedMethods) !== JSON.stringify(next.allowedMethods) ||
          previous.requireTwoStepRoles !== next.requireTwoStepRoles;
        if (changed) {
          await this.audit?.record(tx, context, {
            action: 'org.sign_in_policy_changed',
            objectId: context.organizationId,
            result: 'allowed',
            actorUserId: principal.userId,
            metadata: {
              methods_before: [...previous.allowedMethods],
              methods_after: [...next.allowedMethods],
              two_step_before: previous.requireTwoStepRoles,
              two_step_after: next.requireTwoStepRoles,
              grace_until: graceUntil,
            },
          });
        }
        const without = await this.repository.countMembersWithout(tx, context, providers);
        return {
          state: stateOf(next, merged, without, own),
          before: previous,
          after: next,
          owners: changed ? await this.repository.listOwners(tx, context) : [],
        };
      },
    );

    await this.notifyOwners(owners, before, after);
    return state;
  }

  /** The person's own sign-in methods, in canonical order; unknown providers are dropped. */
  private async ownMethods(
    runner: Parameters<SignInPolicyRepository['listOwnMethods']>[0],
    userId: string,
  ): Promise<SignInMethod[]> {
    const raw = await this.repository.listOwnMethods(runner, userId);
    return raw.filter(isSignInMethod);
  }

  /** One `auth`-lane notice per owner, after the commit. A failed send never undoes the change. */
  private async notifyOwners(
    owners: readonly OwnerRecipient[],
    before: SignInPolicy,
    after: SignInPolicy,
  ): Promise<void> {
    if (this.mailer === null) return;
    for (const owner of owners) {
      try {
        await this.mailer.send(composeSignInPolicyNotice(owner, before, after));
      } catch {
        // The audit row is the record; the notice is best effort.
      }
    }
  }
}

/** The stored document as an object (the driver may hand JSON back as text). */
function documentOf(raw: unknown): Record<string, unknown> {
  let doc: unknown = raw;
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof doc === 'object' && doc !== null && !Array.isArray(doc)
    ? (doc as Record<string, unknown>)
    : {};
}

function stateOf(
  policy: SignInPolicy,
  raw: unknown,
  without: number,
  own: readonly SignInMethod[],
): SignInPolicyState {
  const access = raw === undefined || raw === null ? DEFAULT_POLICY : normalizePolicy(raw);
  return {
    allowedMethods: policy.allowedMethods,
    requireTwoStepRoles: policy.requireTwoStepRoles,
    graceUntil: policy.graceUntil,
    sessionMaxHours: access.session_max_hours,
    idleSignOutMinutes: access.idle_signout_minutes,
    membersWithoutAlternative: without,
    ownMethods: own,
  };
}

/** The real org-wide `org.security.manage` decision; a denial is a 403. */
function requireSecurityManage(principal: Principal, context: TenantContext): void {
  const verdict = authorize({
    principal,
    capability: 'org.security.manage',
    resource: {
      organizationId: context.organizationId,
      projectId: null,
      audience: 'internal',
      lifecycle: 'active',
    },
  });
  if (!verdict.allowed) {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      `sign_in_policy:${verdict.code}`,
    );
  }
}

const METHOD_LABEL: Readonly<Record<'en' | 'ar', Readonly<Record<SignInMethod, string>>>> = {
  en: { password: 'Password', google: 'Google', microsoft: 'Microsoft', sso: 'Single sign-on' },
  ar: { password: 'كلمة المرور', google: 'Google', microsoft: 'Microsoft', sso: 'الدخول الموحد' },
};
const SCOPE_LABEL: Readonly<Record<'en' | 'ar', Readonly<Record<TwoStepRoleScope, string>>>> = {
  en: { nobody: 'Nobody', admins: 'Admins', everyone: 'Everyone' },
  ar: { nobody: 'لا أحد', admins: 'المشرفون', everyone: 'الجميع' },
};

/**
 * The owner notice, English or Arabic by the owner's own language. It names the policy, never a
 * person. `credential_change` is an `auth`-lane template key (security@, no deadline).
 */
export function composeSignInPolicyNotice(
  owner: OwnerRecipient,
  before: SignInPolicy,
  after: SignInPolicy,
): {
  to: string;
  subject: string;
  text: string;
  html: string;
  templateKey: string;
  language: 'en' | 'ar';
} {
  const lang: 'en' | 'ar' = (owner.locale ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
  const methods = (policy: SignInPolicy) =>
    policy.allowedMethods.map((method) => METHOD_LABEL[lang][method]).join(', ');
  const scope = (policy: SignInPolicy) => SCOPE_LABEL[lang][policy.requireTwoStepRoles];
  // EMAIL-COPY S6, signed [SEC]. The owner row carries no name and the change no actor or
  // workspace name, so the copy's "{actorName} changed the sign-in rules of {workspaceName}"
  // reads "The sign-in rules of your workspace were changed".
  const lines =
    lang === 'ar'
      ? [
          'تغيّرت قواعد تسجيل الدخول في مساحة عملك.',
          `قبل التغيير: ${methods(before)}؛ التحقق بخطوتين مطلوب من: ${scope(before)}`,
          `الآن: ${methods(after)}؛ التحقق بخطوتين مطلوب من: ${scope(after)}`,
          'إن لم تتوقع ذلك، راجعه من الإعدادات > الأمان، أو راسلنا على support@tmanageapp.com.',
        ]
      : [
          'The sign-in rules of your workspace were changed.',
          `Before: ${methods(before)}; two-step sign-in required for: ${scope(before)}`,
          `Now: ${methods(after)}; two-step sign-in required for: ${scope(after)}`,
          'If you did not expect this, review it in Settings > Security, or write to support@tmanageapp.com.',
        ];
  const subject = anchored(
    lang,
    lang === 'ar'
      ? 'تغيّرت قواعد تسجيل الدخول في مساحة عملك'
      : 'The sign-in rules of your workspace changed',
  );
  return {
    to: owner.email,
    language: lang,
    subject,
    ...designedPlainMail(lang, {
      subject,
      eyebrow: mailEyebrow('security', lang),
      lines,
      signature: signOff('security', lang),
    }),
    templateKey: 'credential_change',
  };
}
