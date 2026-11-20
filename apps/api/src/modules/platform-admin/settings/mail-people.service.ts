import { CONTACT_EMAILS, uuidv7 } from '@tmanage/domain';
import { addressDomain, validateSenderAddress, validateSenderName } from '@tmanage/mail';
import type { MailDelivery, MailLoginCheck, Mailer } from '@tmanage/mail';
import {
  MAIL_PERSON_LANGUAGES,
  MAIL_PERSON_REGIONS,
  MAIL_PERSON_TOPICS,
} from '../../../common/database/schema.js';
import type {
  MailPersonLanguages,
  MailPersonRegion,
  MailPersonTopic,
} from '../../../common/database/schema.js';
import { ApiError } from '../../../common/http/errors.js';
import { requireId } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import type {
  MailPeopleRepository,
  MailPersonInput,
  MailPersonRecord,
} from './mail-people.repository.js';

/**
 * EMAILBUILD — the "E-mail people" card (platform settings): the TManage people who sign tips,
 * news and follow-ups. Platform admins only (the controller's guard, rechecked here by the actor
 * every write needs). Names and addresses are checked when saved (here) and again when used (the
 * sender resolver). Every add, change, switch-off, import and test send is audited.
 */

export const MAX_IMPORT_ROWS = 100;
const DOMAIN = addressDomain(CONTACT_EMAILS.hello);
const CSV_HEADER = 'name_en,name_ar,role_en,role_ar,address,languages,region,topic,active';

type Body = Readonly<Record<string, unknown>>;

const invalid = (field: string, message: string, detail: string): ApiError =>
  new ApiError(400, 'validation_failed', message, [{ field, message: detail }]);

function name(raw: unknown, field: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!validateSenderName(value)) {
    throw invalid(field, 'Use a short name without quotes, brackets or commas.', 'name, 1-80');
  }
  return value;
}

function oneOf<T extends string>(raw: unknown, list: readonly T[], field: string): T {
  if (typeof raw !== 'string' || !(list as readonly string[]).includes(raw)) {
    throw invalid(field, 'Choose one of the listed values.', list.join(', '));
  }
  return raw as T;
}

function address(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!validateSenderAddress(value, DOMAIN)) {
    throw invalid('address', `The address must end in @${DOMAIN}`, `a mailbox on ${DOMAIN}`);
  }
  return value;
}

/** A person from a body or a CSV row. Pure; every refusal is a 400 with nothing written. */
export function parseMailPerson(body: Body): MailPersonInput {
  const active = body['active'];
  return {
    nameEn: name(body['nameEn'], 'nameEn'),
    nameAr: name(body['nameAr'], 'nameAr'),
    roleEn: name(body['roleEn'], 'roleEn'),
    roleAr: name(body['roleAr'], 'roleAr'),
    address: address(body['address']),
    languages: oneOf<MailPersonLanguages>(body['languages'], MAIL_PERSON_LANGUAGES, 'languages'),
    region: oneOf<MailPersonRegion>(body['region'], MAIL_PERSON_REGIONS, 'region'),
    topic: oneOf<MailPersonTopic>(body['topic'], MAIL_PERSON_TOPICS, 'topic'),
    active: active === undefined ? true : active === true,
  };
}

