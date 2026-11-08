import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { exclusiveCanonicalize, parseStrictXml } from './saml-xml.js';
import {
  ALG,
  NS,
  newSamlFlow,
  normalizeCertificate,
  parseIdpMetadata,
  samlAuthnRequestUrl,
  verifySamlResponse,
} from './sso-saml.js';
import { SsoService, type SsoServiceDeps } from './sso.service.js';

const IDP = 'https://idp.northstar.example/saml';
const SP = 'https://app.example/v1/auth/sso/saml/metadata';
const ACS = 'https://app.example/v1/auth/sso/saml/acs';
const NOW = Date.parse('2026-11-08T10:00:00Z');
const ORG = '0190f0a0-0000-7000-8000-000000000001';

const der = (tag: number, body: readonly number[]): number[] => {
  const n = body.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  return [tag, ...len, ...body];
};
const RSA_SHA256 = der(0x30, [...der(0x06, [42, 134, 72, 134, 247, 13, 1, 1, 11]), 5, 0]);
const NAME = der(0x30, der(0x31, der(0x30, [...der(0x06, [85, 4, 3]), ...der(0x0c, [0x74])])));
/** A self-signed RSA certificate (bare base64 DER) for the test key. */
function certificateFor(publicKey: KeyObject, privateKey: KeyObject): string {
  const time = (s: string) => der(0x17, [...Buffer.from(s)]);
  const tbs = der(0x30, [
    ...der(0xa0, der(0x02, [2])),
    ...der(0x02, [1]),
    ...RSA_SHA256,
    ...NAME,
    ...der(0x30, [...time('250101000000Z'), ...time('351231000000Z')]),
    ...NAME,
    ...publicKey.export({ type: 'spki', format: 'der' }),
  ]);
  const signature = createSign('RSA-SHA256').update(Uint8Array.from(tbs)).sign(privateKey);
  return Buffer.from(der(0x30, [...tbs, ...RSA_SHA256, ...der(0x03, [0, ...signature])])).toString(
    'base64',
  );
}
const KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const OTHER = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CERT = certificateFor(KEY.publicKey, KEY.privateKey);

interface Shape {
  id?: string;
  audience?: string;
  notOnOrAfter?: string;
  inResponseTo?: string;
  signer?: KeyObject;
  unsigned?: boolean;
  tamper?: (signed: string) => string;
}
function assertionXml(s: Shape): string {
  const until = s.notOnOrAfter ?? '2026-11-08T10:05:00Z';
  return (
    `<saml:Assertion xmlns:saml="${NS.assertion}" ID="${s.id ?? '_a1'}" IssueInstant="2026-11-08T10:00:00Z" Version="2.0">` +
    `<saml:Issuer>${IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">Rana@Northstar.example</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${s.inResponseTo ?? '_r1'}" NotOnOrAfter="${until}" Recipient="${ACS}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="2026-11-08T09:59:00Z" NotOnOrAfter="${until}"><saml:AudienceRestriction><saml:Audience>${s.audience ?? SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `</saml:Assertion>`
  );
}
/** A Response with the Assertion's enveloped signature (exc-c14n, RSA-SHA256, SHA-256). */
function response(s: Shape = {}): string {
  let assertion = assertionXml(s);
  if (!s.unsigned) {
    const digest = createHash('sha256')
      .update(exclusiveCanonicalize(parseStrictXml(assertion)))
      .digest('base64');
    const signedInfo =
      `<ds:SignedInfo xmlns:ds="${NS.dsig}"><ds:CanonicalizationMethod Algorithm="${ALG.excC14n}"/>` +
      `<ds:SignatureMethod Algorithm="${ALG.rsaSha256}"/><ds:Reference URI="#${s.id ?? '_a1'}"><ds:Transforms>` +
      `<ds:Transform Algorithm="${ALG.enveloped}"/><ds:Transform Algorithm="${ALG.excC14n}"/></ds:Transforms>` +
      `<ds:DigestMethod Algorithm="${ALG.sha256}"/><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
    const value = createSign('RSA-SHA256')
      .update(exclusiveCanonicalize(parseStrictXml(signedInfo)))
      .sign(s.signer ?? KEY.privateKey, 'base64');
    const signature = `<ds:Signature xmlns:ds="${NS.dsig}">${signedInfo.replace(` xmlns:ds="${NS.dsig}"`, '')}<ds:SignatureValue>${value}</ds:SignatureValue></ds:Signature>`;
    assertion = assertion.replace('</saml:Issuer>', `</saml:Issuer>${signature}`);
  }
  let xml =
    `<samlp:Response xmlns:samlp="${NS.protocol}" ID="_resp" Version="2.0" InResponseTo="_r1" Destination="${ACS}">` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
  if (s.tamper) xml = s.tamper(xml);
  return Buffer.from(xml).toString('base64');
}
const check = (samlResponse: string, nowMs = NOW) =>
  verifySamlResponse({
    samlResponse,
    idpEntityId: IDP,
    certificate: CERT,
    spEntityId: SP,
    acsUrl: ACS,
    requestId: '_r1',
    nowMs,
  });
const reason = (reasonName: string) => expect.objectContaining({ reason: reasonName });

