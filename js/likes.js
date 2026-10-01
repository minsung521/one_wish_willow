// Likes (MIN-160): the visitor's own wish and how many people liked it, the
// heart on each wish in the feed, the card pinned at the top of the feed and
// the toast on the revisit screen. Everything here is behind LIKES_ENABLED
// (and SOCIAL_ENABLED); with either off, none of it runs.
//
// The like count shown is always the one the server sends (real likes plus
// seed_likes, api/_lib/likes.js). Events get the real count, `like_count`,
// and the shown one as `display_like_count`.
//
// "Since your last visit": the count last put on screen is kept in
// localStorage (oww_last_likes). It is read once when the page loads, so the
// toast and the card show the same increase on one visit, and written each
// time the count is shown.

import { LIKES_ENABLED, SOCIAL_ENABLED, LIKE_API, MY_WISH_API } from './config.js';
import { track } from './analytics.js';
import { visit } from './visit.js';
import { BAD_EMAIL, FAILED, emailLooksRight, postInterest } from './interest.js';

export const likesOn = SOCIAL_ENABLED && LIKES_ENABLED;

const TIMEOUT = 8000;
const LAST_KEY = 'oww_last_likes';
const SVG = 'http://www.w3.org/2000/svg';

const ONLY_YOU = 'Only you can see this for now.';
const CTA = "Want to know how many people wish for this too? We'll email you.";
const FINE = 'Only for this. Deleted after 6 months.';
const NOTIFY = 'Notify me';
const DONE = "Got it! We'll write to you.";

// ------------------------------------------------------------------ data

let mine = null; // the pending or settled request for the visitor's own wish

/**
 * The visitor's own wish: { wish: { id, text, status, likes, like_count } | null,
 * email_submitted }, or null when it couldn't be asked. A wish just made may
 * not be stored yet, so only an answer with a wish is kept for the visit.
 */
export function loadMyWish() {
  if (!likesOn) return Promise.resolve(null);
  if (mine) return mine;
  const req = getJson(`${MY_WISH_API}?client_id=${encodeURIComponent(visit.clientId)}`).then((data) => {
    const ok = data && typeof data.email_submitted === 'boolean' && (data.wish === null || validWish(data.wish));
    if (!ok || !data.wish) mine = null;
    return ok ? data : null;
  });
  mine = req;
  return req;
}

function validWish(w) {
  return w && typeof w.id === 'number' && typeof w.text === 'string' && typeof w.status === 'string';
}

