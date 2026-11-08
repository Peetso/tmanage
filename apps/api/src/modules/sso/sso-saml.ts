import {
  X509Certificate,
  createHash,
  createHmac,
  createVerify,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { constantTimeEquals } from '../identity/session-token.js';
import {
  XmlRejectedError,
  childElements,
  descendants,
  exclusiveCanonicalize,
  hasCommentOrInstruction,
  parseStrictXml,
  type XmlElement,
} from './saml-xml.js';
import { emailDomain, type SsoClaims } from './sso-oidc.js';

/**
 * 54-15 — company sign-in over SAML 2.0, the protocol half (no database, no network).
 *
 * - **SP-initiated only.** The AuthnRequest goes out over HTTP-Redirect (unsigned; the SP
 *   metadata says so); the IdP answers with an HTTP-POST Response at the ACS. An unsolicited
 *   (IdP-initiated) Response has no InResponseTo and is refused.
 * - **The flow cookie** holds the organization, the request ID and the RelayState, signed with
 *   `SESSION_SECRET` under its own purpose string. The request ID is also stored server-side
 *   (`sso_saml_requests`) and consumed once.
 * - **Response verification** ({@link verifySamlResponse}): exactly one Assertion, a direct child
 *   of the Response, no EncryptedAssertion; its own enveloped signature (RSA-SHA256 over Exclusive
 *   C14N of SignedInfo, one Reference to the Assertion's ID with SHA-256, the ID unique in the
 *   document) checked against the certificate the owner saved — never one carried in the message.
 *   Everything consumed afterwards is read from that same verified element, so a wrapped copy
 *   elsewhere in the document has nothing to offer. Then Issuer, Audience, Recipient and
 *   InResponseTo, NotBefore/NotOnOrAfter with two minutes of skew, and an e-mail address.
 */

export const SAML_ACS_PATH = '/v1/auth/sso/saml/acs';
export const SAML_METADATA_PATH = '/v1/auth/sso/saml/metadata';
export const SAML_FLOW_COOKIE = 'tm_saml_flow';
export const SAML_FLOW_TTL_SECONDS = 600;
export const SAML_CLOCK_SKEW_MS = 2 * 60 * 1000;
const FLOW_PURPOSE = 'sso-saml-flow.v1';
const MAX_RESPONSE_CHARS = 400 * 1024;

export const NS = {
  protocol: 'urn:oasis:names:tc:SAML:2.0:protocol',
  assertion: 'urn:oasis:names:tc:SAML:2.0:assertion',
  metadata: 'urn:oasis:names:tc:SAML:2.0:metadata',
  dsig: 'http://www.w3.org/2000/09/xmldsig#',
  excC14n: 'http://www.w3.org/2001/10/xml-exc-c14n#',
} as const;

export const ALG = {
  excC14n: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  enveloped: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
  rsaSha256: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  sha256: 'http://www.w3.org/2001/04/xmlenc#sha256',
} as const;

const BINDING_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const BINDING_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';
const NAMEID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'emailaddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
];
const NAME_ATTRIBUTES = [
  'displayname',
  'name',
  'http://schemas.microsoft.com/identity/claims/displayname',
  'urn:oid:2.16.840.1.113730.3.1.241',
];

export type SamlRejection =
  | 'malformed'
  | 'status'
  | 'unsigned'
  | 'wrapped'
  | 'unsupported_algorithm'
  | 'bad_digest'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'wrong_recipient'
  | 'wrong_request'
  | 'not_yet_valid'
  | 'expired'
  | 'no_email'
  | 'replayed';

export class SamlRejectedError extends Error {
  override name = 'SamlRejectedError';
  constructor(readonly reason: SamlRejection) {
    super(`SAML response rejected: ${reason}`);
  }
}

function reject(reason: SamlRejection): never {
  throw new SamlRejectedError(reason);
}

// ── Certificates and IdP metadata ────────────────────────────────────────────

export interface SamlCertificateInfo {
  readonly fingerprint: string;
  readonly expiresAt: string;
}

/**
 * A PEM or bare base64 X.509 certificate with an RSA key of at least 2048 bits, as bare base64
 * DER; null when it is not one.
 */
