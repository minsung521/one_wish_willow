// The maker's admin session (MIN-183), shared by api/admin/*.js. Files under
// api/_lib are not routes.
//
// One admin, one password. The password is never stored: ADMIN_PASSWORD_HASH
// holds its scrypt hash (made with scripts/admin/hash-password.mjs), and a
// good login gets a signed, expiring session in an HttpOnly, Secure,
// SameSite=Strict cookie. The signing key is derived from
// ADMIN_SESSION_SECRET and the password hash, so changing either one signs
// every session out. Without both variables the admin API answers 404, as if
// it weren't there.
//
// Requests that change something must come from this same origin (Origin, or
// Sec-Fetch-Site where a browser sends no Origin) and carry a JSON body, so a
// form or a script on another site can't make them with the cookie.
//
// Nothing here logs a password, a cookie, a body or an address.

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const COOKIE = '__Host-oww_admin';
const SESSION_S = 12 * 60 * 60; // a session lasts 12 hours
const MIN_SECRET = 32;

// Login attempts. Kept in the function's memory, so the limit is per
// instance; the password's own strength (a long random one) and scrypt's cost
// are what make guessing hopeless, the limit only slows it down further.
const WINDOW_MS = 15 * 60 * 1000;
const PER_IP = 5; // failures per address per window
const OVERALL = 30; // failures from everyone per window, per instance
const failures = new Map(); // key -> timestamps of failed attempts

export const STATUSES = ['pending', 'approved', 'rejected', 'hidden'];

/** The admin settings, or null when the admin API is switched off. */
export function adminConfig() {
  const { ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: secret } = process.env;
  if (typeof secret !== 'string' || secret.length < MIN_SECRET) return null;
  const parsed = parseHash(hash);
  if (!parsed) return null;
  const key = createHmac('sha256', secret).update('oww-admin-session\0' + hash).digest();
  return { hash: parsed, key };
}

/** scrypt:N:r:p:salt:hash, salt and hash in base64url (no $, which some .env loaders expand) */
function parseHash(v) {
  if (typeof v !== 'string') return null;
  const m = /^scrypt:(\d{5,7}):(\d{1,2}):(\d{1,2}):([A-Za-z0-9_-]{16,}):([A-Za-z0-9_-]{43,})$/.exec(v);
  if (!m) return null;
  const N = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  if (N < 16384 || (N & (N - 1)) !== 0 || r < 1 || p < 1) return null;
  return { N, r, p, salt: Buffer.from(m[4], 'base64url'), hash: Buffer.from(m[5], 'base64url') };
}

export async function checkPassword(config, password) {
  const { N, r, p, salt, hash } = config.hash;
  const got = await new Promise((resolve, reject) => {
    scrypt(password, salt, hash.length, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return timingSafeEqual(got, hash);
}

// ------------------------------------------------------------ session

function sign(config, payload) {
  return createHmac('sha256', config.key).update(payload).digest('base64url');
}

/** A new session: its cookie header and when it ends. */
export function newSession(config) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_S;
  const payload = `v1.${exp}.${randomBytes(16).toString('base64url')}`;
  const token = `${payload}.${sign(config, payload)}`;
  return {
    cookie: `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_S}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** The session on this request, { expiresAt }, or null. */
export function readSession(config, request) {
  const token = readCookie(request.headers.get('cookie'), COOKIE);
  if (!token || token.length > 200) return null;
  const m = /^(v1\.(\d{1,12})\.[A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const want = Buffer.from(sign(config, m[1]));
  const got = Buffer.from(m[3]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const exp = Number(m[2]);
  const now = Math.floor(Date.now() / 1000);
  if (exp <= now || exp > now + SESSION_S) return null;
  return { expiresAt: new Date(exp * 1000).toISOString() };
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// ------------------------------------------------------------ requests

/** Whether a state-changing request comes from this site's own pages. */
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return request.headers.get('sec-fetch-site') === 'same-origin';
  const allowed = new Set([new URL(request.url).origin]);
  for (const h of [request.headers.get('x-forwarded-host'), request.headers.get('host')]) {
    if (!h) continue;
    allowed.add(`https://${h}`);
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h)) allowed.add(`http://${h}`);
  }
  return allowed.has(origin);
}

/** The JSON object in the body, or null (wrong type, too big, malformed). */
export async function readJson(request, max = 1024) {
  const type = request.headers.get('content-type') || '';
  if (!/^application\/json\b/i.test(type)) return null;
  const raw = await request.text();
  if (raw.length > max) return null;
  try {
    const body = JSON.parse(raw);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

export function reply(status, body, headers = {}) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex', ...headers },
  });
}

// ------------------------------------------------------------ login limit

function clientKey(request) {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  return createHash('sha256').update(ip).digest('base64url').slice(0, 22);
}

function recent(key, now) {
  const list = (failures.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

/** Seconds to wait before the next login attempt, or 0. */
export function loginBlocked(request) {
  const now = Date.now();
  const mine = recent(clientKey(request), now);
  const all = recent('*', now);
  const full = mine.length >= PER_IP ? mine : all.length >= OVERALL ? all : null;
  if (!full) return 0;
  return Math.max(1, Math.ceil((full[0] + WINDOW_MS - now) / 1000));
}

export function loginFailed(request) {
  const now = Date.now();
  for (const key of [clientKey(request), '*']) failures.set(key, [...recent(key, now), now]);
  // never let it grow without bound: drop the oldest addresses, keep the overall count
  for (const key of failures.keys()) {
    if (failures.size <= 5000) break;
    if (key !== '*') failures.delete(key);
  }
}

export function loginSucceeded(request) {
  failures.delete(clientKey(request));
}

/** A Postgres SQLSTATE or the error's class name, never its message. */
export function errorCode(err) {
  if (err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return err.code;
  return (err && typeof err.name === 'string' && err.name) || 'unknown';
}
