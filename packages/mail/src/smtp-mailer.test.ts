import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { SmtpMailer } from './smtp-mailer.js';

/**
 * The smtp driver against a scripted SMTP server on a local socket.
 *
 * The point of these cases is that the nodemailer dependency is proved, not trusted: a
 * real TCP connection, the real command sequence, a real STARTTLS upgrade with a real
 * AUTH exchange, and the message as the server received it. The certificate below is a
 * self-signed fixture for `localhost` — the client verifies nothing against it
 * (`rejectUnauthorized: false`, the option `SmtpMailerOptions.tls` exists for), because
 * what is under test is the dialog, not the CA ecosystem.
 */

/** Self-signed, CN=localhost, valid to 2126. A test fixture, never a credential. */
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDoGnoh8wxRH6eB
ttchxlIM8xepFzjQ605ZB8T3bIS+uxh/+OBBNVqgAjG3c/PglaSJ0MbIAs+LcM8e
CMCyWLBzQm70KFLAeMuHzy66XedfbG5+uxPNZ/+ZD02YeMkuXRSnDh70kUJgKx+l
ghpNXADOY1Gi+i7/tIyU71XfFetN29665yGpk8K9KCVrCt/aC8mDxBx/avObGWwa
6XHhMx4SlEGgWnocawE+s5qd/s3vI5xmtYRwqeSV69pfdIk+hfNu57VqNE1SyaKN
yUxitrBB/DQCqK45yXymNti+YHMDutqNZnZlRprVmCGGzrn9acr/k6/KQjkV+Z1v
yGK1IewLAgMBAAECggEAAv4cZwWoOf+LfFusKG5TLoGP44k+HUt7ZiB4hKwshf0J
ktTVp2GVuoxssa3YDiQ/y9saRQfsPyMEOKHqQiJsm//WSGWgs4SbMzQTqSl+yzct
sYqd9b8Kh6Gv4XBlP6jJlGHVOlgJIA5OSScFScwO4ppbOhu5sWhVi7IOTGMO9qEB
0wu9PRgsWgUI17+kZLdu6N26PtuRr5ITEMC/9nVVHaxTkt2GSHTO+ZjJBmWJGxpY
rnBvgbHkIXZzoarSIflh/lZY5hEOH6G5TIIGhuseTdFWbq3SpfMQtAhaDCpYr+an
j25IGArZtLc/yo67hQWq267Lv3eYG7QBb1lwj69haQKBgQD8O6IcpbIPxmyJ12c9
aklU0DcZmWx/Lz805ObEhk0GHO19E72Pr8MU3CjeUcQcKc5qx1cACIZ5TcVAzxLo
OPEmqxjwyYTr4AYf8HSwAtbpypqB1SGat4LsKNuzhCRFpWZ8NC6TL/LhfW/Vn5yz
wxmbDMXGT94ZBymrW5+SWGSMNwKBgQDrkeHdrlKRRuZd1r/EQl5KMkwk9JeWT3Jp
QF30Ly7uwWiWI3ThV2vOkntmM9KgnJlsw7BVGxD9znzqHWxLCy5o35OeoekwKTDm
N726FNkK9E8jyEMdRcVOakDDhKS+G5M+gxMSEZhE1jOnwhNm8icFbZt9i45dd+eI
2DYr0WV8zQKBgBE3HLxpzrpm55eM3R4C+BhS0b/sicwwdFbu3JVDOVSWetsTkteQ
vnbZA+0QlZr6e30sN9Lnwg3bcgAXYgn5gPQLr3sXtfvHYYOijMRKnVJ9oogD/PQr
XEM0ErKw7SzXuiP2B8vB9QjQ3+Yrq61VPpUnjQQZBWad54kriruZTtuHAoGBAL+K
lsTRgYFuzNFwU+0YqeJak19ZIgiuALFkDQEHfHnV+Vxa6CZyFs6YfI3VhWXi7z1o
wG/y2hYFV7xkwDEknk/Xuwg5TopCc+g9Wp97ZB9sFw1ZQHkEyjHAY3iW2f1aHpet
rEv80nrmUIoPXAdQzjmzrcKfPtrxK+oxI5rtYD/hAoGBAJ27axGxyCNWAH06VqRy
jb06/jWBIz1YOLdE96DxqtRsnMHXWMGbCAqy/8bpTtU6JwskLTtNaQ9gOXey/6Qw
zHKI2izc9ndMpXG+LHPUki/OVOUBQdAcq/TfSVV90mswZDw8L+fubRyebWPKY9oX
wYeHv06mGyUdFpPg1KMjUT6g
-----END PRIVATE KEY-----`;

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCzCCAfOgAwIBAgIUVs3LKIRBMToHRKvINkHLqAOHmOAwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDgzMDIwMzcyMFoYDzIxMjYw
ODA2MjAzNzIwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDoGnoh8wxRH6eBttchxlIM8xepFzjQ605ZB8T3bIS+
uxh/+OBBNVqgAjG3c/PglaSJ0MbIAs+LcM8eCMCyWLBzQm70KFLAeMuHzy66Xedf
bG5+uxPNZ/+ZD02YeMkuXRSnDh70kUJgKx+lghpNXADOY1Gi+i7/tIyU71XfFetN
29665yGpk8K9KCVrCt/aC8mDxBx/avObGWwa6XHhMx4SlEGgWnocawE+s5qd/s3v
I5xmtYRwqeSV69pfdIk+hfNu57VqNE1SyaKNyUxitrBB/DQCqK45yXymNti+YHMD
utqNZnZlRprVmCGGzrn9acr/k6/KQjkV+Z1vyGK1IewLAgMBAAGjUzBRMB0GA1Ud
DgQWBBSjPfxr6ZZHVyQ5xxW7crKVv4OYZTAfBgNVHSMEGDAWgBSjPfxr6ZZHVyQ5
xxW7crKVv4OYZTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAj
p36+T3DABPSjZD3PUVkT7011FIgSr9srjTHmcsabjtkxwM/63wfEFnLuDX2eGi0R
/lyJ5aQMbai/176jnCvYsMq7/4E0RBjzOZHQ0ehBMyB3iEOHYAFna60tI8R5O9/U
tZiUqOlU94HvM6c/kHPM8bCH5V4GhyGLa3EWLidb4b2kTgfCj8rRi5UYKpF+zQ3q
lh3mmYj1sxsw1vAY1p+dNIecJ/Z74TZVSuooWLjUAAf3gg2nd2TaBGO30TGGn2s7
y7WtsuEikrS0fQ2MyGqr1GjcjRj+Y40gEA6nSNfSYmgvGCfDCGVXLG8iVl1cfkPt
fC4DxdbR7H5baZrKGvMk
-----END CERTIFICATE-----`;