export function normalizeCertificate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 20_000) return null;
  const body = value.replace(/-----(BEGIN|END) CERTIFICATE-----/gu, '').replace(/\s+/gu, '');
  if (body === '' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(body)) return null;
  try {
    const certificate = new X509Certificate(Buffer.from(body, 'base64'));
    const key = certificate.publicKey;
    if (key.asymmetricKeyType !== 'rsa') return null;
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return null;
    return certificate.raw.toString('base64');
  } catch {
    return null;
  }
}

export function certificateInfo(base64Der: string): SamlCertificateInfo | null {
  try {
    const certificate = new X509Certificate(Buffer.from(base64Der, 'base64'));
    return {
      fingerprint: certificate.fingerprint256,
      expiresAt: new Date(certificate.validTo).toISOString(),
    };
  } catch {
    return null;
  }
}

/** An `https:` URL (query allowed, no credentials or fragment); null when unusable. */
export function normalizeSsoUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1000) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export interface SamlIdpSettings {
  readonly entityId: string;
  readonly ssoUrl: string;
  readonly certificate: string;
}

/**
 * The IdP's entity ID, HTTP-Redirect SSO URL and signing certificate from its metadata XML; null
 * when the document does not hold all three. The metadata is pasted by the owner, so its own
 * signature (if any) is not what makes it trusted.
 */
export function parseIdpMetadata(xml: unknown): SamlIdpSettings | null {
  if (typeof xml !== 'string') return null;
  let root: XmlElement;
  try {
    root = parseStrictXml(xml.trim());
  } catch {
    return null;
  }
  let entity = root;
  if (root.namespaceURI === NS.metadata && root.localName === 'EntitiesDescriptor') {
    const entities = childElements(root, NS.metadata, 'EntityDescriptor');
    if (entities.length !== 1) return null;
    entity = entities[0]!;
  }
  if (entity.namespaceURI !== NS.metadata || entity.localName !== 'EntityDescriptor') return null;
  const entityId = (entity.getAttribute('entityID') ?? '').trim();
  const descriptors = childElements(entity, NS.metadata, 'IDPSSODescriptor');
  if (entityId === '' || descriptors.length !== 1) return null;
  const descriptor = descriptors[0]!;
  const service = childElements(descriptor, NS.metadata, 'SingleSignOnService').find(
    (s) => s.getAttribute('Binding') === BINDING_REDIRECT,
  );
  const ssoUrl = normalizeSsoUrl(service?.getAttribute('Location'));
  const signing = childElements(descriptor, NS.metadata, 'KeyDescriptor').filter((k) => {
    const use = k.getAttribute('use');
    return use === null || use === 'signing';
  });
  let certificate: string | null = null;
  for (const key of signing) {
    const holder = descendants(key).find(
      (e) => e.namespaceURI === NS.dsig && e.localName === 'X509Certificate',
    );
    certificate = normalizeCertificate(holder?.textContent);
    if (certificate) break;
  }
  if (!ssoUrl || !certificate) return null;
  return { entityId, ssoUrl, certificate };
}

// ── Flow cookie and AuthnRequest ─────────────────────────────────────────────

