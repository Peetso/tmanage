/**
 * 57-08 REFERRAL — the website page "Invite a company" (`/referral`, Arabic twin `/ar/referral`;
 * Figma 724:40609 EN / 724:40715 AR, design review B points 10–11, 25 and copy table C).
 *
 * Claims: none beyond the facts page — every workspace has an invite link, the list shows who
 * signed up, and TManage is free during the beta. No reward, price or customer number.
 * U+200F (RLM) starts an Arabic line that opens with Latin, as drawn.
 */
export interface ReferralPageCopy {
  readonly title: string;
  readonly description: string;
  readonly eyebrow: string;
  readonly heading: string;
  readonly lede: string;
  readonly steps: readonly { readonly title: string; readonly body: string }[];
  readonly primary: string;
  readonly secondary: string;
  readonly betaNote: string;
}

const RLM = '‏';

export const REFERRAL_PAGE_COPY: Readonly<Record<'en' | 'ar', ReferralPageCopy>> = {
  en: {
    title: 'Invite a company',
    description:
      'Every TManage workspace has its own invite link. Share it with companies you work with or know.',
    eyebrow: 'Invite a company',
    heading: 'Bring another company to TManage',
    lede: 'Every TManage workspace has its own invite link. Share it with companies you work with or know.',
    steps: [
      { title: 'Find your link', body: 'Open Settings, then Invite companies.' },
      { title: 'Share it', body: 'Send it by e-mail or chat to the company owner.' },
      {
        title: 'See who signed up',
        body: 'Your list shows each company that signed up through your link.',
      },
    ],
    primary: 'Open my invite link',
    secondary: 'New here? Start a free workspace',
    betaNote: 'TManage is free during the beta.',
  },
  ar: {
    title: 'ادعُ شركة',
    description: `${RLM}لكل مساحة عمل في TManage رابط دعوة خاص بها. شاركه مع الشركات التي تعمل معها أو تعرفها.`,
    eyebrow: 'ادعُ شركة',
    heading: 'عرّف شركة أخرى على TManage',
    lede: `${RLM}لكل مساحة عمل في TManage رابط دعوة خاص بها. شاركه مع الشركات التي تعمل معها أو تعرفها.`,
    steps: [
      { title: 'اعثر على رابطك', body: 'افتح الإعدادات، ثم ادعُ شركات.' },
      { title: 'شاركه', body: 'أرسله بالبريد أو في محادثة إلى صاحب الشركة.' },
      { title: 'اعرف من سجّل', body: 'تعرض قائمتك كل شركة سجّلت من خلال رابطك.' },
    ],
    primary: 'افتح رابط دعوتي',
    secondary: 'جديد هنا؟ ابدأ مساحة عمل مجانية',
    betaNote: `${RLM}TManage مجاني خلال الفترة التجريبية.`,
  },
};

/** The English text of the page, for `llms-full.txt` and `/md/referral`. */
export function referralMarkdown(): string[] {
  const copy = REFERRAL_PAGE_COPY.en;
  return [
    copy.lede,
    copy.steps.map((step, index) => `${index + 1}. **${step.title}.** ${step.body}`).join('\n'),
    copy.betaNote,
  ];
}
