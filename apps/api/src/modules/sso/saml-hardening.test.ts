import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { descendants, exclusiveCanonicalize, parseStrictXml } from './saml-xml.js';
import { ALG, NS, newSamlFlow, verifySamlResponse } from './sso-saml.js';
import { SsoService, type SsoServiceDeps } from './sso.service.js';

/**
 * 56-10s — SAML hardening corpus. Every fixture is real XML signed here with a fresh RSA key and
 * a self-signed certificate (enveloped signature, Exclusive C14N, RSA-SHA256 unless a case says
 * otherwise); the attacks then edit the signed text the way the published XSW and comment-
 * injection attacks do. The c14n edge cases at the end compare against spec-derived strings, so
 * they do not lean on the canonicalizer that also signs the fixtures.
 */

const IDP = 'https://idp.northstar.example/saml';
const SP = 'https://app.example/v1/auth/sso/saml/metadata';
const ACS = 'https://app.example/v1/auth/sso/saml/acs';
const NOW = Date.parse('2026-11-08T10:00:00Z');
const ORG = '0190f0a0-0000-7000-8000-000000000001';
const XS = 'http://www.w3.org/2001/XMLSchema';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const SHA1_DIGEST = 'http://www.w3.org/2000/09/xmldsig#sha1';
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';

const der = (tag: number, body: readonly number[]): number[] => {
  const n = body.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  return [tag, ...len, ...body];
};
const RSA_SHA256_OID = der(0x30, [...der(0x06, [42, 134, 72, 134, 247, 13, 1, 1, 11]), 5, 0]);
const CN = der(0x30, der(0x31, der(0x30, [...der(0x06, [85, 4, 3]), ...der(0x0c, [0x74])])));
function certificateFor(publicKey: KeyObject, privateKey: KeyObject): string {
  const time = (s: string) => der(0x17, [...Buffer.from(s)]);
  const tbs = der(0x30, [
    ...der(0xa0, der(0x02, [2])),
    ...der(0x02, [1]),
    ...RSA_SHA256_OID,
    ...CN,
    ...der(0x30, [...time('250101000000Z'), ...time('351231000000Z')]),
    ...CN,
    ...publicKey.export({ type: 'spki', format: 'der' }),
  ]);
  const signature = createSign('RSA-SHA256').update(Uint8Array.from(tbs)).sign(privateKey);
  const cert = der(0x30, [...tbs, ...RSA_SHA256_OID, ...der(0x03, [0, ...signature])]);
  return Buffer.from(cert).toString('base64');
}
const KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const EVIL = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CERT = certificateFor(KEY.publicKey, KEY.privateKey);
const EVIL_CERT = certificateFor(EVIL.publicKey, EVIL.privateKey);

// ── Fixture templates ────────────────────────────────────────────────────────

interface Fx {
  id?: string;
  /** Assertion prefix; '' puts the assertion in the default namespace. */
  p?: string;
  nameId?: string;
  audiences?: string[][];
  inResponseTo?: string | null;
  scdInResponseTo?: string;
  recipient?: string;
  destination?: string | null;
  notOnOrAfter?: string;
  scdNotOnOrAfter?: string | null;
  notBefore?: string;
  /** Declare the assertion namespace (and xs/xsi) on the Response instead of the Assertion. */
  declareOnRoot?: boolean;
  typedAttribute?: boolean;
  /** Indentation, CRLF line ends and tab-separated attributes. */
  pretty?: boolean;
}

const MARK = /\{\{SIG:[^}]*\}\}/gu;