export interface SamlFlow {
  readonly organizationId: string;
  readonly requestId: string;
  readonly relayState: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

export function newSamlFlow(organizationId: string, nowSeconds: number): SamlFlow {
  return {
    organizationId,
    // An xs:ID must not start with a digit.
    requestId: `_${randomBytes(20).toString('hex')}`,
    relayState: randomBytes(24).toString('base64url'),
    expiresAt: nowSeconds + SAML_FLOW_TTL_SECONDS,
  };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${FLOW_PURPOSE}.${payload}`).digest('base64url');
}

export function sealSamlFlow(flow: SamlFlow, secret: string): string {
  const payload = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function openSamlFlow(
  raw: string | undefined,
  secret: string,
  nowSeconds: number,
): SamlFlow | undefined {
  if (!raw) return undefined;
  const [payload, signature, ...rest] = raw.split('.');
  if (!payload || !signature || rest.length > 0) return undefined;
  if (!constantTimeEquals(signature, sign(payload, secret))) return undefined;
  let value: Partial<SamlFlow>;
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<SamlFlow>;
  } catch {
    return undefined;
  }
  if (
    typeof value.organizationId !== 'string' ||
    typeof value.requestId !== 'string' ||
    typeof value.relayState !== 'string' ||
    typeof value.expiresAt !== 'number' ||
    value.expiresAt < nowSeconds
  ) {
    return undefined;
  }
  return value as SamlFlow;
}

export function samlRelayStateMatches(flow: SamlFlow, returned: unknown): boolean {
  return (
    typeof returned === 'string' && returned !== '' && constantTimeEquals(flow.relayState, returned)
  );
}

const xmlAttr = (value: string): string =>
  value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');

/** The IdP URL carrying the deflated AuthnRequest and the RelayState (HTTP-Redirect binding). */
export function samlAuthnRequestUrl(input: {
  readonly ssoUrl: string;
  readonly spEntityId: string;
  readonly acsUrl: string;
  readonly flow: SamlFlow;
  readonly issueInstant: Date;
}): string {
  const request =
    `<samlp:AuthnRequest xmlns:samlp="${NS.protocol}" xmlns:saml="${NS.assertion}"` +
    ` ID="${xmlAttr(input.flow.requestId)}" Version="2.0"` +
    ` IssueInstant="${input.issueInstant.toISOString()}"` +
    ` Destination="${xmlAttr(input.ssoUrl)}"` +
    ` AssertionConsumerServiceURL="${xmlAttr(input.acsUrl)}" ProtocolBinding="${BINDING_POST}">` +
    `<saml:Issuer>${xmlAttr(input.spEntityId)}</saml:Issuer>` +
    `<samlp:NameIDPolicy Format="${NAMEID_EMAIL}" AllowCreate="true"/>` +
    `</samlp:AuthnRequest>`;
  const url = new URL(input.ssoUrl);
  url.searchParams.set(
    'SAMLRequest',
    deflateRawSync(Buffer.from(request, 'utf8')).toString('base64'),
  );
  url.searchParams.set('RelayState', input.flow.relayState);
  return url.toString();
}

/** The SP metadata the owner gives the IdP. */
export function samlSpMetadata(input: {
  readonly entityId: string;
  readonly acsUrl: string;
}): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<md:EntityDescriptor xmlns:md="${NS.metadata}" entityID="${xmlAttr(input.entityId)}">` +
    `<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"` +
    ` protocolSupportEnumeration="${NS.protocol}">` +
    `<md:NameIDFormat>${NAMEID_EMAIL}</md:NameIDFormat>` +
    `<md:AssertionConsumerService Binding="${BINDING_POST}" Location="${xmlAttr(input.acsUrl)}"` +
    ` index="0" isDefault="true"/>` +
    `</md:SPSSODescriptor></md:EntityDescriptor>\n`
  );
}

// ── Response verification ────────────────────────────────────────────────────

export interface VerifiedSamlAssertion {
  readonly assertionId: string;
  /** When the replay-cache entry may go: the latest validity bound, plus the skew. */
  readonly rememberUntil: Date;
  readonly claims: SsoClaims;
}

function only(parent: XmlElement, ns: string, local: string, missing: SamlRejection): XmlElement {
  const found = childElements(parent, ns, local);
  if (found.length !== 1) reject(found.length === 0 ? missing : 'malformed');
  return found[0]!;
}

function optional(parent: XmlElement, ns: string, local: string): XmlElement | undefined {
  const found = childElements(parent, ns, local);
  if (found.length > 1) reject('malformed');
  return found[0];
}

const text = (element: XmlElement | undefined): string => (element?.textContent ?? '').trim();

function strictBase64(value: string): Buffer {
  const compact = value.replace(/\s+/gu, '');
  if (compact === '' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) reject('malformed');
  return Buffer.from(compact, 'base64');
}

function instant(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u.test(value)) reject('malformed');
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) reject('malformed');
  return ms;
}

function inclusivePrefixes(transform: XmlElement): string[] {
  const list = optional(transform, NS.excC14n, 'InclusiveNamespaces');
  const raw = list?.getAttribute('PrefixList') ?? '';
  return raw.split(/\s+/u).filter((p) => p !== '');
}

