/**
 * 56-23 — `security_alert_digest`: the batched security alert (transactional lane, noreply@).
 *
 * One message lists every signal of one 15-minute batch: rule, severity, count, subject kind and
 * when it was first seen. It carries ids and counts only — never a source hash, an IP, an e-mail
 * or a metadata value — because a forwarded alert must not become the leak it reports. The
 * platform digest (`ALERT_EMAILS`) names the organization id; an owner's digest only ever holds
 * that owner's organization's rows and so names none. Bilingual: English, then Arabic (RTL mark).
 */

export interface SecurityDigestSignal {
  readonly ruleKey: string;
  readonly severity: string;
  readonly organizationId: string | null;
  readonly subjectType: string;
  readonly count: number;
  readonly firstSeen: Date;
}

export interface SecurityDigestInput {
  readonly audience: 'platform' | 'organization';
  readonly signals: readonly SecurityDigestSignal[];
  readonly generatedAt: Date;
}

const LABELS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  credential_stuffing: [
    'Many failed sign-ins from one source',
    'محاولات دخول فاشلة كثيرة من مصدر واحد',
  ],
  public_link_guessing: [
    'Repeated wrong codes on public links',
    'رموز خاطئة متكررة على الروابط العامة',
  ],
  rate_limit_saturation: ['A rate limit is saturated', 'تجاوز حد معدل الطلبات'],
  invitation_burst: ['Unusual number of invitations', 'عدد غير معتاد من الدعوات'],
  permission_churn: ['Rapid permission changes', 'تغييرات سريعة في الصلاحيات'],
  mass_export: ['Several exports by one person', 'عمليات تصدير متعددة من شخص واحد'],
  webhook_breaker: ['A webhook keeps failing', 'فشل متكرر في خطاف ويب'],
  backup_missed: ['No successful backup in 26 hours', 'لا نسخة احتياطية ناجحة منذ 26 ساعة'],
  audit_chain_break: ['Audit log chain check failed', 'فشل فحص سلسلة سجل التدقيق'],
  support_session_long: ['Support session open over 2 hours', 'جلسة دعم مفتوحة أكثر من ساعتين'],
});

const RLM = '‏';
const MAX_LINES = 50;

export function securityDigestLabel(ruleKey: string): readonly [string, string] {
  return LABELS[ruleKey] ?? [ruleKey, ruleKey];
}

export function composeSecurityAlertDigest(input: SecurityDigestInput): {
  readonly subject: string;
  readonly text: string;
} {
  const high = input.signals.filter((signal) => signal.severity === 'high').length;
  const subject =
    `[TManage security] ${String(input.signals.length)} signal(s)` +
    (high > 0 ? `, ${String(high)} high` : '');
  const lines = input.signals.slice(0, MAX_LINES).map((signal) => {
    const [en, ar] = securityDigestLabel(signal.ruleKey);
    const where =
      input.audience === 'platform'
        ? ` · ${signal.organizationId === null ? 'platform' : `org ${signal.organizationId}`}`
        : '';
    return (
      `- [${signal.severity}] ${en} — ${String(signal.count)} (${signal.subjectType})${where}, ` +
      `first seen ${signal.firstSeen.toISOString()}\n  ${RLM}${ar}`
    );
  });
  const more = input.signals.length - lines.length;
  const text = [
    `Security signals at ${input.generatedAt.toISOString()} (UTC).`,
    `${RLM}إشارات أمنية جديدة.`,
    '',
    ...lines,
    ...(more > 0 ? [`… and ${String(more)} more.`] : []),
    '',
    input.audience === 'platform'
      ? 'Details: Platform → Alerts.'
      : 'Details: Admin → Security events.',
  ].join('\n');
  return { subject, text };
}
