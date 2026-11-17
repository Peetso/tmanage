import type { CapsuleState } from '@tmanage/ui';

import { SUPPORT_EMAIL } from '../../lib/public-contact';

/**
 * The public accessibility statement (`/accessibility`, `/ar/accessibility`), English and Arabic
 * side by side (the security page's repo-content pattern; it reuses that page's layout because no
 * Figma frame of its own exists). Every "Live today" line is checked against the code in
 * `work/pass-2026-11-15e/A11YPAGE-CLAIMS.md`; WCAG 2.2 AA is named as the target only, never as
 * a result, and the gaps are listed as "Planned". `{email}` marks where the feedback address is
 * drawn as a link.
 */

/** Where accessibility feedback goes: the support mailbox, read by a person. */
export const ACCESSIBILITY_FEEDBACK_EMAIL = SUPPORT_EMAIL;

export type AccessibilityLanguage = 'en' | 'ar';
export type A11yStatus = 'live' | 'planned' | 'not_audited';

/** Status shapes: ✓ live, ○ planned, ■ not audited (the security page's StateCapsule states). */
export const A11Y_CAPSULE: Record<A11yStatus, CapsuleState> = {
  live: 'done',
  planned: 'future',
  not_audited: 'neutral',
};

/** The progress table: what works now first, then what is still open. */
export const A11Y_CLAIMS: readonly { id: string; status: A11yStatus }[] = [
  { id: 'keyboard', status: 'live' },
  { id: 'automated', status: 'live' },
  { id: 'contrast', status: 'live' },
  { id: 'motion', status: 'live' },
  { id: 'rtl', status: 'live' },
  { id: 'settings', status: 'planned' },
  { id: 'screenReaders', status: 'planned' },
  { id: 'zoom', status: 'planned' },
  { id: 'wcag', status: 'not_audited' },
];

/** The eight cards; `id` doubles as an anchor on the page. */
export const A11Y_CARDS = [
  'keyboard',
  'focus',
  'screenReaders',
  'contrast',
  'motion',
  'textSize',
  'arabic',
  'feedback',
] as const;
export type A11yCard = (typeof A11Y_CARDS)[number];

