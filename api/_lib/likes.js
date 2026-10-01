// Shared by the like API (api/like.js), the visitor's own wish
// (api/my-wish.js) and the feed (api/social.js), MIN-160.
//
// What a wish shows is its real likes plus seed_likes. That sum is made here
// and nowhere else; queries always select the two apart, so analytics can
// still be sent the real count.

import { createHash } from 'node:crypto';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The server's switch, off unless LIKES_ENABLED=true (the page has its own, js/config.js). */
export const likesEnabled = () => process.env.LIKES_ENABLED === 'true';

/** The number a wish shows: real likes + seed_likes. */
export function displayLikes(actual, seed) {
  return toCount(actual) + toCount(seed);
}

/** A count from Postgres (int8 comes back as a string) as a non-negative integer. */
export function toCount(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** A lower-cased client_id, or null when it isn't a UUID. */
export function clientIdOf(v) {
  return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null;
}

/** A wish id (a positive bigint that fits a JS number), or null. */
export function wishIdOf(v) {
  const n = typeof v === 'string' && /^[1-9]\d{0,14}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * SHA-256 of the IP, a secret and today's UTC date, as api/wish.js keeps it
 * (MIN-121): the same address hashes differently each day, and the raw IP is
 * never stored.
 */
export function ipHash(headers, secret) {
  const ip = (headers.get('x-forwarded-for') || '').split(',')[0].trim();
  if (!ip) return null;
  const day = new Date().toISOString().slice(0, 10);
  return createHash('sha256').update(ip + secret + day).digest('hex');
}

/** A Postgres SQLSTATE or the error's class name, never its message. */
export function errorCode(err) {
  if (err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return err.code;
  return (err && typeof err.name === 'string' && err.name) || 'unknown';
}

export function reply(status, body) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