function assertionT(f: Fx = {}): string {
  const p = f.p ?? 'saml';
  const q = (local: string) => (p === '' ? local : `${p}:${local}`);
  const decl = f.declareOnRoot
    ? ''
    : p === ''
      ? ` xmlns="${NS.assertion}"`
      : ` xmlns:${p}="${NS.assertion}"`;
  const id = f.id ?? '_a1';
  const until = f.notOnOrAfter ?? '2026-11-08T10:05:00Z';
  const scdUntil = f.scdNotOnOrAfter === undefined ? until : f.scdNotOnOrAfter;
  const n = f.pretty ? '\r\n  ' : '';
  const audiences = (f.audiences ?? [[SP]])
    .map(
      (list) =>
        `<${q('AudienceRestriction')}>${list.map((a) => `<${q('Audience')}>${a}</${q('Audience')}>`).join('')}</${q('AudienceRestriction')}>`,
    )
    .join('');
  const attribute = f.typedAttribute
    ? `<${q('AttributeStatement')}><${q('Attribute')} Name="displayName"><${q('AttributeValue')} xsi:type="xs:string">Rana Haddad</${q('AttributeValue')}></${q('Attribute')}></${q('AttributeStatement')}>`
    : '';
  const sep = f.pretty ? '\t' : ' ';
  return (
    `<${q('Assertion')}${decl}${sep}Version="2.0"${sep}IssueInstant="2026-11-08T10:00:00Z"${sep}ID="${id}">${n}` +
    `<${q('Issuer')}>${IDP}</${q('Issuer')}>${n}{{SIG:${id}}}${n}` +
    `<${q('Subject')}>${n}<${q('NameID')} Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${f.nameId ?? 'Rana@Northstar.example'}</${q('NameID')}>${n}` +
    `<${q('SubjectConfirmation')} Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><${q('SubjectConfirmationData')}` +
    ` InResponseTo="${f.scdInResponseTo ?? '_r1'}"${scdUntil === null ? '' : ` NotOnOrAfter="${scdUntil}"`} Recipient="${f.recipient ?? ACS}"/></${q('SubjectConfirmation')}>${n}</${q('Subject')}>${n}` +
    `<${q('Conditions')} NotBefore="${f.notBefore ?? '2026-11-08T09:59:00Z'}" NotOnOrAfter="${until}">${audiences}</${q('Conditions')}>${n}` +
    `${attribute}</${q('Assertion')}>`
  );
}