/** The email was just left: later cards on this visit don't ask again. */
function emailLeft() {
  if (!mine) return;
  mine = mine.then((data) => (data ? { ...data, email_submitted: true } : data));
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Like or unlike someone else's wish.
 * @returns {Promise<{ ok: boolean, liked?: boolean, likes?: number|null, status: number }>}
 */
export async function sendLike(wishId, like) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(LIKE_API, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wish_id: wishId, client_id: visit.clientId, action: like ? 'like' : 'unlike' }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    if (!data || typeof data.liked !== 'boolean') return { ok: false, status: res.status };
    return { ok: true, status: res.status, liked: data.liked, likes: typeof data.likes === 'number' ? data.likes : null };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ since the last visit

const lastShown = (() => {
  try {
    const n = Number(localStorage.getItem(LAST_KEY));
    return localStorage.getItem(LAST_KEY) !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
})();

/** The increase since the count was last shown; null on the first look. */
export function likeDelta(count) {
  return lastShown === null ? null : Math.max(0, count - lastShown);
}

/** The count was put on screen: the next visit measures from it. */
export function rememberShown(count) {
  try {
    localStorage.setItem(LAST_KEY, String(count));
  } catch {
    /* private mode: no increase next time, nothing else changes */
  }
}

/** The properties both my_wish_viewed and the revisit toast's events carry. */
export function countProps(wish, delta) {
  const approved = wish.status === 'approved';
  return {
    like_count: approved ? wish.like_count : null,
    display_like_count: approved ? wish.likes : null,
    like_delta: delta,
  };
}

// ------------------------------------------------------------------ pieces

/** A heart, drawn rather than typed, so no phone turns it into an emoji. */
export function heart(className = 'heart') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M12 20.6 10.6 19.3C5.6 14.8 2.4 11.9 2.4 8.3 2.4 5.4 4.7 3.2 7.5 3.2c1.6 0 3.2.8 4.5 2 1.3-1.2 2.9-2 4.5-2 2.8 0 5.1 2.2 5.1 5.1 0 3.6-3.2 6.5-8.2 11L12 20.6Z');
  svg.append(path);
  return svg;
}

const wishedFor = (n) => `${n} ${n === 1 ? 'person' : 'people'} wished for this too.`;
const since = (d) => `+${d} since your last visit`;

/** "♥ 12 people wished for this too." with "(+3 since your last visit)" when it grew. */
function countLine(className, likes, delta) {
  const p = document.createElement('p');
  p.className = className;
  p.append(heart(), document.createTextNode(` ${wishedFor(likes)}`));
  if (delta > 0) {
    const d = document.createElement('span');
    d.className = 'likes-since';
    d.textContent = ` (${since(delta)})`;
    p.append(d);
  }
  return p;
}

// ------------------------------------------------------------------ the card in the feed

/**
 * The visitor's own wish, pinned at the top of the feed: highlighted, a
 * count but no heart to press. Approved: "♥ 12 people wished for this too.";
 * otherwise only they can see it, and no count. Under it, unless an email is
 * already in for this client_id, the inline email ask (MIN-158's storage).
 *
 * @param {HTMLElement} root the empty container
 * @param {{ wish: object, email_submitted: boolean }} data from loadMyWish()
 * @param {string} screen where the feed was opened from, for email_submitted
 */
export function renderMyWish(root, data, screen) {
  const { wish } = data;
  const approved = wish.status === 'approved';
  const card = document.createElement('section');
  card.className = 'my-wish';
  card.setAttribute('aria-label', 'Your wish');

  const kicker = document.createElement('p');
  kicker.className = 'my-wish-kicker';
  kicker.textContent = 'Your wish';
  const text = document.createElement('p');
  text.className = 'my-wish-text ph-no-capture ph-mask';
  text.textContent = wish.text; // never interpret a submitted wish as HTML
  card.append(kicker, text);

  let delta = null;
  if (approved) {
    delta = likeDelta(wish.likes);
    card.append(countLine('my-wish-count', wish.likes, delta));
    rememberShown(wish.likes);
  } else {
    const p = document.createElement('p');
    p.className = 'my-wish-private';
    p.textContent = ONLY_YOU;
    card.append(p);
  }

  if (!data.email_submitted) card.append(emailAsk(screen));
  root.replaceChildren(card);
  root.hidden = false;

  track('my_wish_viewed', { status: approved ? 'approved' : 'pending', ...countProps(wish, delta) });
  if (!data.email_submitted) track('email_cta_shown');
}

/** The ask, a line to tap; the field opens in the card itself (no dialog, no toast). */
function emailAsk(screen) {
  const box = document.createElement('div');
  box.className = 'my-wish-email';
  const formId = 'my-wish-email-form';

  const ask = document.createElement('button');
  ask.type = 'button';
  ask.className = 'my-wish-ask';
  ask.textContent = CTA;
  ask.setAttribute('aria-expanded', 'false');
  ask.setAttribute('aria-controls', formId);

  const form = document.createElement('form');
  form.id = formId;
  form.className = 'my-wish-form';
  form.noValidate = true;
  form.hidden = true;
  const input = document.createElement('input');
  Object.assign(input, { type: 'email', name: 'email', placeholder: 'your@email.com', autocomplete: 'email', maxLength: 254, spellcheck: false });
  input.className = 'interest-input ph-no-capture ph-mask';
  input.setAttribute('aria-label', 'Your email');
  input.setAttribute('inputmode', 'email');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('enterkeyhint', 'send');
  input.setAttribute('aria-describedby', 'my-wish-fine my-wish-error');
  const fine = document.createElement('p');
  fine.id = 'my-wish-fine';
  fine.className = 'interest-fine';
  fine.textContent = FINE;
  const error = document.createElement('p');
  error.id = 'my-wish-error';
  error.className = 'interest-error';
  error.setAttribute('role', 'alert');
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'interest-submit';
  submit.textContent = NOTIFY;
  form.append(input, fine, error, submit);

  const done = document.createElement('p');
  done.className = 'my-wish-done';
  done.setAttribute('role', 'status');
  done.textContent = DONE;
  done.hidden = true;

  const showError = (msg) => {
    error.textContent = msg;
    if (msg) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };
  ask.addEventListener('click', () => {
    if (!form.hidden) return;
    form.hidden = false;
    ask.setAttribute('aria-expanded', 'true');
    input.focus({ preventScroll: true });
    form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  input.addEventListener('input', () => { if (input.getAttribute('aria-invalid') === 'true') showError(''); });
  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const email = input.value.trim();
    if (!emailLooksRight(email)) {
      showError(BAD_EMAIL);
      input.focus({ preventScroll: true });
      return;
    }
    showError('');
    busy = true;
    submit.disabled = true;
    const status = await postInterest(email);
    busy = false;
    submit.disabled = false;
    if (status === 201) {
      // the address itself never goes into an event
      track('email_submitted', { screen, source: 'feed_my_wish' });
      emailLeft();
      input.value = '';
      ask.hidden = true;
      form.hidden = true;
      done.hidden = false;
      done.tabIndex = -1;
      done.focus({ preventScroll: true });
    } else {
      showError(status === 400 ? BAD_EMAIL : FAILED);
    }
  });

  box.append(ask, form, done);
  return box;
}

// ------------------------------------------------------------------ the revisit toast

/**
 * On the revisit screen only, once the visitor's own wish is known: how many
 * people wished for it too and the way to the feed. With no likes yet (or
 * not approved), only the button. It stays until closed (×) and sits at the
 * top, clear of the lines in the middle and of Share at the bottom.
 */
export class RevisitToast {
  /** @param {{ onGo: () => void }} hooks onGo: the button was pressed */
  constructor({ onGo }) {
    this.root = document.getElementById('likes-toast');
    this.line = document.getElementById('likes-toast-line');
    this.go = document.getElementById('likes-toast-go');
    this.props = null;
    document.getElementById('likes-toast-close').addEventListener('click', () => this.close());
    this.go.addEventListener('click', () => {
      track('revisit_toast_clicked', this.props);
      this.close();
      onGo();
    });
  }

  /** @param {{ wish: object }} data from loadMyWish(), with a wish */
  show(data) {
    const { wish } = data;
    const counted = wish.status === 'approved' && wish.likes >= 1;
    let delta = null;
    if (counted) {
      delta = likeDelta(wish.likes);
      this.line.replaceWith(countLine('likes-toast-line', wish.likes, delta));
      this.line = this.root.querySelector('.likes-toast-line');
      this.line.id = 'likes-toast-line';
      rememberShown(wish.likes);
    }
    this.line.hidden = !counted;
    this.root.classList.toggle('bare', !counted);
    this.props = countProps(wish, delta);
    this.root.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => this.root.classList.add('on')));
    track('revisit_toast_shown', this.props);
  }

  close() {
    this.root.classList.remove('on');
    setTimeout(() => { if (!this.root.classList.contains('on')) this.root.hidden = true; }, 500);
  }
}
