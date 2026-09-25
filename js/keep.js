// Keeping the wish: the one request that carries the wish text, and the only
// place it ever goes (api/wish.js). The text is never written to storage,
// never logged and never put in an event; it only lives in this request.
//
// Fire and forget: the burn never waits for it, and a failure is neither shown
// nor retried. wish_store_result records how it went.

import { WISH_API, APP_VERSION } from './config.js';
import { track } from './analytics.js';
import { visit } from './visit.js';

const TIMEOUT = 5000;

/**
 * @param {string} text the wish, already trimmed
 * @param {number|null} snapToSubmitMs time from the snap to the confirm
 */
export function keepWish(text, snapToSubmitMs) {
  const t0 = performance.now();
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let settled = false;
  const settle = (status) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    track('wish_store_result', { status, latency_ms: Math.round(performance.now() - t0) });
  };
  const timer = setTimeout(() => {
    settle('timeout');
    if (ctrl) ctrl.abort();
  }, TIMEOUT);

  let body = JSON.stringify({
    wish_text: text,
    client_id: visit.clientId,
    locale: navigator.language || null,
    tz_offset: -new Date().getTimezoneOffset(), // minutes ahead of UTC (Seoul: 540)
    device_type: visit.deviceType,
    referrer: visit.entry.referrer,
    utm_source: visit.entry.utm_source,
    snap_to_submit_ms: snapToSubmitMs,
    app_version: APP_VERSION,
  });
  text = null;

  let req;
  try {
    req = fetch(WISH_API, {
      method: 'POST',
      keepalive: true, // still delivered if the tab is closed during the burn
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body,
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (err) {
    req = Promise.reject(err);
  }
  body = null;

  req.then(
    (res) => settle(res.status === 201 ? 'ok' : res.status === 429 ? 'rate_limited' : 'error'),
    () => settle('error'),
  );
}
