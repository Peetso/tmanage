import type { Resource } from './resources-data';

/**
 * WEB-15 Resources in Arabic — what the reader leaves with, for each article (Figma `426:13533`).
 *
 * The articles' titles, summaries, reading times and categories are in the i18n catalog
 * (`ResourcesPage.*`); the three takeaways of each article live here, next to their English in
 * `resources-data.ts`, written as Modern Standard Arabic product language rather than a word-for-word
 * translation. Keyed by slug; `resources-ar.test.ts` keeps it complete.
 */
export const ARABIC_POINTS: Readonly<Record<string, readonly [string, string, string]>> = {
  'client-approval-playbook': [
    'شارك نسخة واحدة، لا مجلدًا كاملًا',
    'اطلب قرارًا، لا مجرد ملاحظات',
    'احفظ الإجابة في السجل',
  ],
  'three-dates-three-meanings': [
    'التاريخ المرغوب أمنية العميل',
    'التاريخ الملتزَم به وعد الفريق',
    'التاريخ المتوقَّع تقدير الخطة الصادق',
  ],
  'website-relaunch-template': [
    'مراحل تمتد من الموجز حتى الإطلاق',
    'نقاط مراجعة العميل وموافقاته جاهزة في مكانها',
    'انسخه إلى مشروع بخطوة واحدة',
  ],
  'client-review-in-ten-minutes': [
    'افتح النسخة نفسها، لا مجلدًا',
    'اطرح السؤال الوحيد الذي تحتاج إلى إجابته',
    'سجّل القرار قبل أن تُنهي المكالمة',
  ],
  'requests-your-team-can-commit-to': [
    'صِف شكل العمل حين يكتمل',
    'سمِّ مسؤولًا واحدًا',
    'اتفقوا على تاريخ يستطيع الفريق الوفاء به',
  ],
  'offboarding-a-contractor-safely': [
    'أعِد إسناد عمله المفتوح أولًا',
    'أغلق وصوله بخطوة واحدة',
    'احتفظ بكل تعليق ونسخة في السجل',
  ],
  'no-individual-productivity-scores': [
    'تُقرأ سلامة التسليم من العمل نفسه',
    'لا أحد يُرتَّب أو يُراقَب',
    'لكل مؤشر تفسير واضح',
  ],
  'portal-clients-actually-open': [
    'اعرض ما يحتاجه العميل اليوم',
    'أخفِ الضجيج الداخلي افتراضيًا',
    'اجعل القرار التالي على بُعد نقرة واحدة',
  ],
  'arabic-first-product-language': [
    'التخطيط ينعكس من اليمين إلى اليسار',
    'تسميات تُكتب بالعربية، لا تُترجم حرفيًا',
    'تواريخ تُقرأ بطبيعية في اللغتين',
  ],
  'meeting-notes-to-owned-actions': [
    'جدول أعمال يتّسع في شاشة واحدة',
    'ملاحظات تتحوّل إلى عناصر عمل',
    'كل إجراء يخرج بمسؤول وتاريخ',
  ],
  'retainers-without-the-chaos': [
    'استقبال يحوّل الطلبات العابرة إلى طلبات واضحة',
    'طاقة استيعابية تراها كل شهر',
    'إيقاع مراجعة يستطيع العميل متابعته',
  ],
  'what-a-governed-version-is': [
    'الموافقة تشير إلى نسخة واحدة بعينها',
    'أي تعديل لاحق ينشئ نسخة جديدة',
    'لا أحد يسأل أيّ الملفات هو النهائي',
  ],
};

/** The takeaways of `item` in the reader's language (`ar` → Arabic, anything else → English). */
export function pointsIn(item: Resource, language: string): readonly string[] {
  return language === 'ar' ? (ARABIC_POINTS[item.slug] ?? item.points) : item.points;
}