/** The assertion's enveloped signature, checked against the configured certificate. */
function verifyAssertionSignature(
  document: XmlElement,
  assertion: XmlElement,
  certificate: string,
): void {
  const signatures = childElements(assertion, NS.dsig, 'Signature');
  if (signatures.length === 0) reject('unsigned');
  if (signatures.length > 1) reject('wrapped');
  const signature = signatures[0]!;
  const signedInfo = only(signature, NS.dsig, 'SignedInfo', 'unsigned');
  const c14n = only(signedInfo, NS.dsig, 'CanonicalizationMethod', 'malformed');
  const method = only(signedInfo, NS.dsig, 'SignatureMethod', 'malformed');
  if (c14n.getAttribute('Algorithm') !== ALG.excC14n) reject('unsupported_algorithm');
  if (method.getAttribute('Algorithm') !== ALG.rsaSha256) reject('unsupported_algorithm');

  const references = childElements(signedInfo, NS.dsig, 'Reference');
  if (references.length !== 1) reject('wrapped');
  const reference = references[0]!;
  const id = assertion.getAttribute('ID');
  if (!id || reference.getAttribute('URI') !== `#${id}`) reject('wrapped');
  // The referenced ID must name this element and no other one in the whole document.
  const holders = descendants(document).filter(
    (e) =>
      e.getAttribute('ID') === id || e.getAttribute('Id') === id || e.getAttribute('id') === id,
  );
  if (holders.length !== 1 || holders[0] !== assertion) reject('wrapped');

  const transformsParent = only(reference, NS.dsig, 'Transforms', 'malformed');
  const transforms = childElements(transformsParent, NS.dsig, 'Transform');
  if (
    transforms.length !== 2 ||
    transforms[0]!.getAttribute('Algorithm') !== ALG.enveloped ||
    transforms[1]!.getAttribute('Algorithm') !== ALG.excC14n
  ) {
    reject('unsupported_algorithm');
  }
  const digestMethod = only(reference, NS.dsig, 'DigestMethod', 'malformed');
  if (digestMethod.getAttribute('Algorithm') !== ALG.sha256) reject('unsupported_algorithm');
  const expectedDigest = strictBase64(text(only(reference, NS.dsig, 'DigestValue', 'malformed')));

  const canonical = exclusiveCanonicalize(assertion, {
    exclude: signature,
    inclusivePrefixes: inclusivePrefixes(transforms[1]!),
  });
  const digest = createHash('sha256').update(canonical, 'utf8').digest();
  if (digest.length !== expectedDigest.length || !timingSafeEqual(digest, expectedDigest)) {
    reject('bad_digest');
  }

  const signatureValue = strictBase64(text(only(signature, NS.dsig, 'SignatureValue', 'unsigned')));
  const signedCanonical = exclusiveCanonicalize(signedInfo, {
    inclusivePrefixes: inclusivePrefixes(c14n),
  });
  let valid = false;
  try {
    const key = new X509Certificate(Buffer.from(certificate, 'base64')).publicKey;
    valid = createVerify('RSA-SHA256').update(signedCanonical, 'utf8').verify(key, signatureValue);
  } catch {
    valid = false;
  }
  if (!valid) reject('bad_signature');
}

function attributeValues(statement: XmlElement | undefined, names: readonly string[]): string[] {
  if (!statement) return [];
  const out: string[] = [];
  for (const attribute of childElements(statement, NS.assertion, 'Attribute')) {
    const name = (attribute.getAttribute('Name') ?? '').toLowerCase();
    if (!names.includes(name)) continue;
    for (const value of childElements(attribute, NS.assertion, 'AttributeValue')) {
      if (text(value) !== '') out.push(text(value));
    }
  }
  return out;
}

