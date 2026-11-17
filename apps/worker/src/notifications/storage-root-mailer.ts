import type { OutboxEventPayloads } from '@tmanage/domain';
import { forCompany } from '@tmanage/mail';
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
}

/** Flattened before it reaches a header: a display name is a string a person typed. */
function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

const PROVIDER_NAME: Readonly<Record<StorageRootEmailFacts['provider'], string>> = {
  google_drive: 'Google Drive',
  onedrive: 'OneDrive',
};

export function composeStorageRootEmail(facts: StorageRootEmailFacts): MailMessage {
  const name = oneLine(facts.recipientName);
  const provider = PROVIDER_NAME[facts.provider];
  const what =
    facts.reason === 'personal_root'
      ? `Your company's TManage files are stored in one person's own ${provider}. If that ` +
        `account is removed, the files go with it.`
      : `The person who connected your company's ${provider} is no longer an admin of this ` +
        `workspace. The files still work for now, but they stay in that person's account until ` +
        `the storage is handed over.`;
  const fix =
    facts.reason === 'personal_root'
      ? `Move the storage to a company-owned place (a Shared Drive or a SharePoint library) in ` +
        `Settings, Storage.`
      : `Hand the storage over to another admin in Settings, Storage, before that account is removed.`;
  return {
    to: facts.recipientEmail,
    subject:
      facts.reason === 'personal_root'
        ? `Your TManage files are in a personal ${provider}`
        : `Hand over your TManage ${provider} storage`,
    text: [
      `Hello ${name},`,
      what,
      fix,
      `You are receiving this because you own this TManage workspace.`,
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
