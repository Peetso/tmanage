// Generate a cryptographically strong secret for the Hostinger environment.
//
//   node generate-secret.mjs          → a 32-byte base64url secret (SESSION_SECRET, CSRF_SECRET)
//   node generate-secret.mjs --mfa    → an AUTH_MFA_SEED_KEYS line (1:<32 bytes base64url>)
//
// Run it once per secret. Paste the output into the matching hPanel environment variable and
// keep it nowhere else. Never commit a real value.
import { randomBytes } from 'node:crypto';

const key = () => randomBytes(32).toString('base64url');

if (process.argv.includes('--mfa')) {
  // The keyring format is `<version>:<base64url 32 bytes>`; version 1 is the first key. To
  // rotate later, append `;2:<new key>` and run the API's mfa:encrypt-seeds command.
  process.stdout.write(`1:${key()}\n`);
} else {
  process.stdout.write(`${key()}\n`);
}