/** Verify a base64 `SAMLResponse` posted to the ACS. Throws {@link SamlRejectedError}. */
export function verifySamlResponse(input: {
  readonly samlResponse: unknown;
  readonly idpEntityId: string;
  readonly certificate: string;
  readonly spEntityId: string;
  readonly acsUrl: string;
  readonly requestId: string;
  readonly nowMs: number;
}): VerifiedSamlAssertion {
  if (typeof input.samlResponse !== 'string' || input.samlResponse.length > MAX_RESPONSE_CHARS) {
    return reject('malformed');
  }
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(strictBase64(input.samlResponse));
  } catch (error) {
    if (error instanceof SamlRejectedError) throw error;
    return reject('malformed');
  }
  let root: XmlElement;
  try {
    root = parseStrictXml(xml);
  } catch (error) {
    if (error instanceof XmlRejectedError) return reject('malformed');
    throw error;
  }
  if (root.namespaceURI !== NS.protocol || root.localName !== 'Response') reject('malformed');
  if (root.getAttribute('Version') !== '2.0') reject('malformed');

  // Exactly one assertion in the whole document, directly under the Response; none encrypted.
  const all = descendants(root);
  const assertions = all.filter(
    (e) => e.namespaceURI === NS.assertion && e.localName === 'Assertion',
  );
  if (all.some((e) => e.namespaceURI === NS.assertion && e.localName === 'EncryptedAssertion')) {
    reject('malformed');
  }
  if (assertions.length > 1) reject('wrapped');
  const direct = childElements(root, NS.assertion, 'Assertion');
  if (direct.length !== 1 || assertions[0] !== direct[0]) {
    reject(assertions.length === 0 ? 'malformed' : 'wrapped');
  }
  const assertion = direct[0]!;
  // 56-10s: a comment or PI inside the assertion is invisible to the digest but splits its text.
  if (hasCommentOrInstruction(assertion)) reject('malformed');

  // Status and the Response's own claims, when present.
  const status = only(root, NS.protocol, 'Status', 'malformed');
  const code = only(status, NS.protocol, 'StatusCode', 'malformed');
  if (code.getAttribute('Value') !== STATUS_SUCCESS) reject('status');
  const destination = root.getAttribute('Destination');
  if (destination !== null && destination !== input.acsUrl) reject('wrong_recipient');
  const responseInReplyTo = root.getAttribute('InResponseTo');
  if (responseInReplyTo !== input.requestId) reject('wrong_request');
  const responseIssuer = optional(root, NS.assertion, 'Issuer');
  if (responseIssuer && text(responseIssuer) !== input.idpEntityId) reject('wrong_issuer');

  // The signature first: nothing below is read from an element that is not the verified one.
  verifyAssertionSignature(root, assertion, input.certificate);

  if (assertion.getAttribute('Version') !== '2.0') reject('malformed');
  if (text(only(assertion, NS.assertion, 'Issuer', 'wrong_issuer')) !== input.idpEntityId) {
    reject('wrong_issuer');
  }

  const now = input.nowMs;
  const skew = SAML_CLOCK_SKEW_MS;
  const conditions = only(assertion, NS.assertion, 'Conditions', 'wrong_audience');
  const notBefore = instant(conditions.getAttribute('NotBefore'));
  const notOnOrAfter = instant(conditions.getAttribute('NotOnOrAfter'));
  if (notBefore !== null && notBefore - skew > now) reject('not_yet_valid');
  if (notOnOrAfter !== null && notOnOrAfter + skew <= now) reject('expired');
  const restrictions = childElements(conditions, NS.assertion, 'AudienceRestriction');
  if (
    restrictions.length === 0 ||
    !restrictions.every((r) =>
      childElements(r, NS.assertion, 'Audience').some((a) => text(a) === input.spEntityId),
    )
  ) {
    reject('wrong_audience');
  }

  const subject = only(assertion, NS.assertion, 'Subject', 'malformed');
  const confirmations = childElements(subject, NS.assertion, 'SubjectConfirmation').filter(
    (c) => c.getAttribute('Method') === BEARER,
  );
  if (confirmations.length !== 1) reject('wrong_recipient');
  const data = only(confirmations[0]!, NS.assertion, 'SubjectConfirmationData', 'wrong_recipient');
  if (data.getAttribute('Recipient') !== input.acsUrl) reject('wrong_recipient');
  if (data.getAttribute('InResponseTo') !== input.requestId) reject('wrong_request');
  const confirmBefore = instant(data.getAttribute('NotOnOrAfter'));
  if (confirmBefore === null) reject('expired');
  if (confirmBefore! + skew <= now) reject('expired');
  const confirmAfter = instant(data.getAttribute('NotBefore'));
  if (confirmAfter !== null && confirmAfter - skew > now) reject('not_yet_valid');

  const nameId = optional(subject, NS.assertion, 'NameID');
  const nameIdText = text(nameId);
  const statement = optional(assertion, NS.assertion, 'AttributeStatement');
  const fromNameId =
    nameId?.getAttribute('Format') === NAMEID_EMAIL && emailDomain(nameIdText) ? nameIdText : null;
  const email =
    fromNameId ??
    attributeValues(statement, EMAIL_ATTRIBUTES).find((v) => emailDomain(v) !== null) ??
    (emailDomain(nameIdText) ? nameIdText : null);
  if (!email) return reject('no_email');
  const name = attributeValues(statement, NAME_ATTRIBUTES)[0] ?? '';

  const latest = Math.max(confirmBefore!, notOnOrAfter ?? 0);
  return {
    assertionId: assertion.getAttribute('ID')!,
    rememberUntil: new Date(latest + skew),
    claims: {
      subject: nameIdText || email.toLowerCase(),
      email: email.trim().toLowerCase(),
      name: name.trim(),
    },
  };
}
