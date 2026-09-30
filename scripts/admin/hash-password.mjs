// Makes the admin settings for api/admin (MIN-183). Run it on your own
// computer, never in CI, and paste the output into Vercel's environment
// variables; don't commit it or paste it anywhere else.
//
//   node scripts/admin/hash-password.mjs            # asks for a password (not echoed)
//   node scripts/admin/hash-password.mjs --generate # makes a long random one and shows it once
//
// Prints ADMIN_PASSWORD_HASH (scrypt, the password itself is never stored)
// and, with --secret, a fresh ADMIN_SESSION_SECRET as well.

import { randomBytes, scrypt } from 'node:crypto';

const N = 32768;
const r = 8;
const p = 1;
const MIN_LENGTH = 16;

const args = new Set(process.argv.slice(2));

async function ask(prompt) {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.replace(/\r?\n$/, '');
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let v = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(v);
      } else if (ch === '\u0003') {
        process.exit(1);
      } else if (ch === '\u007f') {
        v = v.slice(0, -1);
      } else {
        v += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

let password;
if (args.has('--generate')) {
  password = randomBytes(24).toString('base64url');
  console.log(`Admin password (shown once, keep it in a password manager):\n  ${password}\n`);
} else {
  password = await ask('Admin password: ');
}
if (password.length < MIN_LENGTH) {
  console.error(`Use at least ${MIN_LENGTH} characters (or --generate).`);
  process.exit(1);
}

const salt = randomBytes(16);
const hash = await new Promise((resolve, reject) => {
  scrypt(password, salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
});
console.log(`ADMIN_PASSWORD_HASH=scrypt:${N}:${r}:${p}:${salt.toString('base64url')}:${hash.toString('base64url')}`);
if (args.has('--secret')) console.log(`ADMIN_SESSION_SECRET=${randomBytes(32).toString('base64url')}`);
