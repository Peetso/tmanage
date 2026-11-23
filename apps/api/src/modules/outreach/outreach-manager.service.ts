import { uuidv7 } from '@tmanage/domain';
import type { FieldCipher } from '@tmanage/domain/field-cipher';
import {
  CAMPAIGN_EMAIL_KINDS,
  CAMPAIGN_LANGUAGES,
  CAMPAIGN_PLACEHOLDERS,
  DEFAULT_CAMPAIGN_EMAILS,
  campaignLinks,
  campaignMailLanguage,
  campaignTextProblems,
  isCampaignLanguage,
  normaliseCampaignText,
  renderCampaignEmail,
} from '@tmanage/mail';
import type {
  CampaignEmailKind,
  CampaignEmailText,
  CampaignLanguage,
  MailDelivery,
  Mailer,
} from '@tmanage/mail';
import { ApiError } from '../../common/http/errors.js';
import { requireId } from '../platform-admin/platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import type { RequestContext } from '../platform-admin/platform-admin.service.js';
import { platformAuditFor } from '../platform-admin/platform-audit.service.js';
import {
  normaliseCompany,
  outreachAddressHash,
  planOutreachImport,
  readDecisionMakersCsv,
  reassignSenders,
  senderPools,
  type OutreachExclusion,
  type OutreachSender,
  type PlannedRecipient,
} from './outreach-import.js';
import {
  campaignView,
  recipientView,
  type OutreachCampaignView,
  type OutreachRecipientView,
} from './outreach-views.js';
import type {
  CampaignRecord,
  CampaignSettings,
  EmailVersionRow,
  OutreachRepository,
  RecipientInsert,
  RecipientRecord,
  SenderPool,
} from './outreach.repository.js';

/**
 * OUTREACH MANAGER (owner 2026-11-23) — Platform admin -> Outreach as a campaign manager: several
 * campaigns, each with its own languages, senders, pace, e-mail (every save a version) and
 * optional single follow-up; its recipients viewed, added, changed, removed, imported and
 * exported; a live preview and a test send to the signed-in admin only.
 *
 * Rules the editing cannot break (they live in `@tmanage/mail` `renderCampaignEmail`, shared with
 * the worker's send): the unsubscribe line and the RFC 8058 headers are always added, the US
 * postal address is always added for a US recipient, the text is plain (no HTML, no pixel), and a
 * placeholder outside the five known ones is refused. A started campaign's e-mail is changed only
 * with an explicit confirmation; the worker sends the version that is newest when a mail leaves.
 * The page never shows an address except in the audited export.
 */

export type OutreachManagerStore = Pick<
  OutreachRepository,
  | 'activeSenders'
  | 'known'
  | 'suppressed'
  | 'insertCampaign'
  | 'campaign'
  | 'chosenSenders'
  | 'counts'
  | 'recipients'
  | 'recipient'
  | 'exportRows'
  | 'updateSettings'
  | 'setArchived'
  | 'latestVersions'
  | 'versionList'
  | 'version'
  | 'saveVersion'
  | 'insertRecipients'
  | 'updateRecipient'
  | 'deleteRecipient'
  | 'markReplied'
  | 'audit'
>;

export interface OutreachManagerOptions {
  readonly mailer: Mailer | null;
  readonly webPublicUrl: string;
  readonly postalAddress?: () => string;
  readonly now?: () => Date;
}

export interface OutreachSenderView {
  readonly id: string;
  readonly address: string;
  readonly name: string;
  /** Which mail the person signs: Arabic, or every other language. */
  readonly side: 'ar' | 'en';
  readonly chosen: boolean;
}

export interface OutreachEmailTextView {
  readonly subject: string;
  readonly body: string;
  /** `null` = the default text (never saved for this language). */
  readonly version: number | null;
  readonly savedAt: string | null;
}

export interface OutreachVersionView {
  readonly kind: CampaignEmailKind;
  readonly version: number;
  readonly languages: readonly CampaignLanguage[];
  readonly createdAt: string;
  readonly byYou: boolean;
}

export interface OutreachCampaignDetailView {
  readonly campaign: OutreachCampaignView;
  readonly senders: readonly OutreachSenderView[];
  readonly emails: Readonly<
    Record<CampaignEmailKind, Readonly<Partial<Record<CampaignLanguage, OutreachEmailTextView>>>>
  >;
  readonly versions: readonly OutreachVersionView[];
  readonly postalAddressSet: boolean;
  readonly placeholders: readonly string[];
  readonly languages: readonly CampaignLanguage[];
}

export interface OutreachVersionTextView {
  readonly kind: CampaignEmailKind;
  readonly version: number;
  readonly createdAt: string;
  readonly texts: Readonly<Partial<Record<CampaignLanguage, CampaignEmailText>>>;
}

export interface OutreachRecipientsView {
  readonly campaign: OutreachCampaignView;
  readonly recipients: readonly OutreachRecipientView[];
  readonly postalAddressSet: boolean;
}

