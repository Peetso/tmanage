/**
 * Public-claims registry — 57-05 (honesty fix) and 56-24 (the flip-back rule).
 *
 * Every security or capability word the website, the plan copy or the trust page could use is
 * listed here with the proof that would make it true. A claim is published only while its proof
 * holds: `status: 'shipped'` needs proof ids, a `verifiedAt` date no older than
 * {@link PROOF_MAX_AGE_DAYS} and the test-run reference, all set in the same commit (56-24). A
 * shipped claim whose proof fails, or whose proof is stale, flips back to `hidden` — the words
 * disappear until the proof is green again.
 *
 * `public-claims.test.ts` scans the catalogs and the public copy and fails CI when a phrase of a
 * claim that is not publishable appears outside the keys allowlisted as "planned"/"not available".
 */

export type ClaimLocale = 'en' | 'ar';

/** `shipped` = may be said; `planned` = only the allowlisted "planned" phrasing; `hidden` = never. */
export type ClaimStatus = 'shipped' | 'planned' | 'hidden';

export interface PublicClaim {
  readonly id: string;
  /** The catalog key that carries the claim once it ships (54-14, 56-22… add it back with it). */
  readonly textKey: string;
  /** Test ids that prove the claim on live (56 §56-24, 56 §11.5, 57 §20.2). */
  readonly proofIds: readonly string[];
  readonly status: ClaimStatus;
  /** The plan item that flips `status` when its acceptance test passes on live. */
  readonly owner: string;
  /** Restricted phrases per locale. */
  readonly phrases: Readonly<Record<ClaimLocale, readonly RegExp[]>>;
  /** Keys allowed to name the feature while it is not shipped, because they say it is not yet. */
  readonly plannedKeys: readonly string[];
  /** ISO date (YYYY-MM-DD) the proof last passed on live. Required when shipped. */
  readonly verifiedAt?: string;
  /** The test-run reference of that pass. Required when shipped. */
  readonly proofRunRef?: string;
}

/** A shipped claim's proof must have passed within this many days, or the claim flips back. */
export const PROOF_MAX_AGE_DAYS = 90;

/** What a proof run reported, by proof id. A proof id that is absent was not run. */
export type ProofOutcomes = Readonly<Record<string, 'pass' | 'fail'>>;

const DAY_MS = 86_400_000;

const SSO_PLANNED_KEYS = ['PricingPage.faqSsoQuestion', 'PricingPage.faqSsoAnswer'] as const;

