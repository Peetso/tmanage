import type { OutboxEventPayloads } from '@tmanage/domain';
import { forCompany, greeting, signOffText } from '@tmanage/mail';
import type { Mailer, MailMessage } from '@tmanage/mail';

/**
 * 51-17 slice 2 — the "your company's files are at risk" mail to a workspace owner, the sibling of
 * {@link UsageThresholdMailer}: no link and no file names, only what happened and where to fix it
 * (Settings, Storage). `deliver` never throws — it runs after the batch commits — and reports.
 */

type RootAtRisk = OutboxEventPayloads['storage_connection.root_at_risk.v1'];

export interface StorageRootEmailFacts {
  /** 56-26: the sending company — its Message-ID is signed and its bounce suppressions apply. */
  readonly organizationId?: string;
  readonly recipientEmail: string;
  readonly recipientName: string;
  readonly provider: RootAtRisk['provider'];
  readonly reason: RootAtRisk['reason'];
  /** EMAILBUILD (c): the workspace, who holds the storage, the locale and the screen, when known. */
  readonly workspaceName?: string;
  readonly holderName?: string;
  readonly locale?: string;
  readonly link?: string;
}

/** U+200F, the right-to-left mark: keeps a mixed Arabic/Latin line anchored right. */
const RLM = String.fromCodePoint(0x20_0f);

/** Flattened before it reaches a header: a display name is a string a person typed. */
function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

const PROVIDER_NAME: Readonly<Record<StorageRootEmailFacts['provider'], string>> = {
  google_drive: 'Google Drive',
  onedrive: 'OneDrive',
};

/** EMAIL-COPY N16, signed "TManage Support" (reply-able). */
export function composeStorageRootEmail(facts: StorageRootEmailFacts): MailMessage {
  const language = facts.locale !== undefined && /^ar(?:-|$)/iu.test(facts.locale) ? 'ar' : 'en';
  const arabic = language === 'ar';
  const provider = PROVIDER_NAME[facts.provider];
  const named = facts.workspaceName === undefined ? '' : oneLine(facts.workspaceName);
  const holder = facts.holderName === undefined ? '' : oneLine(facts.holderName);
  const personal = facts.reason === 'personal_root';
  const target = facts.link ?? (arabic ? 'الإعدادات > التخزين' : 'Settings > Storage');
  const mark = arabic ? RLM : '';
  let subject: string;
  let lines: string[];
  if (arabic) {
    const ws = named === '' ? 'مساحة عملك' : named;
    const who = holder === '' ? 'شخص واحد' : holder;
    subject = personal
      ? `ملفات ${ws} محفوظة في ${provider} شخصي`
      : `سلّم تخزين ${provider} الخاص بـ ${ws}`;
    lines = personal
      ? [
          `ملفات ${ws} محفوظة في حساب ${provider} الشخصي لـ ${who}. لو أُغلق هذا الحساب أو غادر صاحبه، تفقد الشركة الوصول إليها.`,
          `انقل الملفات إلى حساب الشركة: ${target}`,
          'ردّ علينا لو أردت أن نشرح لك الخطوات.',
        ]
      : [
          `تخزين ${provider} الخاص بـ ${ws} مربوط بحساب شخص لم يعد مسؤولًا في مساحة العمل. من فضلك سلّمه إلى حساب تابع للشركة حتى تبقى الملفات مع الشركة.`,
          `ابدأ التسليم: ${target}`,
        ];
  } else {
    const ws = named === '' ? 'Your workspace' : named;
    const whose = holder === '' ? "one person's" : `${holder}'s`;
    subject = personal
      ? `${ws} files are stored in a personal ${provider}`
      : `Hand over the ${provider} storage of ${ws}`;
    lines = personal
      ? [
          `The files of ${ws} are stored in ${whose} personal ${provider}. If that account is closed or its owner leaves, the company loses access to them.`,
          `Move the files to a company account: ${target}`,
          'Reply if you want us to walk you through it.',
        ]
      : [
          `The ${provider} storage of ${ws} is connected through the account of someone who is no longer an admin. Please hand it over to a company account so the files stay with the company.`,
          `Start the handover: ${target}`,
        ];
  }
  return {
    to: facts.recipientEmail,
    language,
    subject: `${mark}${subject}`,
    text: [
      greeting(language, facts.recipientName),
      ...lines.map((line) => `${mark}${line}`),
      signOffText('support', language, true),
    ].join('\n\n'),
  };
}

export type StorageRootMailDelivery = 'sent' | 'none' | 'failed';

export class StorageRootMailer {
  /** @param mailer `null` when no transport is wired. */
  constructor(private readonly mailer: Mailer | null) {}

  get enabled(): boolean {
    return this.mailer !== null;
  }

  async deliver(facts: StorageRootEmailFacts): Promise<StorageRootMailDelivery> {
    if (this.mailer === null) return 'none';
    try {
      return await this.mailer.send(
        forCompany(composeStorageRootEmail(facts), facts.organizationId),
      );
    } catch (error) {
      // Absorbed loudly, without the address, as the sibling mailers do.
      console.error('[worker] storage root email failed', error);
      return 'failed';
    }
  }
}