function responseT(inner: string, f: Fx = {}): string {
  const rootDecl = f.declareOnRoot
    ? ` xmlns:${f.p ?? 'saml'}="${NS.assertion}" xmlns:xs="${XS}" xmlns:xsi="${XSI}"`
    : f.typedAttribute
      ? ` xmlns:xs="${XS}" xmlns:xsi="${XSI}"`
      : '';
  const destination = f.destination === undefined ? ACS : f.destination;
  const reply = f.inResponseTo === undefined ? '_r1' : f.inResponseTo;
  const n = f.pretty ? '\r\n' : '';
  return (
    `<samlp:Response xmlns:samlp="${NS.protocol}"${rootDecl} ID="_resp" Version="2.0"` +
    `${reply === null ? '' : ` InResponseTo="${reply}"`}${destination === null ? '' : ` Destination="${destination}"`}>${n}` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${n}` +
    `${inner}${n}</samlp:Response>`
  );
}

// ── Signer: exclusive c14n + RSA, enveloped signature placed at the {{SIG:id}} marker ─────────

interface SignOptions {
  id?: string;
  signer?: KeyObject;
  sigAlg?: string;
  digestAlg?: string;
  c14nAlg?: string;
  transforms?: string[];
  referenceUri?: string;
  /** InclusiveNamespaces PrefixList on both c14n points. */
  inclusive?: string;
  /** dsig prefix; '' = default namespace. */
  ds?: string;
  keyInfoCert?: string;
  /** Base64 wrapped at 64 columns and whitespace between the dsig elements. */
  pretty?: boolean;
}

const wrap64 = (b64: string) => b64.replace(/.{64}/gu, '$&\n');

function sign(template: string, o: SignOptions = {}): string {
  const id = o.id ?? '_a1';
  const prefixes = o.inclusive ? o.inclusive.split(' ') : [];
  const target = descendants(parseStrictXml(template.replace(MARK, ''))).find(
    (e) => e.getAttribute('ID') === id,
  )!;
  const digestHash = o.digestAlg === SHA1_DIGEST ? 'sha1' : 'sha256';
  const b64 = (v: string) => (o.pretty ? wrap64(v) : v);
  const digest = createHash(digestHash)
    .update(exclusiveCanonicalize(target, { inclusivePrefixes: prefixes }), 'utf8')
    .digest('base64');
  const ds = o.ds ?? 'ds';
  const q = (local: string) => (ds === '' ? local : `${ds}:${local}`);
  const decl = ds === '' ? ` xmlns="${NS.dsig}"` : ` xmlns:${ds}="${NS.dsig}"`;
  const incl = o.inclusive
    ? `<ec:InclusiveNamespaces xmlns:ec="${NS.excC14n}" PrefixList="${o.inclusive}"/>`
    : '';
  const n = o.pretty ? '\n    ' : '';
  const transforms = (o.transforms ?? [ALG.enveloped, ALG.excC14n])
    .map((alg) =>
      alg === ALG.excC14n
        ? `<${q('Transform')} Algorithm="${alg}">${incl}</${q('Transform')}>`
        : `<${q('Transform')} Algorithm="${alg}"/>`,
    )
    .join('');
  const signedInfo =
    `<${q('SignedInfo')}>${n}<${q('CanonicalizationMethod')} Algorithm="${o.c14nAlg ?? ALG.excC14n}">${incl}</${q('CanonicalizationMethod')}>${n}` +
    `<${q('SignatureMethod')} Algorithm="${o.sigAlg ?? ALG.rsaSha256}"/>${n}` +
    `<${q('Reference')} URI="${o.referenceUri ?? `#${id}`}"><${q('Transforms')}>${transforms}</${q('Transforms')}>` +
    `<${q('DigestMethod')} Algorithm="${o.digestAlg ?? ALG.sha256}"/><${q('DigestValue')}>${b64(digest)}</${q('DigestValue')}></${q('Reference')}>${n}</${q('SignedInfo')}>`;
  const keyInfo = o.keyInfoCert
    ? `<${q('KeyInfo')}><${q('X509Data')}><${q('X509Certificate')}>${o.keyInfoCert}</${q('X509Certificate')}></${q('X509Data')}></${q('KeyInfo')}>`
    : '';
  const signature = `<${q('Signature')}${decl}>${n}${signedInfo}${n}<${q('SignatureValue')}>@@VALUE@@</${q('SignatureValue')}>${keyInfo}${n}</${q('Signature')}>`;
  const placed = template.replace(`{{SIG:${id}}}`, signature).replace(MARK, '');
  const info = descendants(parseStrictXml(placed)).find(
    (e) => e.namespaceURI === NS.dsig && e.localName === 'SignedInfo',
  )!;
  const value = createSign(o.sigAlg === RSA_SHA1 ? 'RSA-SHA1' : 'RSA-SHA256')
    .update(exclusiveCanonicalize(info, { inclusivePrefixes: prefixes }), 'utf8')
    .sign(o.signer ?? KEY.privateKey, 'base64');
  return placed.replace('@@VALUE@@', b64(value));
}

const signed = (f: Fx = {}, o: SignOptions = {}) => sign(responseT(assertionT(f), f), o);
const b64 = (xml: string) => Buffer.from(xml, 'utf8').toString('base64');
const check = (xml: string, nowMs = NOW) =>
  verifySamlResponse({
    samlResponse: b64(xml),
    idpEntityId: IDP,
    certificate: CERT,
    spEntityId: SP,
    acsUrl: ACS,
    requestId: '_r1',
    nowMs,
  });
const reason = (r: string) => expect.objectContaining({ reason: r });
const ASSERTION_RE = /<saml:Assertion[\s\S]*<\/saml:Assertion>/u;
const SIGNATURE_RE = /<ds:Signature[\s\S]*<\/ds:Signature>/u;
const signedAssertion = (xml: string) => ASSERTION_RE.exec(xml)![0];
const evilAssertion = (id = '_a1') =>
  assertionT({ id, nameId: 'Mallory@Northstar.example' }).replace(MARK, '');
const statusXml = `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`;
const evilResponse = (extra: string) =>
  `<samlp:Response xmlns:samlp="${NS.protocol}" ID="_evil_resp" Version="2.0" InResponseTo="_r1" Destination="${ACS}">${statusXml}${extra}</samlp:Response>`;

// ── The attack matrix ────────────────────────────────────────────────────────

describe('56-10s SAML: baseline', () => {
  it('accepts the untouched signed fixture', () => {
    expect(check(signed())).toMatchObject({ claims: { email: 'rana@northstar.example' } });
  });
});

describe('56-10s SAML: XML Signature Wrapping (XSW1–XSW8)', () => {
  const good = signed();
  const original = signedAssertion(good);
  const cases: [string, string][] = [
    // XSW1: evil Response; the original signed Response hidden in a dsig Object.
    [
      'XSW1 original Response inside ds:Object',
      evilResponse(
        `${evilAssertion()}<ds:Signature xmlns:ds="${NS.dsig}"><ds:Object>${good}</ds:Object></ds:Signature>`,
      ),
    ],
    // XSW2: evil Response; the original signed Response detached as a child.
    ['XSW2 original Response detached inside', evilResponse(`${good}${evilAssertion()}`)],
    // XSW3: evil assertion with the same ID placed before the signed one.
    [
      'XSW3 evil assertion (same ID) first',
      good.replace(original, `${evilAssertion()}${original}`),
    ],
    // XSW4: evil assertion wraps the signed one.
    [
      'XSW4 signed assertion nested in evil one',
      good.replace(
        original,
        evilAssertion().replace('</saml:Assertion>', `${original}</saml:Assertion>`),
      ),
    ],
    // XSW5: evil assertion carries the copied signature; the original moves to the end, unsigned.
    [
      'XSW5 copied signature on evil, original unsigned at end',
      good.replace(
        original,
        `${evilAssertion().replace('</saml:Issuer>', `</saml:Issuer>${SIGNATURE_RE.exec(original)![0]}`)}${original.replace(SIGNATURE_RE, '')}`,
      ),
    ],
    // XSW6: evil assertion with the signature, the original inside its Object.
    [
      'XSW6 original inside the copied signature Object',
      good.replace(
        original,
        evilAssertion().replace(
          '</saml:Issuer>',
          `</saml:Issuer>${SIGNATURE_RE.exec(original)![0].replace('</ds:Signature>', `<ds:Object>${original}</ds:Object></ds:Signature>`)}`,
        ),
      ),
    ],
    // XSW7: signed assertion hidden under Extensions, evil assertion direct.
    [
      'XSW7 original under samlp:Extensions',
      good.replace(original, `<samlp:Extensions>${original}</samlp:Extensions>${evilAssertion()}`),
    ],
    // XSW8: evil assertion's signature Object holds the original with its signature stripped.
    [
      'XSW8 Object holds original minus its signature',
      good.replace(
        original,
        evilAssertion().replace(
          '</saml:Issuer>',
          `</saml:Issuer>${SIGNATURE_RE.exec(original)![0].replace('</ds:Signature>', `<ds:Object>${original.replace(SIGNATURE_RE, '')}</ds:Object></ds:Signature>`)}`,
        ),
      ),
    ],
    [
      'signed assertion + unsigned evil (other ID)',
      good.replace(original, `${original}${evilAssertion('_evil')}`),
    ],
    [
      'duplicate ID on a non-assertion element',
      good.replace(original, `<samlp:Extensions ID="_a1"/>${original}`),
    ],
  ];
  it.each(cases)('%s → wrapped', (_name, xml) => {
    expect(() => check(xml)).toThrow(reason('wrapped'));
  });

  it('XSW5b: evil assertion with the copied signature alone → bad_digest', () => {
    const xml = good.replace(
      original,
      evilAssertion().replace('</saml:Issuer>', `</saml:Issuer>${SIGNATURE_RE.exec(original)![0]}`),
    );
    expect(() => check(xml)).toThrow(reason('bad_digest'));
  });
});

describe('56-10s SAML: content and parser attacks', () => {
  it('refuses a comment injected into the signed NameID (digest still valid)', () => {
    const xml = signed({ nameId: 'user@evil.com.good.com' }).replace(
      'user@evil.com.good.com',
      'user@evil.com<!---->.good.com',
    );
    expect(() => check(xml)).toThrow(reason('malformed'));
  });

  it('refuses a comment signed into the NameID and a processing instruction', () => {
    expect(() => check(signed({ nameId: 'user@evil.com<!--x-->.good.com' }))).toThrow(
      reason('malformed'),
    );
    expect(() => check(signed({ nameId: 'user@good.com<?x y?>' }))).toThrow(reason('malformed'));
  });

  it.each([
    ['internal entity', '<!DOCTYPE r [<!ENTITY e "x">]>'],
    ['external entity', '<!DOCTYPE r [<!ENTITY e SYSTEM "file:///etc/passwd">]>'],
    ['lower-case doctype', '<!doctype r>'],
  ])('refuses a %s declaration', (_name, prolog) => {
    expect(() => check(`${prolog}${signed()}`)).toThrow(reason('malformed'));
  });

  it('refuses an undeclared entity reference and truncated XML', () => {
    expect(() => check(signed().replace('Rana@', '&xxe;Rana@'))).toThrow(reason('malformed'));
    expect(() => check(signed().slice(0, -5))).toThrow(reason('malformed'));
  });
});

describe('56-10s SAML: signature construction', () => {
  it.each([
    ['another ID', '#_other'],
    ['the whole document', ''],
    ['an XPointer', "#xpointer(id('_a1'))"],
  ])('refuses a Reference URI naming %s', (_name, uri) => {
    expect(() => check(signed({}, { referenceUri: uri }))).toThrow(reason('wrapped'));
  });

  it('refuses two Signature elements and two References', () => {
    const xml = signed();
    const signature = SIGNATURE_RE.exec(xml)![0];
    expect(() => check(xml.replace(signature, `${signature}${signature}`))).toThrow(
      reason('wrapped'),
    );
    const reference = /<ds:Reference[\s\S]*<\/ds:Reference>/u.exec(xml)![0];
    expect(() => check(xml.replace(reference, `${reference}${reference}`))).toThrow(
      reason('wrapped'),
    );
  });

  it.each<[string, SignOptions]>([
    ['RSA-SHA1 signature', { sigAlg: RSA_SHA1 }],
    ['SHA-1 digest', { digestAlg: SHA1_DIGEST }],
    ['HMAC-SHA256 method', { sigAlg: 'http://www.w3.org/2001/04/xmldsig-more#hmac-sha256' }],
    ['inclusive C14N', { c14nAlg: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315' }],
    ['exc-C14N WithComments', { c14nAlg: `${ALG.excC14n}WithComments` }],
    ['unknown digest', { digestAlg: 'urn:example:md5' }],
    [
      'extra XPath transform',
      { transforms: [ALG.enveloped, 'http://www.w3.org/TR/1999/REC-xpath-19991116', ALG.excC14n] },
    ],
    ['enveloped transform missing', { transforms: [ALG.excC14n] }],
  ])('refuses %s', (_name, options) => {
    expect(() => check(signed({}, options))).toThrow(reason('unsupported_algorithm'));
  });

  it('ignores a KeyInfo certificate: only the stored certificate counts', () => {
    expect(() => check(signed({}, { signer: EVIL.privateKey, keyInfoCert: EVIL_CERT }))).toThrow(
      reason('bad_signature'),
    );
    expect(check(signed({}, { keyInfoCert: EVIL_CERT })).assertionId).toBe('_a1');
  });
});

describe('56-10s SAML: protocol bindings', () => {
  it.each<[string, Fx, string]>([
    ['Destination mismatch', { destination: 'https://evil.example/acs' }, 'wrong_recipient'],
    ['Recipient mismatch', { recipient: 'https://evil.example/acs' }, 'wrong_recipient'],
    ['Response InResponseTo unknown', { inResponseTo: '_unknown' }, 'wrong_request'],
    ['Response InResponseTo absent (unsolicited)', { inResponseTo: null }, 'wrong_request'],
    ['confirmation InResponseTo unknown', { scdInResponseTo: '_unknown' }, 'wrong_request'],
    ['Conditions NotOnOrAfter past', { notOnOrAfter: '2026-11-08T09:50:00Z' }, 'expired'],
    ['confirmation NotOnOrAfter past', { scdNotOnOrAfter: '2026-11-08T09:50:00Z' }, 'expired'],
    ['confirmation NotOnOrAfter absent', { scdNotOnOrAfter: null }, 'expired'],
    ['NotBefore in the future', { notBefore: '2026-11-08T10:10:00Z' }, 'not_yet_valid'],
    [
      'audience list without us',
      { audiences: [['https://a.example', 'https://b.example']] },
      'wrong_audience',
    ],
    [
      'second restriction without us',
      { audiences: [[SP], ['https://b.example']] },
      'wrong_audience',
    ],
  ])('refuses %s', (_name, fx, expected) => {
    expect(() => check(signed(fx))).toThrow(reason(expected));
  });

  it('accepts an audience list that names us among others', () => {
    expect(check(signed({ audiences: [['https://a.example', SP]] })).assertionId).toBe('_a1');
  });

  it('refuses an encrypted assertion, alone or beside a signed one', () => {
    const encrypted = `<saml:EncryptedAssertion xmlns:saml="${NS.assertion}"><xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#"/></saml:EncryptedAssertion>`;
    expect(() => check(responseT(encrypted))).toThrow(reason('malformed'));
    const xml = signed();
    expect(() => check(xml.replace('</samlp:Response>', `${encrypted}</samlp:Response>`))).toThrow(
      reason('malformed'),
    );
  });

  it('refuses a reused or never-issued request ID at the service', async () => {
    const connection = {
      id: 'c1',
      organizationId: ORG,
      protocol: 'saml',
      samlEntityId: IDP,
      samlSsoUrl: IDP,
      samlCertificate: CERT,
    };
    const consumeRequest = vi.fn().mockResolvedValue(false);
    const rememberAssertion = vi.fn().mockResolvedValue(true);
    const service = new SsoService({
      database: {
        bootstrapRead: () => connection,
        transaction: (_c: unknown, work: (tx: unknown) => unknown) => work({}),
      },
      repository: { findByOrganization: vi.fn() },
      samlRequests: { consumeRequest, rememberAssertion },
      webPublicUrl: 'https://app.example',
      now: () => NOW,
    } as unknown as SsoServiceDeps);
    const flow = { ...newSamlFlow(ORG, NOW / 1000), requestId: '_r1' };
    await expect(service.verifySaml(flow, b64(signed()), ORG)).rejects.toThrow(reason('replayed'));
    expect(rememberAssertion).not.toHaveBeenCalled();
  });
});