export const ACCESSIBILITY_COPY = {
  en: {
    eyebrow: 'Accessibility',
    title: 'TManage should work for everyone',
    lede: 'However you use a computer, with a mouse, a keyboard, a screen reader or a bigger text size, you should be able to get your work done. Here is what works today and what we are still fixing.',
    meta: 'Last reviewed 15 Nov 2026 · Our target is WCAG 2.2 level AA.',
    cards: {
      keyboard: {
        title: 'Works with a keyboard',
        body: 'A "Skip to content" link comes first on every page. Shortcuts stay quiet while you are typing.',
      },
      focus: {
        title: 'You can see where you are',
        body: 'Buttons, links and fields show a clear ring when you reach them with the keyboard. On a phone, the bottom bar does not cover it.',
      },
      screenReaders: {
        title: 'Screen readers',
        body: 'Pages have landmarks, headings and labelled buttons. Important changes, like a sign-in error or a session about to end, are read out.',
      },
      contrast: {
        title: 'Readable colours',
        body: 'Our colour pairs are checked against the WCAG AA contrast ratio, in light and dark themes.',
      },
      motion: {
        title: 'Less motion',
        body: 'If your device asks for reduced motion, TManage turns its animations off.',
      },
      textSize: {
        title: 'Text size and contrast',
        body: 'In your settings you can pick one of four text sizes, turn on higher contrast and turn off motion.',
      },
      arabic: {
        title: 'Arabic, right to left',
        body: 'The website and the app are in English and Arabic. In Arabic the whole layout reads from right to left.',
      },
      feedback: {
        title: 'Something hard to use?',
        body: 'Write to {email}. A person on our team reads every message.',
      },
    } satisfies Record<A11yCard, { title: string; body: string }>,
    todayTitle: 'Where we are today',
    todayNote:
      '"Live today" means it works now. "Planned" means we are working on it. It is not a promise yet.',
    status: { live: 'Live today', planned: 'Planned', not_audited: 'Not audited' },
    claims: {
      keyboard: 'Skip link and a visible focus ring',
      automated: 'Automated accessibility checks on more than 100 screens',
      contrast: 'Colour contrast checked against WCAG AA',
      motion: "Follows your device's reduced-motion setting",
      rtl: 'Arabic with a right-to-left layout',
      settings: 'Your text size and contrast settings on every page as soon as you sign in',
      screenReaders: 'Testing with real screen readers (NVDA, VoiceOver)',
      zoom: 'Checking every page by hand at 200% zoom',
      wcag: 'WCAG 2.2 AA: it is our target, but no one outside our team has audited us yet',
    } as Record<string, string>,
    gapsTitle: 'What we know is not right yet',
    gapsBody:
      'Your text size, contrast and motion settings take effect once you open the accessibility settings page, not straight away on every page. Charts and file previews have not had a full screen-reader check. We have not tested with real screen readers or at 200% zoom by hand. If one of these gets in your way, tell us and we will move it up.',
    helpTitle: 'Using assistive technology?',
    helpBody:
      'Tell us what you use and where you got stuck. We will fix what we can and tell you honestly what we cannot yet.',
    helpAction: 'Ask a question',
    ctaTitle: 'Tell us what is hard to use',
    ctaBody: 'E-mail {email}. Tell us the page and what happened. We read every message.',
    ctaAction: 'E-mail us',
    ctaLink: 'or read how we keep your work safe →',
  },
  ar: {
    eyebrow: 'إمكانية الوصول',
    title: 'TManage لكل الناس',
    lede: 'أياً كانت طريقتك في استخدام الحاسوب، بالفأرة أو لوحة المفاتيح أو قارئ الشاشة أو بخط أكبر، يجب أن تنجز عملك بسهولة. هذا ما يعمل اليوم، وما نعمل على إصلاحه.',
    meta: '‏آخر مراجعة 15 نوفمبر 2026 · هدفنا معيار WCAG 2.2 بمستوى AA.',
    cards: {
      keyboard: {
        title: 'يعمل بلوحة المفاتيح',
        body: 'أول ما في كل صفحة رابط «انتقل إلى المحتوى»، ولا تعمل الاختصارات أثناء الكتابة.',
      },
      focus: {
        title: 'تعرف دائماً أين أنت',
        body: 'تظهر حلقة واضحة حول الأزرار والروابط والحقول عند الوصول إليها بلوحة المفاتيح، ولا يغطيها الشريط السفلي على الهاتف.',
      },
      screenReaders: {
        title: 'قارئات الشاشة',
        body: 'في الصفحات معالم وعناوين وأزرار لها أسماء واضحة، وتُقرأ التغييرات المهمة بصوت عالٍ، مثل خطأ في تسجيل الدخول أو جلسة توشك على الانتهاء.',
      },
      contrast: {
        title: 'ألوان سهلة القراءة',
        body: 'نتحقق من أزواج ألواننا مقابل نسبة التباين في معيار WCAG AA، في الوضعين الفاتح والداكن.',
      },
      motion: {
        title: 'حركة أقل',
        body: 'إذا طلب جهازك تقليل الحركة، يوقف TManage الحركات.',
      },
      textSize: {
        title: 'حجم الخط والتباين',
        body: 'من إعداداتك يمكنك اختيار أحد أربعة أحجام للخط، وتشغيل تباين أعلى، وإيقاف الحركة.',
      },
      arabic: {
        title: 'العربية من اليمين إلى اليسار',
        body: 'الموقع والتطبيق بالعربية والإنجليزية، وفي العربية يُقرأ التصميم كله من اليمين إلى اليسار.',
      },
      feedback: {
        title: 'هل يصعب عليك شيء؟',
        body: 'راسلنا على {email}، ويقرأ كل رسالة شخص من فريقنا.',
      },
    } satisfies Record<A11yCard, { title: string; body: string }>,
    todayTitle: 'أين نحن اليوم',
    todayNote: '«متاح اليوم» يعني أنه يعمل الآن. «مخطّط» يعني أننا نعمل عليه، وليس وعداً بعد.',
    status: { live: 'متاح اليوم', planned: 'مخطّط', not_audited: 'غير مُدقَّق' },
    claims: {
      keyboard: 'رابط للانتقال إلى المحتوى وحلقة تركيز واضحة',
      automated: 'فحوص آلية لإمكانية الوصول على أكثر من 100 شاشة',
      contrast: '‏التباين اللوني مُتحقَّق منه مقابل WCAG AA',
      motion: 'يتبع إعداد تقليل الحركة في جهازك',
      rtl: 'العربية بتصميم من اليمين إلى اليسار',
      settings: 'حجم الخط والتباين اللذان اخترتهما في كل صفحة فور تسجيل الدخول',
      screenReaders: '‏اختبار بقارئات شاشة حقيقية (NVDA وVoiceOver)',
      zoom: 'فحص كل صفحة يدوياً بتكبير 200%',
      wcag: '‏WCAG 2.2 AA هدفنا، لكن لم يدقّقنا أحد من خارج فريقنا بعد',
    } as Record<string, string>,
    gapsTitle: 'ما نعرف أنه لم يكتمل بعد',
    gapsBody:
      'تُطبَّق إعدادات حجم الخط والتباين والحركة بعد فتح صفحة إعدادات إمكانية الوصول، لا فوراً في كل صفحة. لم تُفحص الرسوم البيانية ومعاينات الملفات فحصاً كاملاً بقارئ الشاشة. ولم نختبر بعد بقارئات شاشة حقيقية أو بتكبير 200% يدوياً. إذا أعاقك شيء من هذا، أخبرنا وسنقدّمه في خطتنا.',
    helpTitle: 'تستخدم تقنية مساعدة؟',
    helpBody:
      'أخبرنا بما تستخدمه وأين واجهت صعوبة. سنصلح ما نستطيع، ونخبرك بصراحة بما لا نستطيعه بعد.',
    helpAction: 'اطرح سؤالاً',
    ctaTitle: 'أخبرنا بما يصعب استخدامه',
    ctaBody: 'راسلنا على {email}، واذكر الصفحة وما حدث. نقرأ كل رسالة.',
    ctaAction: 'راسلنا',
    ctaLink: 'أو اقرأ كيف نحمي عملك ←',
  },
} as const;

export function accessibilityCopy(language: AccessibilityLanguage) {
  return ACCESSIBILITY_COPY[language];
}
