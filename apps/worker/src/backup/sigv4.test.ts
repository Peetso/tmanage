import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { EMPTY_SHA256, authorization, canonicalRequest, uriEncode } from './sigv4.js';

/**
 * The AWS Signature Version 4 test suite, as shipped in botocore
 * (`tests/unit/auth/aws4_testsuite/<case>/<case>.{req,creq,authz}`): credentials AKIDEXAMPLE /
 * `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY`, region us-east-1, service `service`,
 * 2015-08-30T12:36:00Z. Expected values copied verbatim from the suite.
 */
const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const AT = new Date('2015-08-30T12:36:00Z');
const BASE = { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' };

describe('SigV4 against the AWS test suite', () => {
  it('get-vanilla', () => {
    const request = { method: 'GET', path: '/', headers: BASE, payloadSha256: EMPTY_SHA256 };
    expect(canonicalRequest(request).text).toBe(
      'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(authorization(request, CREDENTIALS, 'us-east-1', 'service', AT)).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('get-vanilla-query-order-key-case: query parameters are sorted', () => {
    const request = {
      method: 'GET',
      path: '/',
      query: { Param2: 'value2', Param1: 'value1' },
      headers: BASE,
      payloadSha256: EMPTY_SHA256,
    };
    expect(authorization(request, CREDENTIALS, 'us-east-1', 'service', AT)).toMatch(
      /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/u,
    );
  });

  it('get-vanilla-query-unreserved: unreserved characters are not encoded', () => {
    const unreserved = '-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const request = {
      method: 'GET',
      path: '/',
      query: { [unreserved]: unreserved },
      headers: BASE,
      payloadSha256: EMPTY_SHA256,
    };
    expect(authorization(request, CREDENTIALS, 'us-east-1', 'service', AT)).toMatch(
      /Signature=9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197$/u,
    );
  });

  it('post-x-www-form-urlencoded: the body hash and an extra signed header', () => {
    const request = {
      method: 'POST',
      path: '/',
      headers: { ...BASE, 'Content-Type': 'application/x-www-form-urlencoded' },
      payloadSha256: createHash('sha256').update('Param1=value1').digest('hex'),
    };
    expect(authorization(request, CREDENTIALS, 'us-east-1', 'service', AT)).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a',
    );
  });
});

describe('S3 path encoding', () => {
  it('encodes each byte outside the unreserved set once and keeps the slashes', () => {
    expect(uriEncode('/bucket/db/20261120T030000Z/db.sql.gz.age', true)).toBe(
      '/bucket/db/20261120T030000Z/db.sql.gz.age',
    );
    expect(uriEncode('/a b/ü+%', true)).toBe('/a%20b/%C3%BC%2B%25');
    expect(uriEncode('a/b')).toBe('a%2Fb');
  });
});