// ── Positive proofs: namespace-prefix and whitespace forms that must verify ──

describe('56-10s SAML: c14n edge cases that must verify', () => {
  it.each<[string, Fx, SignOptions]>([
    ['assertion in the default namespace', { p: '' }, {}],
    ['dsig in the default namespace', {}, { ds: '' }],
    ['unusual prefixes', { p: 'a' }, { ds: 'dsig' }],
    ['assertion namespace declared only on the Response', { declareOnRoot: true }, {}],
    ['indentation, CRLF, tabs and wrapped base64', { pretty: true }, { pretty: true }],
    ['xsi:type QName with PrefixList', { typedAttribute: true }, { inclusive: 'xs' }],
  ])('verifies %s', (_name, fx, options) => {
    expect(check(signed(fx, options)).claims.email).toBe('rana@northstar.example');
  });

  it('verifies a redundant namespace redeclaration and single-quoted attributes', () => {
    const template = responseT(assertionT())
      .replace('<saml:Subject>', `<saml:Subject xmlns:saml='${NS.assertion}'>`)
      .replace('Version="2.0" IssueInstant', "Version='2.0' IssueInstant");
    expect(check(sign(template)).assertionId).toBe('_a1');
  });

  it('binds the PrefixList namespace: changing xmlns:xs on the Response breaks the digest', () => {
    const xml = signed({ typedAttribute: true }, { inclusive: 'xs' });
    expect(() => check(xml.replace(`xmlns:xs="${XS}"`, 'xmlns:xs="urn:evil"'))).toThrow(
      reason('bad_digest'),
    );
  });

  it('canonicalizes per the specification (independent expected strings)', () => {
    const doc = parseStrictXml(
      '<r xmlns="urn:d" xmlns:u="urn:unused" xmlns:x="urn:x">\r\n' +
        '  <x:a  b = "1"  x:c="2"\ta="3" xml:lang="en"><n xmlns=""/><x:d xmlns:x="urn:x">&#xD;></x:d></x:a>\r\n</r>',
    );
    const a = descendants(doc).find((e) => e.localName === 'a')!;
    // Apex: only the visibly used x (u and the default dropped); unqualified attributes first, then
    // by namespace URI (XML namespace before urn:x); n has nothing to undeclare; the redundant
    // x redeclaration on x:d is dropped; CR and > in text are escaped.
    expect(exclusiveCanonicalize(a)).toBe(
      '<x:a xmlns:x="urn:x" a="3" b="1" xml:lang="en" x:c="2"><n></n><x:d>&#xD;&gt;</x:d></x:a>',
    );
    // The whole root: default ns rendered at the apex, so the child undeclares it; CRLF → LF.
    expect(exclusiveCanonicalize(doc)).toBe(
      '<r xmlns="urn:d">\n  <x:a xmlns:x="urn:x" a="3" b="1" xml:lang="en" x:c="2"><n xmlns=""></n><x:d>&#xD;&gt;</x:d></x:a>\n</r>',
    );
    // PrefixList pulls the unused-but-listed prefix in from the ancestor.
    expect(exclusiveCanonicalize(a, { inclusivePrefixes: ['u', '#default'] })).toBe(
      '<x:a xmlns="urn:d" xmlns:u="urn:unused" xmlns:x="urn:x" a="3" b="1" xml:lang="en" x:c="2"><n xmlns=""></n><x:d>&#xD;&gt;</x:d></x:a>',
    );
  });
});