/** The import file: the fixed header, then at most 100 rows. Pure. */
export function parseMailPeopleCsv(raw: unknown): MailPersonInput[] {
  if (typeof raw !== 'string') throw invalid('csv', 'Paste or upload the list.', 'CSV text');
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines[0]?.replace(/\s+/gu, '') !== CSV_HEADER) {
    throw invalid('csv', 'The first line must be the column names of the template.', CSV_HEADER);
  }
  const rows = lines.slice(1);
  if (rows.length === 0 || rows.length > MAX_IMPORT_ROWS) {
    throw invalid('csv', `Import 1 to ${MAX_IMPORT_ROWS} people at a time.`, 'rows');
  }
  return rows.map((line, index) => {
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length !== 9) {
      throw invalid('csv', `Line ${index + 2} does not have nine columns.`, 'columns');
    }
    const [nameEn, nameAr, roleEn, roleAr, mailbox, languages, region, topic, active] = cells;
    try {
      return parseMailPerson({
        nameEn,
        nameAr,
        roleEn,
        roleAr,
        address: mailbox,
        languages,
        region,
        topic,
        active: active === 'yes' || active === 'true' || active === '1',
      });
    } catch (error) {
      if (error instanceof ApiError) {
        throw invalid('csv', `Line ${index + 2}: ${error.message}`, 'row');
      }
      throw error;
    }
  });
}

/** MAILSTATUS (ADR-0013). One role mailbox's login state, as the card shows it (no value). */
export interface MailboxLoginView {
  readonly mailbox: 'noreply' | 'hello' | 'support' | 'security';
  readonly address: string | null;
  readonly state: 'ok' | 'login_refused' | 'unreachable' | 'not_configured';
}

export interface MailPeopleView {
  readonly people: readonly MailPersonRecord[];
  /** MAILSTATUS. Each role mailbox's login state; `null` when mail does not go out over SMTP. */
  readonly mailboxes: readonly MailboxLoginView[] | null;
}

/**
 * PERSONMAIL (ADR-0013). Which mailbox a test (and every tip from this person) leaves through:
 * `own_mailbox` (signed in as the person's own address with the shared SMTP_PASSWORD), or `none`
 * (no shared password: person mail is not sent at all, never from another mailbox in their name).
 */
export type MailPersonRoute = 'own_mailbox' | 'none';

export interface MailPersonTestView {
  readonly sent: boolean;
  readonly route: MailPersonRoute;
  /** The person's mailbox address, so the card can say where it came from. */
  readonly address: string;
}

export interface MailPeopleServiceOptions {
  readonly mailer: Mailer | null;
  /** PERSONMAIL. Whether person mail signs in as the person (SMTP driver with SMTP_PASSWORD). */
  readonly personMailConfigured: boolean;
  /** MAILSTATUS. The role mailboxes' login check; `null` = not SMTP. */
  readonly loginCheck?: Pick<MailLoginCheck, 'status'> | null | undefined;
}

const duplicate = () =>
  new ApiError(409, 'conflict', 'This address is already in the list', [
    { field: 'address', message: 'already in the list' },
  ]);

export class MailPeopleService {
  constructor(
    private readonly repository: MailPeopleRepository,
    private readonly options: MailPeopleServiceOptions,
  ) {}

  async list(context: RequestContext): Promise<MailPeopleView> {
    const check = this.options.loginCheck ?? null;
    const [people, status] = await Promise.all([
      this.repository.list(context.correlationId),
      // A check that cannot run is "no reading", never a failed list.
      check === null ? null : check.status().catch(() => null),
    ]);
    return {
      people,
      mailboxes:
        status === null
          ? null
          : status.mailboxes.map(({ mailbox, address, state }) => ({ mailbox, address, state })),
    };
  }

  async create(actor: PlatformAdminActor, body: Body, context: RequestContext) {
    const input = parseMailPerson(body ?? {});
    if ((await this.repository.taken([input.address], context.correlationId)).length > 0) {
      throw duplicate();
    }
    const row: MailPersonRecord = { id: uuidv7(), ...input };
    await this.repository.insert(
      [row],
      platformAuditFor(actor, context, {
        action: 'platform.mail_person_added',
        targetType: 'setting',
        targetId: null,
        targetLabel: row.address,
        reason: null,
        beforeJson: null,
        afterJson: JSON.stringify(row),
      }),
    );
    return this.list(context);
  }

