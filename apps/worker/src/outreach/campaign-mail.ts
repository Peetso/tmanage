import { DEFAULT_CAMPAIGN_EMAILS, campaignMailLanguage, renderCampaignEmail } from '@tmanage/mail';
import type {
  CampaignEmailKind,
  CampaignEmailText,
  CampaignLanguage,
  MailMessage,
} from '@tmanage/mail';

/**
 * LANE-Q / OUTREACH MANAGER — the outreach mail as it leaves the worker. The text is the platform
 * admin's newest saved version (`outreach_email_versions`), or the owner-approved default
 * (EMAIL-DRAFT-v1, `DEFAULT_CAMPAIGN_EMAILS` in @tmanage/mail) for a campaign that has none. Both
 * the API preview and this send render through `renderCampaignEmail`, so the preview is the mail.
 *
 * - Greeting with the person's first name (every imported row has one; no "Hi there").
 * - A US recipient also gets the postal address from CAMPAIGN_POSTAL_ADDRESS (CAN-SPAM); nobody
 *   else gets an address line (owner 2026-11-23). The renderer adds it; the text cannot drop it.
 * - The unsubscribe is the fixed personal last line; the sender resolver fills the link token with
 *   the signed one-click link and stamps the RFC 8058 List-Unsubscribe headers (ADR-0013).
 * - Replies go to the sender's own mailbox (the resolver's person identity).
 * - No tracking pixel, no HTML, two links: the personal trial link and the walkthrough page.
 */

export interface CampaignMailInput {
  readonly to: string;
  readonly language: CampaignLanguage;
  readonly firstName: string;
  readonly company: string;
  /** The sender as the registry names them (first name; the registry holds no surname). */
  readonly senderName: string;
  readonly senderPersonId: string;
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
  readonly postalAddress: string;
  readonly trialUrl: string;
  readonly bookingUrl: string;
}

export interface CampaignMailText {
  readonly kind: CampaignEmailKind;
  readonly text: CampaignEmailText;
}

const TEMPLATE_KEY: Readonly<Record<CampaignEmailKind, string>> = {
  intro: 'campaign_intro',
  followup: 'campaign_followup',
};

/** One campaign mail (introduction or follow-up), ready for the sender resolver (person mail). */
export function composeCampaignMail(input: CampaignMailInput, mail: CampaignMailText): MailMessage {
  const rendered = renderCampaignEmail({
    text: mail.text,
    language: input.language,
    values: {
      firstName: input.firstName,
      company: input.company,
      senderName: input.senderName,
      trialUrl: input.trialUrl,
      bookingUrl: input.bookingUrl,
    },
    country: input.country,
    postalAddress: input.postalAddress,
  });
  return {
    to: input.to,
    subject: rendered.subject,
    text: rendered.text,
    templateKey: TEMPLATE_KEY[mail.kind],
    language: campaignMailLanguage(input.language),
    personRef: { kind: 'campaign', personId: input.senderPersonId },
    optional: true,
  };
}

/** The introduction with the default text (English or Arabic; any other language gets English). */
export function composeCampaignIntro(input: CampaignMailInput): MailMessage {
  const text = DEFAULT_CAMPAIGN_EMAILS.intro[input.language] ?? DEFAULT_CAMPAIGN_EMAILS.intro.en;
  if (text === undefined) throw new Error('The default introduction is missing.');
  return composeCampaignMail(input, { kind: 'intro', text });
}

/** The two links (shared with the API preview, so the preview shows them as sent). */
export { campaignLinks } from '@tmanage/mail';