interface ScriptedOptions {
  readonly rejectRecipients?: boolean;
  /** Advertise and honour STARTTLS; after the upgrade, advertise `AUTH PLAIN`. */
  readonly starttls?: boolean;
}

interface ScriptedSmtpServer {
  readonly port: number;
  /** MAIL FROM / RCPT TO lines, in order. */
  readonly envelope: string[];
  /** The one `AUTH PLAIN <base64>` line, when the client authenticated. */
  authLine: string | undefined;
  /** The DATA payload, dot-stuffing still in place. */
  data: string;
  close(): Promise<void>;
}

function startServer(options: ScriptedOptions = {}): Promise<ScriptedSmtpServer> {
  const envelope: string[] = [];
  const sockets = new Set<Socket>();
  const state: { data: string; authLine: string | undefined } = {
    data: '',
    authLine: undefined,
  };
  let server: Server;

  const attach = (socket: Socket, upgraded: boolean): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = '';
    let inData = false;

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          state.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);

        const verb = line.split(' ')[0]?.toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') {
          const capabilities = ['250-scripted'];
          if (options.starttls && !upgraded) capabilities.push('250-STARTTLS');
          if (upgraded) capabilities.push('250-AUTH PLAIN');
          capabilities.push('250 8BITMIME');
          socket.write(`${capabilities.join('\r\n')}\r\n`);
        } else if (verb === 'STARTTLS' && options.starttls && !upgraded) {
          socket.off('data', onData);
          socket.write('220 go ahead\r\n');
          const secured = new TLSSocket(socket, {
            isServer: true,
            secureContext: createSecureContext({ key: TLS_KEY, cert: TLS_CERT }),
          });
          attach(secured, true);
          return;
        } else if (verb === 'STARTTLS') {
          // Not supported on this connection. `requireTLS` clients try the command even
          // unadvertised; a generic 250 here would strand them in a TLS handshake against
          // a plain socket, so refuse the way a real server does.
          socket.write('454 TLS not available\r\n');
        } else if (verb === 'AUTH') {
          state.authLine = line;
          socket.write('235 accepted\r\n');
        } else if (verb === 'MAIL') {
          envelope.push(line);
          socket.write('250 ok\r\n');
        } else if (verb === 'RCPT') {
          envelope.push(line);
          socket.write(options.rejectRecipients ? '550 no such user\r\n' : '250 ok\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 ok\r\n');
        }
      }
    };

    socket.on('data', onData);
    // The TLS layer replays nothing: greet only the plain connection, once.
    if (!upgraded) socket.write('220 scripted ESMTP\r\n');
  };

  return new Promise((resolve) => {
    server = createServer((socket) => attach(socket, false));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        envelope,
        get authLine() {
          return state.authLine;
        },
        set authLine(value: string | undefined) {
          state.authLine = value;
        },
        get data() {
          return state.data;
        },
        set data(value: string) {
          state.data = value;
        },
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const mailerFor = (
  port: number,
  credentials?: { username: string; password: string },
): SmtpMailer =>
  new SmtpMailer({
    host: '127.0.0.1',
    port,
    secure: false,
    fromAddress: 'no-reply@tmanage.example',
    fromName: 'TManage',
    ...(credentials ?? {}),
    ...(credentials ? { tls: { rejectUnauthorized: false } } : {}),
  });

describe('SmtpMailer', () => {
  let server: ScriptedSmtpServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('submits the message and reports it sent', async () => {
    server = await startServer();

    const delivery = await mailerFor(server.port).send({
      to: 'nadia@brightops.example',
      subject: 'Omar invited you to Northstar Studio on TManage',
      text: 'Review invitation: https://app.tmanage.example/invitations/tok123\n.starts with a dot',
    });

    expect(delivery).toBe('sent');
    expect(server.envelope[0]).toContain('<no-reply@tmanage.example>');
    expect(server.envelope[1]).toContain('<nadia@brightops.example>');
    expect(server.data).toContain('Subject: Omar invited you to Northstar Studio on TManage');
    expect(server.data).toContain('To: nadia@brightops.example');
    // nodemailer drops the display-name quotes when the name needs none.
    expect(server.data).toMatch(/From: "?TManage"? <no-reply@tmanage\.example>/u);
    expect(server.data).toContain('https://app.tmanage.example/invitations/tok123');
    // RFC 5321 §4.5.2: a body line beginning with a dot arrives doubled, or the server
    // would have read it as end-of-message. This is the corruption a hand-rolled client
    // invites and the reason the driver is a dependency.
    expect(server.data).toContain('\r\n..starts with a dot');
  });

  it('sends the HTML alternative and the Reply-To when a producer supplies them', async () => {
    server = await startServer();

    await mailerFor(server.port).send({
      to: 'nadia@brightops.example',
      subject: 'x',
      text: 'plain body',
      html: '<p>html body</p>',
      replyTo: 'omar@northstar.example',
    });

    expect(server.data).toContain('Reply-To: omar@northstar.example');
    expect(server.data).toContain('multipart/alternative');
    expect(server.data).toContain('plain body');
    expect(server.data).toContain('<p>html body</p>');
  });

  it('EMAILBUILD: shows the resolved sender on its own domain, keeps the envelope, refuses others', async () => {
    server = await startServer();
    const mailer = mailerFor(server.port);
    await mailer.send({
      to: 'nadia@brightops.example',
      subject: 'x',
      text: 'body',
      from: { name: 'TManage Support', address: 'support@tmanage.example' },
    });
    expect(server.data).toMatch(/From: "?TManage Support"? <support@tmanage\.example>/u);
    expect(server.envelope[0]).toContain('<no-reply@tmanage.example>');

    await server.close();
    server = await startServer();
    await mailerFor(server.port).send({
      to: 'nadia@brightops.example',
      subject: 'x',
      text: 'body',
      from: { name: 'Bank', address: 'ceo@bank.example' },
    });
    expect(server.data).toMatch(/From: "?Bank"? <no-reply@tmanage\.example>/u);
  });

  it('upgrades via STARTTLS and authenticates only inside the TLS session', async () => {
    server = await startServer({ starttls: true });

    const delivery = await mailerFor(server.port, {
      username: 'no-reply@tmanage.example',
      password: 'mail-credential-under-test',
    }).send({
      to: 'nadia@brightops.example',
      subject: 'authenticated submission',
      text: 'body',
    });

    expect(delivery).toBe('sent');
    // The AUTH PLAIN payload is base64('\0user\0pass') — asserting it whole proves the
    // option names in smtp-mailer.ts reach the wire, which no unauthenticated case can.
    const nul = String.fromCharCode(0);
    const expected = Buffer.from(
      `${nul}no-reply@tmanage.example${nul}mail-credential-under-test`,
      'utf8',
    ).toString('base64');
    expect(server.authLine).toBe(`AUTH PLAIN ${expected}`);
    expect(server.data).toContain('Subject: authenticated submission');
  });

  it('refuses to authenticate over a session that cannot upgrade to TLS', async () => {
    // The downgrade the first review of this slice found: an on-path attacker strips
    // STARTTLS from the EHLO reply, and an opportunistic client would authenticate in
    // cleartext without a line of warning. `requireTLS` makes this fail instead — so a
    // server that offers no STARTTLS gets no password and no message.
    server = await startServer({ starttls: false });

    await expect(
      mailerFor(server.port, {
        username: 'no-reply@tmanage.example',
        password: 'mail-credential-under-test',
      }).send({ to: 'nadia@brightops.example', subject: 'x', text: 'y' }),
    ).rejects.toThrow();

    expect(server.authLine).toBeUndefined();
    expect(server.data).toBe('');
  });

  it('throws when the server refuses the recipient rather than reporting sent', async () => {
    server = await startServer({ rejectRecipients: true });

    await expect(
      mailerFor(server.port).send({
        to: 'nobody@brightops.example',
        subject: 'x',
        text: 'y',
      }),
    ).rejects.toThrow();
  });

  it('throws when nothing is listening', async () => {
    const unused = await startServer();
    const { port } = unused;
    await unused.close();

    await expect(
      mailerFor(port).send({ to: 'nadia@brightops.example', subject: 'x', text: 'y' }),
    ).rejects.toThrow();
  });
});