export interface OutreachRecipientsImportView extends OutreachRecipientsView {
  readonly imported: number;
  readonly rows: number;
  readonly excluded: Readonly<Partial<Record<OutreachExclusion, number>>>;
}

export interface OutreachPreviewView {
  readonly from: string;
  /** The recipient's address, masked (`s•••@example.com`); a sample when no one is chosen. */
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly recipientId: string | null;
  readonly problems: readonly string[];
}

export interface OutreachTestSendView {
  readonly sent: boolean;
  readonly to: string;
}

export interface OutreachExportView {
  readonly filename: string;
  readonly csv: string;
  readonly rows: number;
}

type Body = Readonly<Record<string, unknown>>;

const CIPHER_PURPOSE = 'outreach_email' as const;
const NAME_MAX = 120;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;
const SAMPLE = { firstName: 'Sam', company: 'Example Studio', country: 'GB' } as const;
const PREVIEW_TOKEN = 'preview';

const TEMPLATE_KEY: Readonly<Record<CampaignEmailKind, string>> = {
  intro: 'campaign_intro',
  followup: 'campaign_followup',
};

const invalid = (field: string, message: string): ApiError =>
  new ApiError(400, 'validation_failed', message, [{ field, message }]);

const conflict = (message: string, field?: string): ApiError =>
  new ApiError(409, 'conflict', message, field === undefined ? undefined : [{ field, message }]);

function readName(raw: unknown, fallback: string | null): string {
  if (raw === undefined && fallback !== null) return fallback;
  if (typeof raw !== 'string') throw invalid('name', 'Give the campaign a name.');
  const name = raw.replace(/\s+/gu, ' ').trim();
  if (name === '' || name.length > NAME_MAX || CONTROL.test(name)) {
    throw invalid('name', `Give the campaign a name of 1 to ${String(NAME_MAX)} characters.`);
  }
  return name;
}

function readKind(raw: unknown): CampaignEmailKind {
  if (raw === 'intro' || raw === 'followup') return raw;
  throw new ApiError(404, 'not_found', 'The requested resource was not found');
}

function readLanguageList(raw: unknown, fallback: readonly CampaignLanguage[]): CampaignLanguage[] {
  if (raw === undefined) return [...fallback];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > CAMPAIGN_LANGUAGES.length) {
    throw invalid('languages', 'Choose at least one language.');
  }
  const list: CampaignLanguage[] = [];
  for (const item of raw) {
    if (!isCampaignLanguage(item)) throw invalid('languages', 'That language is not offered.');
    if (!list.includes(item)) list.push(item);
  }
  return list;
}

function readInt(raw: unknown, field: string, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw invalid(field, `Use a whole number from ${String(min)} to ${String(max)}.`);
  }
  return raw;
}

function readBool(raw: unknown, field: string, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') throw invalid(field, 'Use true or false.');
  return raw;
}

function readPool(raw: unknown, fallback: SenderPool): SenderPool {
  if (raw === undefined) return fallback;
  if (raw === 'auto' || raw === 'chosen') return raw;
  throw invalid('senderPool', 'Choose every sender, or chosen senders.');
}

function readIds(raw: unknown, field: string): string[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > 500) throw invalid(field, 'Choose the senders.');
  const ids: string[] = [];
  for (const item of raw) {
    let id: string;
    try {
      id = requireId(item);
    } catch {
      throw invalid(field, 'One of the senders is not in E-mail people.');
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function readText(raw: unknown, field: string): CampaignEmailText {
  const value = (raw ?? {}) as Body;
  const subject = typeof value['subject'] === 'string' ? value['subject'] : '';
  const body = typeof value['body'] === 'string' ? value['body'] : '';
  const text = { subject: subject.trim(), body: normaliseCampaignText(body) };
  const problems = campaignTextProblems({ subject, body });
  if (problems.length > 0) {
    throw new ApiError(
      400,
      'validation_failed',
      'The e-mail cannot be saved as it is.',
      problems.map((problem) => ({ field, message: problem })),
    );
  }
  return text;
}

/** `s•••@example.com`: enough to tell people apart, never the whole address on screen. */
export function maskAddress(address: string): string {
  const [local = '', domain = ''] = address.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}

/** A CSV cell, quoted, with spreadsheet formulas neutralised (OWASP CSV injection). */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/gu, '""')}"`;
}

/** The newest saved text per language, or the default text where nothing was saved. */
function emailsOf(
  rows: readonly EmailVersionRow[],
  languages: readonly CampaignLanguage[],
): Record<CampaignEmailKind, Partial<Record<CampaignLanguage, OutreachEmailTextView>>> {
  const emails: Record<
    CampaignEmailKind,
    Partial<Record<CampaignLanguage, OutreachEmailTextView>>
  > = { intro: {}, followup: {} };
  for (const kind of CAMPAIGN_EMAIL_KINDS) {
    for (const language of languages) {
      const saved = rows.find((row) => row.kind === kind && row.language === language);
      const fallback = DEFAULT_CAMPAIGN_EMAILS[kind][language];
      if (saved !== undefined) {
        emails[kind][language] = {
          subject: saved.subject,
          body: saved.body,
          version: saved.version,
          savedAt: saved.createdAt.toISOString(),
        };
      } else if (fallback !== undefined) {
        emails[kind][language] = { ...fallback, version: null, savedAt: null };
      }
    }
  }
  return emails;
}

