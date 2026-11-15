import { ApiError } from '../../common/http/errors.js';

/**
 * 56-23 — the security signal rules catalog (v1). The worker's detector
 * (`apps/worker/src/jobs/security-detector.ts`) holds the evaluators and the same keys and
 * severities; this file holds what people read (EN/AR labels) and what an admin may set.
 * `platform` rules only ever produce NULL-organization rows (owners never see them).
 */

export type SignalSeverity = 'low' | 'medium' | 'high';
export type SignalRuleScope = 'platform' | 'organization';

export interface SignalRule {
  readonly key: string;
  readonly severity: SignalSeverity;
  readonly scope: SignalRuleScope;
  readonly label: { readonly en: string; readonly ar: string };
  readonly status: 'active' | 'deferred';
  readonly deferredReason?: string;
}

const rule = (
  key: string,
  severity: SignalSeverity,
  scope: SignalRuleScope,
  en: string,
  ar: string,
): SignalRule => ({ key, severity, scope, label: { en, ar }, status: 'active' });

export const SIGNAL_RULES: readonly SignalRule[] = Object.freeze([
  {
    ...rule(
      'credential_stuffing',
      'high',
      'platform',
      'Many failed sign-ins from one source',
      'محاولات دخول فاشلة كثيرة من مصدر واحد',
    ),
    status: 'deferred',
    deferredReason:
      'The worker has no read on the security log by design; this rule needs an API-side or narrow-view detector.',
  },
  rule(
    'public_link_guessing',
    'medium',
    'organization',
    'Repeated wrong codes on public links',
    'رموز خاطئة متكررة على الروابط العامة',
  ),
  rule(
    'rate_limit_saturation',
    'medium',
    'platform',
    'A rate limit is saturated',
    'تجاوز حد معدل الطلبات',
  ),
  rule(
    'invitation_burst',
    'medium',
    'organization',
    'Unusual number of invitations',
    'عدد غير معتاد من الدعوات',
  ),
  rule(
    'permission_churn',
    'high',
    'organization',
    'Rapid permission changes',
    'تغييرات سريعة في الصلاحيات',
  ),
  rule(
    'mass_export',
    'high',
    'organization',
    'Several exports by one person',
    'عمليات تصدير متعددة من شخص واحد',
  ),
  rule(
    'webhook_breaker',
    'low',
    'organization',
    'A webhook keeps failing',
    'فشل متكرر في خطاف ويب',
  ),
  rule(
    'backup_missed',
    'high',
    'platform',
    'No successful backup in the window',
    'لا نسخة احتياطية ناجحة خلال المدة',
  ),
  rule(
    'audit_chain_break',
    'high',
    'organization',
    'Audit log chain check failed',
    'فشل فحص سلسلة سجل التدقيق',
  ),
  rule(
    'support_session_long',
    'medium',
    'organization',
    'Support session open too long',
    'جلسة دعم مفتوحة لمدة طويلة',
  ),
  {
    ...rule(
      'impossible_travel',
      'high',
      'platform',
      'Sign-ins from distant places',
      'تسجيل دخول من أماكن متباعدة',
    ),
    status: 'deferred',
    deferredReason: 'No GeoIP database is bundled; the rule cannot run on this host.',
  },
  // ---- 56-21b platform admin anomalies (worker code defaults; 0285 seeds the rows) ----
  rule(
    'support_sessions_burst',
    'high',
    'platform',
    'Many support sessions by one platform admin in a day',
    'جلسات دعم كثيرة من مسؤول منصة واحد خلال يوم',
  ),
  rule(
    'platform_access_off_hours',
    'medium',
    'platform',
    'Platform access between midnight and 6 a.m.',
    'دخول إلى المنصة بين منتصف الليل والسادسة صباحاً',
  ),
  rule(
    'platform_step_up_failures',
    'high',
    'platform',
    'Repeated failed platform step-ups',
    'فشل متكرر في تأكيد الدخول إلى المنصة',
  ),
  rule(
    'support_session_new_country',
    'high',
    'platform',
    'Support session from a new country',
    'جلسة دعم من بلد جديد',
  ),
  // R23-d (52-12): written by the worker's nightly e-invoice chain reconciler. Its rows dedup by
  // source_hash, so the count is nights-in-a-row and the default threshold 1 is right.
  rule(
    'einvoice_chain_break',
    'high',
    'organization',
    'E-invoice chain break detected',
    'اكتُشف انقطاع في سلسلة الفواتير الإلكترونية',
  ),
  // 52-19: written by the worker's nightly approval record chain walk; deduped like the one above.
  rule(
    'approval_chain_break',
    'high',
    'organization',
    'Approval record chain break detected',
    'اكتُشف انقطاع في سلسلة سجلات الموافقة',
  ),
]);

const BY_KEY = new Map(SIGNAL_RULES.map((entry) => [entry.key, entry]));

export function signalRule(key: string): SignalRule | undefined {
  return BY_KEY.get(key);
}

export const THRESHOLD_LIMITS = Object.freeze({
  count: [1, 100_000],
  windowMinutes: [1, 2_880],
  cooldownMinutes: [0, 10_080],
} as const);

export interface RuleUpdate {
  readonly enabled: boolean;
  readonly count: number;
  readonly windowMinutes: number;
  readonly cooldownMinutes: number | null;
}

function whole(value: unknown, field: keyof typeof THRESHOLD_LIMITS): number {
  const [min, max] = THRESHOLD_LIMITS[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, 'validation_failed', 'The alert rule is not valid.', [
      { field, message: `a whole number, ${String(min)}–${String(max)}` },
    ]);
  }
  return value;
}

/** `{ enabled, threshold: { count, windowMinutes }, cooldownMinutes? }` — nothing else accepted. */
export function parseRuleUpdate(body: Readonly<Record<string, unknown>>): RuleUpdate {
  const extra = Object.keys(body).filter(
    (key) => !['enabled', 'threshold', 'cooldownMinutes'].includes(key),
  );
  const threshold = body['threshold'];
  if (
    extra.length > 0 ||
    typeof body['enabled'] !== 'boolean' ||
    threshold === null ||
    typeof threshold !== 'object' ||
    Array.isArray(threshold) ||
    Object.keys(threshold).some((key) => key !== 'count' && key !== 'windowMinutes')
  ) {
    throw new ApiError(400, 'validation_failed', 'The alert rule is not valid.', [
      {
        field: 'body',
        message: '{ enabled, threshold: { count, windowMinutes }, cooldownMinutes? }',
      },
    ]);
  }
  const values = threshold as Readonly<Record<string, unknown>>;
  return {
    enabled: body['enabled'],
    count: whole(values['count'], 'count'),
    windowMinutes: whole(values['windowMinutes'], 'windowMinutes'),
    cooldownMinutes:
      body['cooldownMinutes'] === undefined
        ? null
        : whole(body['cooldownMinutes'], 'cooldownMinutes'),
  };
}