describe('54-15 SAML: exclusive canonicalization', () => {
  it('renders the specification form: used namespaces only, sorted attributes, escaping', () => {
    const root = parseStrictXml(
      '<root xmlns="urn:d" xmlns:b="urn:b" xmlns:u="urn:u" z="1" b:a="2" a="x&#xA;y">' +
        '<b:c>t &amp; &lt;x&gt;</b:c><e/><!--gone--><a:x xmlns:a="urn:a"/></root>',
    );
    expect(exclusiveCanonicalize(root)).toBe(
      '<root xmlns="urn:d" xmlns:b="urn:b" a="x&#xA;y" z="1" b:a="2"><b:c>t &amp; &lt;x&gt;</b:c>' +
        '<e></e><a:x xmlns:a="urn:a"></a:x></root>',
    );
  });
});

describe('54-15 SAML: response verification', () => {
  it('accepts a signed response for this request and lower-cases the address', () => {
    expect(check(response())).toMatchObject({
      assertionId: '_a1',
      claims: { email: 'rana@northstar.example' },
    });
  });

  it('refuses an unsigned assertion and one signed by another key', () => {
    expect(() => check(response({ unsigned: true }))).toThrow(reason('unsigned'));
    expect(() => check(response({ signer: OTHER.privateKey }))).toThrow(reason('bad_signature'));
  });

  it('refuses wrapped and altered assertions', () => {
    const evil = assertionXml({ id: '_evil' }).replace('Rana@', 'Mallory@');
    // A second assertion beside the signed one, and the signed one hidden under an extension.
    expect(() =>
      check(
        response({ tamper: (x) => x.replace('</samlp:Response>', `${evil}</samlp:Response>`) }),
      ),
    ).toThrow(reason('wrapped'));
    expect(() =>
      check(
        response({
          tamper: (x) =>
            x.replace(
              /<saml:Assertion[\s\S]*<\/saml:Assertion>/u,
              (a) => `<samlp:Extensions>${a}</samlp:Extensions>${evil}`,
            ),
        }),
      ),
    ).toThrow(reason('wrapped'));
    expect(() => check(response({ tamper: (x) => x.replace('Rana@', 'Mallory@') }))).toThrow(
      reason('bad_digest'),
    );
  });

  it('refuses a wrong audience, another request and an expired assertion', () => {
    expect(() => check(response({ audience: 'https://other.example' }))).toThrow(
      reason('wrong_audience'),
    );
    expect(() => check(response({ inResponseTo: '_r2' }))).toThrow(reason('wrong_request'));
    expect(() => check(response(), NOW + 5 * 60_000 + 119_000)).not.toThrow();
    expect(() => check(response(), NOW + 5 * 60_000 + 120_000)).toThrow(reason('expired'));
  });

  it('refuses a document type declaration', () => {
    const xml = Buffer.from(`<!DOCTYPE r [<!ENTITY e "x">]>${Buffer.from(response(), 'base64')}`);
    expect(() => check(xml.toString('base64'))).toThrow(reason('malformed'));
  });

  it('refuses a replayed assertion after its request was consumed', async () => {
    const connection = {
      id: 'c1',
      organizationId: ORG,
      slug: 'n',
      issuer: '',
      clientId: '',
      clientSecretEnc: '',
      allowedDomains: 'northstar.example',
      autoJoin: false,
      protocol: 'saml',
      samlEntityId: IDP,
      samlSsoUrl: IDP,
      samlCertificate: CERT,
    };
    const rememberAssertion = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const deps = {
      database: {
        bootstrapRead: () => connection,
        transaction: (_c: unknown, work: (tx: unknown) => unknown) => work({}),
      },
      repository: { findByOrganization: vi.fn() },
      samlRequests: { consumeRequest: vi.fn().mockResolvedValue(true), rememberAssertion },
      webPublicUrl: 'https://app.example',
      now: () => NOW,
    } as unknown as SsoServiceDeps;
    const service = new SsoService(deps);
    const flow = { ...newSamlFlow(ORG, NOW / 1000), requestId: '_r1' };
    await expect(service.verifySaml(flow, response(), ORG)).resolves.toMatchObject({
      claims: { email: 'rana@northstar.example' },
    });
    await expect(service.verifySaml(flow, response(), ORG)).rejects.toThrow(reason('replayed'));
  });
});

describe('54-15 SAML: settings and the AuthnRequest', () => {
  it('reads entity ID, redirect URL and certificate from IdP metadata', () => {
    const metadata =
      `<md:EntityDescriptor xmlns:md="${NS.metadata}" entityID="${IDP}"><md:IDPSSODescriptor protocolSupportEnumeration="${NS.protocol}">` +
      `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="${NS.dsig}"><ds:X509Data><ds:X509Certificate>${CERT}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
      `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP}/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
    expect(parseIdpMetadata(metadata)).toEqual({
      entityId: IDP,
      ssoUrl: `${IDP}/sso`,
      certificate: CERT,
    });
    expect(normalizeCertificate('not a certificate')).toBeNull();
  });

  it('deflates an AuthnRequest that names this request, the ACS and the SP', () => {
    const flow = newSamlFlow('org-1', NOW / 1000);
    const url = new URL(
      samlAuthnRequestUrl({
        ssoUrl: `${IDP}/sso`,
        spEntityId: SP,
        acsUrl: ACS,
        flow,
        issueInstant: new Date(NOW),
      }),
    );
    const xml = inflateRawSync(
      Buffer.from(url.searchParams.get('SAMLRequest') ?? '', 'base64'),
    ).toString();
    expect(xml).toContain(`ID="${flow.requestId}"`);
    expect(xml).toContain(`AssertionConsumerServiceURL="${ACS}"`);
    expect(url.searchParams.get('RelayState')).toBe(flow.relayState);
  });
});