export class OutreachManagerService {
  private readonly postalAddress: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly store: OutreachManagerStore,
    private readonly cipher: FieldCipher,
    private readonly options: OutreachManagerOptions,
  ) {
    this.postalAddress =
      options.postalAddress ?? (() => (process.env['CAMPAIGN_POSTAL_ADDRESS'] ?? '').trim());
    this.now = options.now ?? (() => new Date());
  }

  // ---- campaigns ----

  async create(
    actor: PlatformAdminActor,
    body: Body,
    context: RequestContext,
  ): Promise<OutreachCampaignDetailView> {
    const name = readName(body['name'], null);
    const settings = await this.readSettings(body, null, context);
    const id = uuidv7();
    const at = this.now();
    await this.store.insertCampaign(
      {
        id,
        name,
        ...settings.settings,
        createdBy: actor.account.userId,
        at,
        senderIds: settings.senderIds ?? [],
        versions: defaultVersions(settings.settings.languages),
      },
      [],
      this.audit(actor, context, 'platform.outreach_campaign_created', name, null, {
        campaignId: id,
        ...settings.settings,
      }),
    );
    return this.detail(actor, id, context);
  }

  async detail(
    actor: PlatformAdminActor,
    rawId: string,
    context: RequestContext,
  ): Promise<OutreachCampaignDetailView> {
    const campaign = await this.campaignOrThrow(rawId, context);
    const [counts, senders, chosen, latest, versions] = await Promise.all([
      this.store.counts(context.correlationId),
      this.store.activeSenders(context.correlationId),
      this.store.chosenSenders(campaign.id, context.correlationId),
      this.store.latestVersions(campaign.id, context.correlationId),
      this.store.versionList(campaign.id, context.correlationId),
    ]);
    const pools = senderPools(senders);
    return {
      campaign: campaignView(campaign, counts.get(campaign.id)),
      senders: senders.map((s) => ({
        id: s.id,
        address: s.address,
        name: s.nameEn ?? '',
        side: pools.ar.some((a) => a.id === s.id) ? 'ar' : 'en',
        chosen: chosen.includes(s.id),
      })),
      emails: emailsOf(latest, campaign.languages),
      versions: versions.map((v) => ({
        kind: v.kind,
        version: v.version,
        languages: v.languages,
        createdAt: v.createdAt.toISOString(),
        byYou: v.createdBy === actor.account.userId,
      })),
      postalAddressSet: this.postalAddress() !== '',
      placeholders: Object.keys(CAMPAIGN_PLACEHOLDERS),
      languages: [...CAMPAIGN_LANGUAGES],
    };
  }

  async update(
    actor: PlatformAdminActor,
    rawId: string,
    body: Body,
    context: RequestContext,
  ): Promise<OutreachCampaignDetailView> {
    const campaign = await this.campaignOrThrow(rawId, context);
    if (campaign.archivedAt !== null) {
      throw conflict('An archived campaign cannot be changed. Bring it back first.');
    }
    const name = readName(body['name'], campaign.name);
    const read = await this.readSettings(body, campaign, context);
    const next = read.settings;
    const poolChanged =
      next.senderPool !== campaign.senderPool ||
      (read.senderIds !== null &&
        !sameSet(
          read.senderIds,
          await this.store.chosenSenders(campaign.id, context.correlationId),
        ));
    if (
      campaign.status === 'stopped' &&
      (JSON.stringify(settingsOf(campaign)) !== JSON.stringify(next) || poolChanged)
    ) {
      throw conflict('A stopped campaign can only be renamed.');
    }
    const recipients = await this.store.recipients(campaign.id, context.correlationId);
    const queued = recipients.filter((r) => r.status === 'queued');
    const dropped = queued.find((r) => !next.languages.includes(r.language as CampaignLanguage));
    if (dropped !== undefined) {
      throw conflict(
        'People waiting to be sent to use a language you removed. Change or remove them first.',
        'languages',
      );
    }
    const reassign = poolChanged
      ? reassignSenders(
          queued,
          await this.poolSenders(next.senderPool, read.senderIds, campaign, context),
        )
      : [];
    const done = await this.store.updateSettings(
      campaign.id,
      { name, ...next, senderIds: read.senderIds, reassign },
      this.now(),
      this.audit(
        actor,
        context,
        'platform.outreach_campaign_updated',
        name,
        { name: campaign.name, ...settingsOf(campaign) },
        { name, ...next, reassigned: reassign.length },
      ),
    );
    if (!done) throw conflict('The campaign changed meanwhile. Reload.');
    return this.detail(actor, campaign.id, context);
  }

  async duplicate(
    actor: PlatformAdminActor,
    rawId: string,
    body: Body,
    context: RequestContext,
  ): Promise<OutreachCampaignDetailView> {
    const source = await this.campaignOrThrow(rawId, context);
    const name = readName(body['name'], `${source.name} (copy)`.slice(0, NAME_MAX));
    const [chosen, latest] = await Promise.all([
      this.store.chosenSenders(source.id, context.correlationId),
      this.store.latestVersions(source.id, context.correlationId),
    ]);
    const versions: Partial<
      Record<CampaignEmailKind, Partial<Record<CampaignLanguage, CampaignEmailText>>>
    > = defaultVersions(source.languages);
    for (const row of latest) {
      if (!source.languages.includes(row.language)) continue;
      versions[row.kind] = {
        ...versions[row.kind],
        [row.language]: { subject: row.subject, body: row.body },
      };
    }
    const id = uuidv7();
    await this.store.insertCampaign(
      {
        id,
        name,
        ...settingsOf(source),
        createdBy: actor.account.userId,
        at: this.now(),
        senderIds: source.senderPool === 'chosen' ? chosen : [],
        versions,
      },
      [],
      this.audit(actor, context, 'platform.outreach_campaign_duplicated', name, null, {
        campaignId: id,
        from: source.id,
      }),
    );
    return this.detail(actor, id, context);
  }

  async archive(
    actor: PlatformAdminActor,
    rawId: string,
    archived: boolean,
    context: RequestContext,
  ): Promise<OutreachCampaignDetailView> {
    const campaign = await this.campaignOrThrow(rawId, context);
    if (archived && campaign.status === 'running') {
      throw conflict('Pause or stop the campaign before archiving it.');
    }
    const at = this.now();
    const done = await this.store.setArchived(
      campaign.id,
      archived ? at : null,
      at,
      this.audit(
        actor,
        context,
        archived ? 'platform.outreach_campaign_archived' : 'platform.outreach_campaign_restored',
        campaign.name,
        { archived: campaign.archivedAt !== null },
        { archived },
      ),
    );
    if (!done) throw conflict('The campaign changed meanwhile. Reload.');
    return this.detail(actor, campaign.id, context);
  }

  // ---- e-mail ----

  async saveEmail(
    actor: PlatformAdminActor,
    rawId: string,
    rawKind: string,
    body: Body,
    context: RequestContext,
  ): Promise<OutreachCampaignDetailView> {
    const kind = readKind(rawKind);
    const campaign = await this.campaignOrThrow(rawId, context);
    if (campaign.archivedAt !== null || campaign.status === 'stopped') {
      throw conflict('A stopped or archived campaign’s e-mail cannot be changed.');
    }
    if (campaign.firstStartedAt !== null && body['confirmStarted'] !== true) {
      throw conflict(
        'This campaign has started. Confirm that the next mails use the new text.',
        'confirmStarted',
      );
    }
    const raw = (body['texts'] ?? {}) as Body;
    const texts: Partial<Record<CampaignLanguage, CampaignEmailText>> = {};
    for (const language of campaign.languages) {
      texts[language] = readText(raw[language], `texts.${language}`);
    }
    const version = await this.store.saveVersion(
      campaign.id,
      kind,
      texts,
      actor.account.userId,
      this.now(),
      (number) =>
        this.audit(actor, context, 'platform.outreach_email_saved', campaign.name, null, {
          campaignId: campaign.id,
          kind,
          version: number,
          languages: campaign.languages,
          started: campaign.firstStartedAt !== null,
        }),
    );
    if (version === null) throw new ApiError(404, 'not_found', 'That campaign does not exist.');
    return this.detail(actor, campaign.id, context);
  }

  async versionText(
    rawId: string,
    rawKind: string,
    rawVersion: string,
    context: RequestContext,
  ): Promise<OutreachVersionTextView> {
    const kind = readKind(rawKind);
    const campaign = await this.campaignOrThrow(rawId, context);
    const number = Number(rawVersion);
    if (!Number.isInteger(number) || number < 1) {
      throw new ApiError(404, 'not_found', 'That version does not exist.');
    }
    const rows = await this.store.version(campaign.id, kind, number, context.correlationId);
    const first = rows[0];
    if (first === undefined) throw new ApiError(404, 'not_found', 'That version does not exist.');
    const texts: Partial<Record<CampaignLanguage, CampaignEmailText>> = {};
    for (const row of rows) texts[row.language] = { subject: row.subject, body: row.body };
    return { kind, version: number, createdAt: first.createdAt.toISOString(), texts };
  }

  /** The mail exactly as one recipient would get it (links carry a preview token). */
  async preview(rawId: string, body: Body, context: RequestContext): Promise<OutreachPreviewView> {
    const campaign = await this.campaignOrThrow(rawId, context);
    return this.render(campaign, body, context);
  }

  /** The same mail to the signed-in platform admin's own address; nowhere else. */
  async testSend(
    actor: PlatformAdminActor,
    rawId: string,
    body: Body,
    context: RequestContext,
  ): Promise<OutreachTestSendView> {
    const campaign = await this.campaignOrThrow(rawId, context);
    const kind = body['kind'] === 'followup' ? 'followup' : 'intro';
    const rendered = await this.render(campaign, body, context);
    if (rendered.problems.length > 0) {
      throw new ApiError(
        400,
        'validation_failed',
        'Fix the e-mail before sending a test.',
        rendered.problems.map((problem) => ({ field: 'text', message: problem })),
      );
    }
    const language = this.languageOf(campaign, body['language']);
    const senderId = rendered.senderId;
    let delivery: MailDelivery | 'failed' = 'none';
    if (this.options.mailer !== null && senderId !== null) {
      try {
        delivery = await this.options.mailer.send({
          to: actor.account.email,
          templateKey: TEMPLATE_KEY[kind],
          language: campaignMailLanguage(language),
          personRef: { kind: 'test', personId: senderId },
          subject: `[Test] ${rendered.subject}`,
          text: rendered.text,
        });
      } catch {
        delivery = 'failed';
      }
    }
    await this.store.audit(
      this.audit(actor, context, 'platform.outreach_test_sent', campaign.name, null, {
        campaignId: campaign.id,
        kind,
        language,
        delivery,
      }),
    );
    return { sent: delivery === 'sent', to: actor.account.email };
  }

  // ---- recipients ----

  async recipients(rawId: string, context: RequestContext): Promise<OutreachRecipientsView> {
    const campaign = await this.campaignOrThrow(rawId, context);
    return this.recipientsView(campaign, context);
  }

  async addRecipient(
    actor: PlatformAdminActor,
    rawId: string,
    body: Body,
    context: RequestContext,
  ): Promise<OutreachRecipientsView> {
    const campaign = await this.writableCampaign(rawId, context);
    const row = personRow(body, null);
    const [planned] = await this.plan(campaign, [row], null, context);
    const id = uuidv7();
    await this.store.insertRecipients(
      [this.sealed(id, campaign.id, planned)],
      this.now(),
      this.audit(actor, context, 'platform.outreach_recipient_added', campaign.name, null, {
        campaignId: campaign.id,
        recipientId: id,
        country: planned.country,
      }),
    );
    return this.recipientsView(campaign, context);
  }

  async importInto(
    actor: PlatformAdminActor,
    rawId: string,
    body: Body,
    context: RequestContext,
  ): Promise<OutreachRecipientsImportView> {
    const campaign = await this.writableCampaign(rawId, context);
    const rows = readDecisionMakersCsv(body['csv']);
    const plan = await this.planAll(campaign, rows, null, context);
    if (plan.recipients.length === 0) {
      throw new ApiError(400, 'validation_failed', 'No row in the file can be written to.', [
        { field: 'csv', message: JSON.stringify(plan.excluded) },
      ]);
    }
    const inserts = plan.recipients.map((r) => this.sealed(uuidv7(), campaign.id, r));
    await this.store.insertRecipients(
      inserts,
      this.now(),
      this.audit(actor, context, 'platform.outreach_recipients_imported', campaign.name, null, {
        campaignId: campaign.id,
        imported: inserts.length,
        excluded: plan.excluded,
      }),
    );
    return {
      ...(await this.recipientsView(campaign, context)),
      imported: inserts.length,
      rows: plan.rows,
      excluded: plan.excluded,
    };
  }

  async updateRecipient(
    actor: PlatformAdminActor,
    rawId: string,
    body: Body,
    context: RequestContext,
  ): Promise<OutreachRecipientsView> {
    const existing = await this.recipientOrThrow(rawId, context);
    if (existing.status !== 'queued') {
      throw conflict('Only a person who has not been sent to yet can be changed.');
    }
    const campaign = await this.writableCampaign(existing.campaignId, context);
    const row = personRow(body, existing);
    if (row['work_email'] === '') row['work_email'] = this.open(existing);
    const [planned] = await this.plan(campaign, [row], existing.id, context);
    const done = await this.store.updateRecipient(
      {
        id: existing.id,
        company: planned.company,
        personName: planned.personName,
        firstName: planned.firstName,
        emailEnc: this.cipher.encrypt(planned.email, {
          purpose: CIPHER_PURPOSE,
          ownerId: existing.id,
        }),
        emailHash: planned.emailHash,
        country: planned.country,
        timeZone: planned.timeZone,
        language: planned.language,
        senderPersonId: planned.senderPersonId,
      },
      this.now(),
      this.audit(actor, context, 'platform.outreach_recipient_updated', campaign.name, null, {
        campaignId: campaign.id,
        recipientId: existing.id,
        addressChanged: planned.emailHash !== existing.emailHash,
      }),
    );
    if (!done) throw conflict('That person was sent to meanwhile. Reload.');
    return this.recipientsView(campaign, context);
  }

  async removeRecipient(
    actor: PlatformAdminActor,
    rawId: string,
    context: RequestContext,
  ): Promise<OutreachRecipientsView> {
    const existing = await this.recipientOrThrow(rawId, context);
    if (existing.status !== 'queued') {
      throw conflict('Only a person who has not been sent to yet can be removed.');
    }
    const campaign = await this.campaignOrThrow(existing.campaignId, context);
    const done = await this.store.deleteRecipient(
      existing.id,
      this.audit(actor, context, 'platform.outreach_recipient_removed', campaign.name, null, {
        campaignId: campaign.id,
        recipientId: existing.id,
      }),
    );
    if (!done) throw conflict('That person was sent to meanwhile. Reload.');
    return this.recipientsView(campaign, context);
  }

  async markReplied(
    actor: PlatformAdminActor,
    rawId: string,
    context: RequestContext,
  ): Promise<OutreachRecipientsView> {
    const existing = await this.recipientOrThrow(rawId, context);
    const campaign = await this.campaignOrThrow(existing.campaignId, context);
    if (existing.repliedAt === null) {
      await this.store.markReplied(
        existing.id,
        this.now(),
        this.audit(actor, context, 'platform.outreach_recipient_replied', campaign.name, null, {
          campaignId: campaign.id,
          recipientId: existing.id,
        }),
      );
    }
    return this.recipientsView(campaign, context);
  }

  /** Every recipient with the address, as CSV; the export is audited. */
  async exportCsv(
    actor: PlatformAdminActor,
    rawId: string,
    context: RequestContext,
  ): Promise<OutreachExportView> {
    const campaign = await this.campaignOrThrow(rawId, context);
    const rows = await this.store.exportRows(
      campaign.id,
      this.audit(actor, context, 'platform.outreach_recipients_exported', campaign.name, null, {
        campaignId: campaign.id,
      }),
    );
    const header = [
      'company',
      'person_name',
      'first_name',
      'work_email',
      'country',
      'language',
      'sender',
      'status',
      'sent_at',
      'followup_status',
      'followup_sent_at',
      'replied_at',
      'trial_started_at',
      'walkthrough_at',
      'unsubscribed',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.company,
          r.personName,
          r.firstName,
          this.open(r),
          r.country,
          r.language,
          r.senderAddress ?? '',
          r.status,
          r.sentAt?.toISOString() ?? '',
          r.followupStatus ?? '',
          r.followupSentAt?.toISOString() ?? '',
          r.repliedAt?.toISOString() ?? '',
          r.trialRedeemedAt?.toISOString() ?? '',
          r.walkthroughAt?.toISOString() ?? '',
          r.optedOut ? 'yes' : 'no',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    const slug =
      campaign.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 40) || 'campaign';
    return {
      filename: `outreach-${slug}-${this.now().toISOString().slice(0, 10)}.csv`,
      csv: `${lines.join('\r\n')}\r\n`,
      rows: rows.length,
    };
  }

  // ---- helpers ----

  private async campaignOrThrow(rawId: string, context: RequestContext): Promise<CampaignRecord> {
    const campaign = await this.store.campaign(requireId(rawId), context.correlationId);
    if (campaign === null) throw new ApiError(404, 'not_found', 'That campaign does not exist.');
    return campaign;
  }

  private async writableCampaign(rawId: string, context: RequestContext): Promise<CampaignRecord> {
    const campaign = await this.campaignOrThrow(rawId, context);
    if (campaign.archivedAt !== null || campaign.status === 'stopped') {
      throw conflict('People cannot be added to a stopped or archived campaign.');
    }
    if (!this.cipher.enabled) {
      throw conflict('Addresses cannot be stored: FIELD_CIPHER_KEYS is not set on this server.');
    }
    return campaign;
  }

  private async recipientOrThrow(rawId: string, context: RequestContext): Promise<RecipientRecord> {
    const recipient = await this.store.recipient(requireId(rawId), context.correlationId);
    if (recipient === null) throw new ApiError(404, 'not_found', 'That person is not in the list.');
    return recipient;
  }

  private async recipientsView(
    campaign: CampaignRecord,
    context: RequestContext,
  ): Promise<OutreachRecipientsView> {
    const [recipients, counts] = await Promise.all([
      this.store.recipients(campaign.id, context.correlationId),
      this.store.counts(context.correlationId),
    ]);
    const fresh = (await this.store.campaign(campaign.id, context.correlationId)) ?? campaign;
    return {
      campaign: campaignView(fresh, counts.get(campaign.id)),
      recipients: recipients.map(recipientView),
      postalAddressSet: this.postalAddress() !== '',
    };
  }

  private async readSettings(
    body: Body,
    current: CampaignRecord | null,
    context: RequestContext,
  ): Promise<{ settings: CampaignSettings; senderIds: string[] | null }> {
    const base: CampaignSettings = current ?? {
      languages: ['en'],
      senderPool: 'auto',
      dailyCap: 20,
      warmup: true,
      followupEnabled: false,
      followupDays: 4,
    };
    const settings: CampaignSettings = {
      languages: readLanguageList(body['languages'], base.languages),
      senderPool: readPool(body['senderPool'], base.senderPool),
      dailyCap: readInt(body['dailyCap'], 'dailyCap', 1, 20, base.dailyCap),
      warmup: readBool(body['warmup'], 'warmup', base.warmup),
      followupEnabled: readBool(body['followupEnabled'], 'followupEnabled', base.followupEnabled),
      followupDays: readInt(body['followupDays'], 'followupDays', 1, 30, base.followupDays),
    };
    let senderIds = readIds(body['senderIds'], 'senderIds');
    if (settings.senderPool === 'chosen') {
      const active = await this.store.activeSenders(context.correlationId);
      const ids =
        senderIds ??
        (current === null ? [] : await this.store.chosenSenders(current.id, context.correlationId));
      if (ids.length === 0) throw invalid('senderIds', 'Choose at least one sender.');
      if (ids.some((id) => !active.some((s) => s.id === id))) {
        throw invalid('senderIds', 'One of the senders is not active in E-mail people.');
      }
      senderIds = [...ids];
    } else if (senderIds !== null) {
      senderIds = [];
    } else if (current !== null && current.senderPool === 'chosen') {
      senderIds = [];
    }
    return { settings, senderIds };
  }

  /** The active senders a campaign may use: everyone, or its chosen ones. */
  private async poolSenders(
    pool: SenderPool,
    chosenIds: readonly string[] | null,
    campaign: CampaignRecord | null,
    context: RequestContext,
  ): Promise<readonly OutreachSender[]> {
    const active = await this.store.activeSenders(context.correlationId);
    if (pool === 'auto') return active;
    const ids =
      chosenIds ??
      (campaign === null ? [] : await this.store.chosenSenders(campaign.id, context.correlationId));
    return active.filter((s) => ids.includes(s.id));
  }

  private async planAll(
    campaign: CampaignRecord,
    rows: readonly Readonly<Record<string, string>>[],
    exceptId: string | null,
    context: RequestContext,
  ) {
    const [senders, known] = await Promise.all([
      this.poolSenders(campaign.senderPool, null, campaign, context),
      this.store.known(context.correlationId),
    ]);
    const others = known.rows.filter((row) => row.id !== exceptId);
    const hashes = rows
      .map((row) => (row['work_email'] ?? '').trim().toLowerCase())
      .filter((email) => email !== '')
      .map(outreachAddressHash);
    const suppressed = await this.store.suppressed(hashes, context.correlationId);
    return planOutreachImport(rows, {
      senders,
      postalAddressSet: this.postalAddress() !== '',
      knownHashes: new Set(others.map((row) => row.hash)),
      knownCompanies: new Set(others.map((row) => normaliseCompany(row.company))),
      languages: campaign.languages,
      suppressedHashes: suppressed,
    });
  }

  /** One person through the import's rules; a left-out row answers 400 with the reason. */
  private async plan(
    campaign: CampaignRecord,
    rows: readonly Record<string, string>[],
    exceptId: string | null,
    context: RequestContext,
  ) {
    const plan = await this.planAll(campaign, rows, exceptId, context);
    const [first] = plan.recipients;
    if (first === undefined) {
      const reason = Object.keys(plan.excluded)[0] ?? 'bad_email';
      throw new ApiError(400, 'validation_failed', 'This person cannot be written to.', [
        { field: 'person', message: reason },
      ]);
    }
    return [first] as const;
  }

  private sealed(id: string, campaignId: string, r: PlannedRecipient): RecipientInsert {
    return {
      id,
      campaignId,
      company: r.company,
      personName: r.personName,
      firstName: r.firstName,
      emailEnc: this.cipher.encrypt(r.email, { purpose: CIPHER_PURPOSE, ownerId: id }),
      emailHash: r.emailHash,
      country: r.country,
      timeZone: r.timeZone,
      language: r.language,
      senderPersonId: r.senderPersonId,
    };
  }

  private open(recipient: RecipientRecord): string {
    try {
      return this.cipher.decrypt(recipient.emailEnc, {
        purpose: CIPHER_PURPOSE,
        ownerId: recipient.id,
      });
    } catch {
      return '';
    }
  }

  private languageOf(campaign: CampaignRecord, raw: unknown): CampaignLanguage {
    if (isCampaignLanguage(raw) && campaign.languages.includes(raw)) return raw;
    return campaign.languages[0] ?? 'en';
  }

  private async render(
    campaign: CampaignRecord,
    body: Body,
    context: RequestContext,
  ): Promise<OutreachPreviewView & { senderId: string | null }> {
    const kind: CampaignEmailKind = body['kind'] === 'followup' ? 'followup' : 'intro';
    const language = this.languageOf(campaign, body['language']);
    const text = await this.textFor(campaign, kind, language, body, context);
    const problems = campaignTextProblems(text);
    let recipient: RecipientRecord | null = null;
    if (typeof body['recipientId'] === 'string' && body['recipientId'] !== '') {
      recipient = await this.recipientOrThrow(body['recipientId'], context);
      if (recipient.campaignId !== campaign.id) {
        throw new ApiError(404, 'not_found', 'That person is not in the list.');
      }
    }
    const senders = await this.poolSenders(campaign.senderPool, null, campaign, context);
    const pools = senderPools(senders);
    const sender =
      senders.find((s) => s.id === recipient?.senderPersonId) ??
      (language === 'ar' ? pools.ar[0] : pools.en[0]) ??
      senders[0] ??
      null;
    const senderName = (language === 'ar' ? sender?.nameAr : sender?.nameEn) ?? '';
    const links = campaignLinks(this.options.webPublicUrl, language, PREVIEW_TOKEN);
    const rendered = renderCampaignEmail({
      text: { subject: text.subject, body: text.body },
      language,
      values: {
        firstName: recipient?.firstName ?? SAMPLE.firstName,
        company: recipient?.company ?? SAMPLE.company,
        senderName,
        trialUrl: links.trialUrl,
        bookingUrl: links.bookingUrl,
      },
      country: recipient?.country ?? SAMPLE.country,
      postalAddress: this.postalAddress(),
    });
    const toAddress = recipient === null ? 'sam@example.com' : this.open(recipient);
    return {
      from: sender === null ? '' : `${sender.nameEn ?? ''} from TManage <${sender.address}>`.trim(),
      to: maskAddress(toAddress),
      subject: rendered.subject,
      text: rendered.text,
      recipientId: recipient?.id ?? null,
      problems,
      senderId: sender?.id ?? null,
    };
  }

  /** The draft in the body when it has one, else the newest saved text, else the default. */
  private async textFor(
    campaign: CampaignRecord,
    kind: CampaignEmailKind,
    language: CampaignLanguage,
    body: Body,
    context: RequestContext,
  ): Promise<CampaignEmailText> {
    if (typeof body['subject'] === 'string' || typeof body['body'] === 'string') {
      return {
        subject: typeof body['subject'] === 'string' ? body['subject'] : '',
        body: typeof body['body'] === 'string' ? body['body'] : '',
      };
    }
    const latest = await this.store.latestVersions(campaign.id, context.correlationId);
    const saved = latest.find((row) => row.kind === kind && row.language === language);
    return saved ?? DEFAULT_CAMPAIGN_EMAILS[kind][language] ?? { subject: '', body: '' };
  }

  private audit(
    actor: PlatformAdminActor,
    context: RequestContext,
    action: string,
    label: string,
    before: object | null,
    after: object,
  ) {
    return platformAuditFor(actor, context, {
      action,
      targetType: 'setting',
      targetId: null,
      targetLabel: label,
      reason: null,
      beforeJson: before === null ? null : JSON.stringify(before),
      // Ids and counts only: no address, no name of a recipient.
      afterJson: JSON.stringify(after),
    });
  }
}