export const PUBLIC_CLAIMS: readonly PublicClaim[] = Object.freeze([
  {
    id: 'sso',
    textKey: 'SignInScreen.continueSso',
    proofIds: [
      'SEC56-13',
      'SEC56-14',
      'SEC56-15',
      'SEC56-16',
      'SEC56-17',
      'SEC56-18',
      'apps/api/src/modules/sso/sso.test.ts',
    ],
    // Built in 1051eb72 (OpenID Connect company sign-in, owner settings, enforcement).
    status: 'shipped',
    verifiedAt: '2026-11-08',
    proofRunRef: 'R46 integrator unit run: apps/api/src/modules/sso/sso.test.ts (1051eb72)',
    owner: '54-14',
    phrases: {
      en: [/\bSSO\b/u, /single sign-on/iu],
      ar: [/\bSSO\b/u, /الدخول الموح[ّ]?د/u],
    },
    plannedKeys: SSO_PLANNED_KEYS,
  },
  {
    id: 'saml',
    textKey: 'PricingPage.compareRowSaml',
    proofIds: ['SEC56-21', 'SEC56-22', 'apps/api/src/modules/sso/sso-saml.test.ts'],
    // Built in 93844ed0 (SAML 2.0 company sign-in alongside OpenID Connect).
    status: 'shipped',
    verifiedAt: '2026-11-08',
    proofRunRef: 'R46 integrator unit run: apps/api/src/modules/sso/sso-saml.test.ts (93844ed0)',
    owner: '54-15',
    phrases: { en: [/\bSAML\b/u], ar: [/\bSAML\b/u] },
    plannedKeys: SSO_PLANNED_KEYS,
  },
  {
    id: 'scim',
    textKey: 'PricingPage.compareRowScim',
    proofIds: ['SEC56-10b'],
    status: 'hidden',
    owner: '54-16',
    phrases: { en: [/\bSCIM\b/u], ar: [/\bSCIM\b/u] },
    plannedKeys: SSO_PLANNED_KEYS,
  },
  {
    id: 'passkeys',
    textKey: 'SignInScreen.continuePasskey',
    proofIds: ['E2E-56-22', 'apps/api/src/modules/identity/passkeys/webauthn.test.ts'],
    // Built in dc6fb413 (passkeys, signed-in devices, new-device mail, security score).
    status: 'shipped',
    verifiedAt: '2026-11-08',
    proofRunRef:
      'R46 integrator unit run: apps/api/src/modules/identity/passkeys/webauthn.test.ts (dc6fb413)',
    owner: '56-22',
    phrases: {
      en: [/passkey/iu, /webauthn/iu],
      ar: [/مفتاح مرور/u, /مفاتيح المرور/u, /webauthn/iu],
    },
    // The sessions screen says "Not available yet" — that honest line stays (57 §7).
    plannedKeys: ['SessionsScreen.passkeysHeading', 'SessionsScreen.passkeysBody'],
  },
  {
    id: 'data_residency',
    textKey: 'PricingPage.compareRowResidency',
    proofIds: ['REL-54-18'],
    status: 'hidden',
    owner: '54-17',
    phrases: {
      en: [/data residency/iu, /choose (?:your|a) (?:data )?region/iu],
      ar: [/موقع (?:تخزين )?البيانات/u, /إقامة البيانات/u],
    },
    plannedKeys: [],
  },
  {
    id: 'virus_scanned',
    textKey: 'SecurityPage.guaranteeFilesBody',
    proofIds: ['SEC56-06', 'E2E-51-08'],
    status: 'hidden',
    owner: '51-08',
    phrases: {
      en: [/malware-scanned/iu, /virus-checked/iu, /virus-scanned/iu],
      ar: [/مفحوصة من البرمجيات الخبيثة/u],
    },
    plannedKeys: [],
  },
  {
    id: 'encrypted_backups',
    textKey: 'SecurityPage.backupsBody',
    proofIds: ['DRILL-56-12'],
    status: 'hidden',
    owner: '56-12',
    phrases: {
      en: [/encrypted backups?/iu, /backups every 6 hours/iu],
      ar: [/نسخ احتياطي(?:ة)? مشفر/u, /نسخ احتياطي كل 6 ساعات/u],
    },
    plannedKeys: [],
  },
  {
    id: 'encryption_at_rest',
    textKey: 'SecurityPage.encryptionBody',
    proofIds: ['SEC56-02'],
    status: 'hidden',
    owner: '56-02',
    phrases: { en: [/encrypt(?:ed|ion) at rest/iu], ar: [/مشفّ?رة أثناء التخزين/u] },
    plannedKeys: [],
  },
  {
    id: 'certifications',
    textKey: 'SecurityPage.certificationsBody',
    proofIds: ['AUDIT-REPORT'],
    status: 'hidden',
    owner: '56-20',
    phrases: {
      en: [/SOC ?2/u, /ISO 27001/u, /\bHIPAA\b/u],
      ar: [/SOC ?2/u, /ISO 27001/u, /\bHIPAA\b/u],
    },
    plannedKeys: [],
  },
  {
    id: 'uptime_guarantee',
    textKey: 'PricingPage.slaBody',
    proofIds: ['REL-SLA'],
    status: 'hidden',
    owner: '56-15',
    phrases: { en: [/uptime guarantee/iu, /guaranteed uptime/iu], ar: [/ضمان وقت التشغيل/u] },
    plannedKeys: [],
  },
  {
    id: 'e_signature',
    textKey: 'PricingPage.eSignatureFeature',
    proofIds: ['E2E-52-23'],
    status: 'hidden',
    owner: '52-26',
    phrases: { en: [/\be-signature/iu, /electronic signature/iu], ar: [/توقيع إلكتروني/u] },
    plannedKeys: [],
  },
  {
    id: 'custom_portal_domain',
    textKey: 'PricingPage.customDomainFeature',
    proofIds: ['E2E-54-66', 'SEC-54-63', 'SEC-54-64', 'SEC-54-65'],
    status: 'hidden',
    owner: '54-30',
    phrases: { en: [/custom portal domain/iu], ar: [/نطاق مخصص لبوابة العملاء/u] },
    plannedKeys: [],
  },
  {
    id: 'pay_invoices_online',
    textKey: 'PricingPage.payOnlineFeature',
    proofIds: ['E2E-52-22', 'SEC-52-20', 'SEC-52-21'],
    status: 'hidden',
    owner: '52-25',
    phrases: { en: [/pay invoices online/iu], ar: [/دفع الفواتير إلكترونياً/u] },
    plannedKeys: [],
  },
  {
    id: 'sign_in_with_apple',
    textKey: 'SignInScreen.continueApple',
    proofIds: ['E2E-53-51'],
    status: 'hidden',
    owner: '53-22',
    phrases: { en: [/sign in with apple/iu], ar: [/تسجيل الدخول عبر Apple/u] },
    plannedKeys: [],
  },
  {
    id: 'tax_invoice_wording',
    textKey: 'InvoiceDocument.taxInvoiceTitle',
    proofIds: [
      'SEC-52-21',
      'packages/domain/src/finance/tax-document-rules.test.ts',
      'apps/api/src/modules/finance/client-invoices.test.ts',
    ],
    // Built (52-28): a tax_invoice label passes only the country rule (VAT registered + reference).
    status: 'shipped',
    verifiedAt: '2026-11-08',
    proofRunRef:
      'R46 integrator unit run: packages/domain/src/finance/tax-document-rules.test.ts, apps/api/src/modules/finance/client-invoices.test.ts',
    owner: '52-28',
    phrases: {
      en: [/tax invoice/iu, /VAT invoice/iu],
      ar: [/فاتورة ضريبية/u],
    },
    plannedKeys: [],
  },
  {
    id: 'pdpl_scc_attached',
    textKey: 'TrustPage.transfersBody',
    proofIds: ['DPA-ANNEX-4'],
    status: 'hidden',
    owner: '56-33',
    phrases: {
      en: [/SDAIA standard contractual clauses/iu, /PDPL-compliant transfers/iu],
      ar: [/الشروط التعاقدية القياسية/u],
    },
    plannedKeys: [],
  },
  {
    id: 'auth_mail_priority',
    textKey: 'SecurityPage.authMailBody',
    proofIds: ['INT-56-31'],
    status: 'hidden',
    owner: '56-31',
    phrases: { en: [/sign-in codes are never delayed/iu], ar: [/رموز الدخول لا تتأخر/u] },
    plannedKeys: [],
  },
] satisfies readonly PublicClaim[]);