  async update(actor: PlatformAdminActor, rawId: string, body: Body, context: RequestContext) {
    const id = requireId(rawId);
    const before = await this.repository.byId(id, context.correlationId);
    if (before === null) throw new ApiError(404, 'not_found', 'That person is not in the list.');
    const input = parseMailPerson({ ...toBody(before), ...(body ?? {}) });
    if (
      input.address !== before.address &&
      (await this.repository.taken([input.address], context.correlationId)).length > 0
    ) {
      throw duplicate();
    }
    const after: MailPersonRecord = { id, ...input };
    await this.repository.update(
      after,
      platformAuditFor(actor, context, {
        action:
          before.active && !after.active
            ? 'platform.mail_person_switched_off'
            : 'platform.mail_person_updated',
        targetType: 'setting',
        targetId: null,
        targetLabel: after.address,
        reason: null,
        beforeJson: JSON.stringify(before),
        afterJson: JSON.stringify(after),
      }),
    );
    return this.list(context);
  }

  async importCsv(actor: PlatformAdminActor, body: Body, context: RequestContext) {
    const inputs = parseMailPeopleCsv(body?.['csv']);
    const addresses = inputs.map((input) => input.address);
    if (new Set(addresses).size !== addresses.length) throw duplicate();
    if ((await this.repository.taken(addresses, context.correlationId)).length > 0) {
      throw duplicate();
    }
    const rows = inputs.map((input) => ({ id: uuidv7(), ...input }));
    await this.repository.insert(
      rows,
      platformAuditFor(actor, context, {
        action: 'platform.mail_people_imported',
        targetType: 'setting',
        targetId: null,
        targetLabel: `${String(rows.length)} people`,
        reason: null,
        beforeJson: null,
        afterJson: JSON.stringify(addresses),
      }),
    );
    return this.list(context);
  }

  /** "Send test": one tip-shaped mail signed by this person, to the acting admin only. */
  async sendTest(
    actor: PlatformAdminActor,
    rawId: string,
    body: Body,
    context: RequestContext,
  ): Promise<MailPersonTestView> {
    const id = requireId(rawId);
    const person = await this.repository.byId(id, context.correlationId);
    if (person === null) throw new ApiError(404, 'not_found', 'That person is not in the list.');
    const language = body?.['language'] === 'ar' ? 'ar' : 'en';
    // PERSONMAIL: the route the router takes for this person (ADR-0013). A login the mailbox
    // refuses at send time makes the test fail (`sent: false`); it never leaves from elsewhere.
    const route: MailPersonRoute = this.options.personMailConfigured ? 'own_mailbox' : 'none';
    let delivery: MailDelivery | 'failed' = 'none';
    if (this.options.mailer !== null) {
      try {
        delivery = await this.options.mailer.send({
          to: actor.account.email,
          templateKey: 'tip',
          language,
          personRef: { kind: 'test', personId: id },
          subject: language === 'ar' ? 'رسالة تجربة من TManage' : 'A test e-mail from TManage',
          text:
            language === 'ar'
              ? 'هذه رسالة تجربة تُظهر كيف تصل النصائح بهذا الاسم.\n\n[[tm.sign.by]]\n[[tm.sign.note]]'
              : 'This test shows how tips signed by this person arrive.\n\n[[tm.sign.by]]\n[[tm.sign.note]]',
        });
      } catch {
        delivery = 'failed';
      }
    }
    await this.repository.audit(
      platformAuditFor(actor, context, {
        action: 'platform.mail_person_test_sent',
        targetType: 'setting',
        targetId: null,
        targetLabel: person.address,
        reason: null,
        beforeJson: null,
        afterJson: JSON.stringify({ delivery, route }),
      }),
    );
    return { sent: delivery === 'sent', route, address: person.address };
  }
}

function toBody(row: MailPersonRecord): Body {
  return {
    nameEn: row.nameEn,
    nameAr: row.nameAr,
    roleEn: row.roleEn,
    roleAr: row.roleAr,
    address: row.address,
    languages: row.languages,
    region: row.region,
    topic: row.topic,
    active: row.active,
  };
}
