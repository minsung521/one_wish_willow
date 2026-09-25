// This visit, worked out once before the stage loads: an anonymous id for this
// browser, whether it has been here before, where it first came from, and
// what it is on. It starts analytics and sends visit_started. Nothing here
// touches the wish.
//
// index.html loads this on its own ahead of main.js, so the visit is counted
// even if the 3D model never finishes loading.

import { APP_VERSION } from './config.js';
import { startAnalytics, track } from './analytics.js';
import { loadRecord } from './storage.js';

const CLIENT_KEY = 'oww_client_id';
const VISITED_KEY = 'oww_visited'; // the first visit's time (ms), which also flags it
const ENTRY_KEY = 'oww_entry';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc.: this visit still works, it just isn't remembered */
  }
}

/** A random v4 UUID, also where crypto.randomUUID is missing (older iOS, http). */
function newId() {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function clientId() {
  const saved = read(CLIENT_KEY);
  if (saved && UUID.test(saved)) return saved.toLowerCase();
  const id = newId();
  write(CLIENT_KEY, id);
  return id;
}

/** Only the origin: a referrer's path can carry personal data. */
function referrerOrigin() {
  try {
    if (!document.referrer) return null;
    const u = new URL(document.referrer);
    if (u.origin === location.origin) return null;
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    return u.host ? `${u.protocol}//${u.host}` : null; // e.g. android-app://com.google.android.gm
  } catch {
    return null;
  }
}

/** Where this browser first came from, fixed on its first visit. */
function firstEntry() {
  try {
    const saved = JSON.parse(read(ENTRY_KEY));
    if (saved && typeof saved.source === 'string') return saved;
  } catch {
    /* recompute */
  }
  const q = new URLSearchParams(location.search);
  const param = (k) => {
    const v = (q.get(k) || '').trim();
    return v ? v.slice(0, 200) : null;
  };
  const referrer = referrerOrigin();
  const utm_source = param('utm_source');
  const entry = {
    // Instagram and KakaoTalk in-app browsers often send no referrer, so
    // without UTM tags those visits land in 'direct'.
    source: q.get('ref') === 'share' ? 'share' : utm_source ? 'utm' : referrer ? 'referral' : 'direct',
    referrer,
    utm_source,
    utm_medium: param('utm_medium'),
    utm_campaign: param('utm_campaign'),
    utm_content: param('utm_content'),
  };
  write(ENTRY_KEY, JSON.stringify(entry));
  return entry;
}

function deviceType() {
  const ua = navigator.userAgent || '';
  // iPadOS reports itself as a Mac; Android tablets leave out "Mobile"
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'tablet';
  if ((navigator.userAgentData && navigator.userAgentData.mobile) || /Mobi|iPhone|iPod|Android|IEMobile|Opera Mini/i.test(ua)) return 'mobile';
  return 'desktop';
}

/** Which in-app browser this is, as one word. The user agent itself is never sent. */
function inAppBrowser() {
  const ua = navigator.userAgent || '';
  if (/Instagram/i.test(ua)) return 'instagram';
  if (/KAKAOTALK/i.test(ua)) return 'kakaotalk';
  if (/FBAN|FBAV|FB_IAB|FBIOS|FB4A|MessengerForiOS|MessengerLite/i.test(ua)) return 'facebook';
  if (/NAVER\(inapp/i.test(ua)) return 'naver';
  if (/ Line\/|Barcelona|musical_ly|BytedanceWebview|TikTok|Snapchat|Twitter|MicroMessenger|WhatsApp|Pinterest|LinkedInApp|DaumApps|KAKAOSTORY|BAND\/|everytimeApp|Telegram|; wv\)/i.test(ua)) return 'other';
  // an iOS web view that isn't Safari (or a browser built on it) has no Safari token
  if (/iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua)) return 'other';
  return 'none';
}

const record = loadRecord(); // read before main.js writes a fresh one
const savedFirst = Number(read(VISITED_KEY)) || 0;
if (!savedFirst) write(VISITED_KEY, String(Date.now()));
const seen = savedFirst > 0 || !!record;
const entry = firstEntry();

export const visit = {
  clientId: clientId(),
  firstVisitAt: savedFirst || Date.now(),
  type: !seen ? 'first' : record && record.state !== 'fresh' ? 'revisit_used' : 'revisit_unused',
  entry,
  deviceType: deviceType(),
  inAppBrowser: inAppBrowser(),
};

startAnalytics({
  clientId: visit.clientId,
  props: { app_version: APP_VERSION, device_type: visit.deviceType, in_app_browser: visit.inAppBrowser },
  once: {
    entry_source: entry.source,
    entry_referrer: entry.referrer,
    entry_utm_source: entry.utm_source,
    entry_utm_medium: entry.utm_medium,
    entry_utm_campaign: entry.utm_campaign,
    entry_utm_content: entry.utm_content,
  },
});
track('visit_started', { visit_type: visit.type });
if (visit.type === 'revisit_unused') track('revisit_unused');