/**
 * Catalog keys whose claim was removed from rendering by 57-05. No component may reference them
 * until the owning slice ships the feature and adds them back together with the proof.
 */
export const REMOVED_CLAIM_KEYS: readonly string[] = Object.freeze([
  'SignInScreen.continueSso',
  'SignInScreen.continuePasskey',
  'MfaChallengeScreen.passkeyName',
  'PricingPage.planEnterpriseFeature2',
  'PricingPage.planEnterpriseFeature3',
  'PricingPage.compareRowSso',
  'PricingPage.compareRowResidency',
  'PricingPage.flatEnterpriseFeature2',
  'SubscriptionScreen.plans.enterpriseFeature2',
]);

/** Why a claim may not be shown as shipped (empty when its proof record is complete and fresh). */
export function proofProblems(claim: PublicClaim, now: Date): string[] {
  if (claim.status !== 'shipped') return [];
  const problems: string[] = [];
  if (claim.proofIds.length === 0) problems.push('no proof ids');
  if (!claim.proofRunRef) problems.push('no proof run reference');
  if (!claim.verifiedAt) {
    problems.push('no verifiedAt date');
  } else {
    const verified = Date.parse(`${claim.verifiedAt}T00:00:00Z`);
    if (Number.isNaN(verified)) problems.push('verifiedAt is not a date');
    else if (verified > now.getTime()) problems.push('verifiedAt is in the future');
    else if ((now.getTime() - verified) / DAY_MS > PROOF_MAX_AGE_DAYS) {
      problems.push(`proof older than ${PROOF_MAX_AGE_DAYS} days`);
    }
  }
  return problems;
}

/**
 * The flip-back rule (56-24): the status a claim actually has. A shipped claim with an incomplete
 * or stale proof record, or with any proof that failed in `outcomes`, is `hidden`.
 */
export function effectiveClaimStatus(
  claim: PublicClaim,
  now: Date,
  outcomes: ProofOutcomes = {},
): ClaimStatus {
  if (claim.status !== 'shipped') return claim.status;
  if (proofProblems(claim, now).length > 0) return 'hidden';
  if (claim.proofIds.some((id) => outcomes[id] === 'fail')) return 'hidden';
  return 'shipped';
}

/** True when the claim's words may appear anywhere on the public site. */
export function isClaimPublishable(
  claim: PublicClaim,
  now: Date,
  outcomes: ProofOutcomes = {},
): boolean {
  return effectiveClaimStatus(claim, now, outcomes) === 'shipped';
}

export interface ClaimViolation {
  readonly claimId: string;
  readonly key: string;
  readonly text: string;
}

/**
 * Restricted phrases of not-publishable claims found in `entries` (catalog key → text), except in
 * the keys a claim allowlists as its "planned" phrasing.
 */
export function findClaimViolations(
  entries: Iterable<readonly [string, string]>,
  locale: ClaimLocale,
  now: Date,
  claims: readonly PublicClaim[] = PUBLIC_CLAIMS,
  outcomes: ProofOutcomes = {},
): ClaimViolation[] {
  const blocked = claims.filter((claim) => !isClaimPublishable(claim, now, outcomes));
  const violations: ClaimViolation[] = [];
  for (const [key, text] of entries) {
    for (const claim of blocked) {
      if (claim.plannedKeys.includes(key)) continue;
      if (claim.phrases[locale].some((phrase) => phrase.test(text))) {
        violations.push({ claimId: claim.id, key, text });
      }
    }
  }
  return violations;
}

/** Registry-level problems: duplicate ids, and shipped claims without a complete fresh proof. */
export function validateClaimRegistry(claims: readonly PublicClaim[], now: Date): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    if (seen.has(claim.id)) problems.push(`${claim.id}: duplicate id`);
    seen.add(claim.id);
    if (claim.proofIds.length === 0) problems.push(`${claim.id}: no proof ids to flip it on`);
    for (const problem of proofProblems(claim, now)) problems.push(`${claim.id}: ${problem}`);
  }
  return problems;
}
