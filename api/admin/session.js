// /api/admin/session: the maker's login (MIN-183). See api/_lib/admin.js.
//
//   GET    -> 200 { authenticated: true, expires_at } | 401 { status: 'unauthorized' }
//   POST   { password } -> 200 { authenticated: true, expires_at } + session cookie
//            | 401 { status: 'invalid_password' } | 429 { status: 'rate_limited' } (Retry-After)
//   DELETE -> 200 { authenticated: false }, the cookie cleared (logout)
//
// POST and DELETE from another origin: 403 { status: 'forbidden' }.
// Admin switched off (no ADMIN_PASSWORD_HASH / ADMIN_SESSION_SECRET): 404 { status: 'closed' }.

import {
  adminConfig, checkPassword, clearCookie, errorCode, loginBlocked, loginFailed, loginSucceeded,
  newSession, readJson, readSession, reply, sameOrigin,
} from '../_lib/admin.js';

const MAX_PASSWORD = 256;

export async function GET(request) {
  const config = adminConfig();
  if (!config) return reply(404, { status: 'closed' });
  const session = readSession(config, request);
  if (!session) return reply(401, { status: 'unauthorized' });
  return reply(200, { authenticated: true, expires_at: session.expiresAt });
}

export async function POST(request) {
  try {
    const config = adminConfig();
    if (!config) return reply(404, { status: 'closed' });
    if (!sameOrigin(request)) return reply(403, { status: 'forbidden' });
    const wait = loginBlocked(request);
    if (wait) return reply(429, { status: 'rate_limited', retry_after: wait }, { 'retry-after': String(wait) });
    const body = await readJson(request);
    const password = body && body.password;
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD) {
      return reply(400, { status: 'invalid' });
    }
    if (!(await checkPassword(config, password))) {
      loginFailed(request);
      return reply(401, { status: 'invalid_password' });
    }
    loginSucceeded(request);
    const session = newSession(config);
    return reply(200, { authenticated: true, expires_at: session.expiresAt }, { 'set-cookie': session.cookie });
  } catch (err) {
    console.error('admin_login_failed', errorCode(err));
    return reply(500, { status: 'error' });
  }
}

export async function DELETE(request) {
  if (!adminConfig()) return reply(404, { status: 'closed' });
  if (!sameOrigin(request)) return reply(403, { status: 'forbidden' });
  return reply(200, { authenticated: false }, { 'set-cookie': clearCookie });
}
