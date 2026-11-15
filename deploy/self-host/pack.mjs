// 54-19. Pack the self-host kit: deploy/self-host/out/tmanage-self-host-<version>.tar.gz + .sha256
//
//   pnpm deploy:hostinger && node deploy/self-host/pack.mjs
//
// The kit is the cloud bundle (deploy/hostinger/out/tmanage-hostinger.zip, renamed) plus the
// files beside this script and the operator docs. No image registry is involved: the operator's
// `./tmanage install` builds the image locally (the plan's bundle-only default). Publish the
// .sha256 value with the release; install.sh and `tmanage update --sha256` refuse a mismatch.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const BUNDLE = join(REPO, 'deploy/hostinger/out/tmanage-hostinger.zip');
const DOCS = join(REPO, 'docs/ops/self-host');

if (!existsSync(BUNDLE)) {
  process.stderr.write(`no bundle at ${BUNDLE}: run pnpm deploy:hostinger first\n`);
  process.exit(1);
}
const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
const { version: base } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
// `-` not `+`: the version is also the local image tag, and Docker tags refuse `+`.
const version = `${base}-${sha.stdout.trim() || 'local'}`;
const name = `tmanage-self-host-${version}`;
const out = join(HERE, 'out');
const kit = join(out, name);

rmSync(kit, { recursive: true, force: true });
mkdirSync(kit, { recursive: true });
copyFileSync(BUNDLE, join(kit, 'tmanage-bundle.zip'));
for (const file of ['Dockerfile', 'compose.yaml', 'Caddyfile', 'tmanage', 'install.sh']) {
  copyFileSync(join(HERE, file), join(kit, file));
}
for (const file of ['README.en.md', 'README.ar.md', 'ENV-REFERENCE.md']) {
  copyFileSync(join(DOCS, file), join(kit, file));
}
writeFileSync(join(kit, 'VERSION'), `${version}\n`);

const archive = join(out, `${name}.tar.gz`);
rmSync(archive, { force: true });
// Windows: System32 bsdtar (Git Bash's GNU tar mangles drive paths); elsewhere the system tar.
const tar =
  process.platform === 'win32'
    ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
const packed = spawnSync(tar, ['-czf', archive, '-C', out, name], { stdio: 'inherit' });
if (packed.status !== 0) process.exit(packed.status ?? 1);

const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);
process.stdout.write(`kit: ${archive}\nsha256: ${digest}\n`);
