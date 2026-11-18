import type { HelpLanguage } from './help-articles';

/** U+200F after a Latin product name where Arabic text continues (as on the compare pages). */
const RLM = '‏';

/**
 * Row 55-16 — the Help centre's own interface words, in English and Arabic beside the articles
 * they frame (the same repo-content pattern as the articles). Other interface languages read the
 * English column until the help content is translated into them.
 */
export const HELP_COPY = {
  en: {
    eyebrow: 'Help centre',
    title: 'How can we help?',
    lede: 'Short answers for getting set up, running projects and working with clients.',
    searchLabel: 'Search help articles',
    browse: 'Browse by topic',
    resultsTitle: 'Search results',
    resultsCount: (n: number) => (n === 1 ? '1 article found' : `${n} articles found`),
    emptyTitle: 'No article matches that yet',
    emptyBody: 'Try a shorter word, or ask us directly.',
    articlesCount: (n: number) => (n === 1 ? '1 article' : `${n} articles`),
    minutes: (n: number) => `${n} min read`,
    breadcrumbLabel: 'Breadcrumb',
    home: 'Help centre',
    stepsLabel: 'Steps',
    tip: 'Tip',
    related: 'Related articles',
    stuck: 'Still stuck?',
    contact: 'Contact support',
    allArticles: 'All help articles',
    contextLink: 'Help for this page',
    switchLink: (name: string) => `Switching from ${name} to TManage`,
    compareLink: (name: string) => `TManage vs ${name}`,
    promptLabel: 'Request to copy',
    copy: 'Copy',
    copied: 'Copied',
  },
  ar: {
    eyebrow: 'مركز المساعدة',
    title: 'كيف يمكننا مساعدتك؟',
    lede: 'إجابات قصيرة للبدء وإدارة المشاريع والعمل مع العملاء.',
    searchLabel: 'ابحث في مقالات المساعدة',
    browse: 'تصفّح حسب الموضوع',
    resultsTitle: 'نتائج البحث',
    resultsCount: (n: number) =>
      n === 1 ? 'مقالة واحدة' : n === 2 ? 'مقالتان' : n <= 10 ? `${n} مقالات` : `${n} مقالة`,
    emptyTitle: 'لا توجد مقالة تطابق بحثك بعد',
    emptyBody: 'جرّب كلمة أقصر، أو اسألنا مباشرة.',
    articlesCount: (n: number) =>
      n === 1 ? 'مقالة واحدة' : n === 2 ? 'مقالتان' : n <= 10 ? `${n} مقالات` : `${n} مقالة`,
    minutes: (n: number) =>
      n === 1 ? 'قراءة في دقيقة' : n === 2 ? 'قراءة في دقيقتين' : `قراءة في ${n} دقائق`,
    breadcrumbLabel: 'مسار التنقل',
    home: 'مركز المساعدة',
    stepsLabel: 'الخطوات',
    tip: 'نصيحة',
    related: 'مقالات ذات صلة',
    stuck: 'ما زلت بحاجة إلى مساعدة؟',
    contact: 'تواصل مع الدعم',
    allArticles: 'كل مقالات المساعدة',
    contextLink: 'مساعدة لهذه الصفحة',
    switchLink: (name: string) => `الانتقال من ${name}${RLM} إلى TManage${RLM}`,
    compareLink: (name: string) => `${RLM}TManage مقابل ${name}`,
    promptLabel: 'طلب للنسخ',
    copy: 'نسخ',
    copied: 'تم النسخ',
  },
} satisfies Record<HelpLanguage, unknown>;

export type HelpCopy = (typeof HELP_COPY)['en'];

export function helpCopy(language: HelpLanguage): HelpCopy {
  return HELP_COPY[language];
}