/** Version 1 of a new campaign: the default text in every language that has one. */
function defaultVersions(
  languages: readonly CampaignLanguage[],
): Partial<Record<CampaignEmailKind, Partial<Record<CampaignLanguage, CampaignEmailText>>>> {
  const versions: Partial<
    Record<CampaignEmailKind, Partial<Record<CampaignLanguage, CampaignEmailText>>>
  > = {};
  for (const kind of CAMPAIGN_EMAIL_KINDS) {
    const texts: Partial<Record<CampaignLanguage, CampaignEmailText>> = {};
    for (const language of languages) {
      const text = DEFAULT_CAMPAIGN_EMAILS[kind][language];
      if (text !== undefined) texts[language] = text;
    }
    if (Object.keys(texts).length > 0) versions[kind] = texts;
  }
  return versions;
}

function settingsOf(campaign: CampaignRecord): CampaignSettings {
  return {
    languages: campaign.languages,
    senderPool: campaign.senderPool,
    dailyCap: campaign.dailyCap,
    warmup: campaign.warmup,
    followupEnabled: campaign.followupEnabled,
    followupDays: campaign.followupDays,
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

/** The add / change form as an import row (the import's rules then apply unchanged). */
function personRow(body: Body, existing: RecipientRecord | null): Record<string, string> {
  const str = (key: string): string | undefined =>
    typeof body[key] === 'string' ? (body[key] as string).trim() : undefined;
  const firstName = str('firstName');
  const personName =
    str('personName') ?? (firstName !== undefined ? firstName : (existing?.personName ?? ''));
  return {
    company: str('company') ?? existing?.company ?? '',
    country: str('country') ?? existing?.country ?? '',
    person_name: personName,
    work_email: (str('email') ?? '').toLowerCase(),
    language: str('language') ?? existing?.language ?? '',
    contact_type: 'named',
  };
}
