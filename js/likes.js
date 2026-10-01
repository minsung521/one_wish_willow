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
const RECEIVED = 'Received';
const ASK = 'Get notified';
const ASK_WHAT = "We'll email you when people ♥ your wish.";
const EMAIL_LABEL = 'Email address';
const PLACEHOLDER = 'your@email.com';
const FINE = 'Only for this. Deleted after 6 months.';
const NOTIFY = 'Notify';
const DONE = "✓ We'll email you.";
const MORE = 'More';
const LESS = 'Less';

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

/** "+3 new", or nothing when it didn't grow (or this is the first look). */
function sinceBadge(delta) {
  if (!(delta > 0)) return null;
  const d = document.createElement('span');
  d.className = 'likes-since';
  d.textContent = `+${delta} new`;
  return d;
}

/**
 * Long wishes are cut to a few lines with "More" under them; More (or a tap
 * on the text) shows all of it, and "Less" folds it again. Only texts that
 * really overflow get it, worked out for all of them at once after they are
 * on the page: every height is read first, then the buttons are added, so
 * the list is laid out once rather than once per wish.
 *
 * @param {HTMLElement[]} els texts already in the document, clamped by CSS
 */
let expandIds = 0;
export function makeExpandable(els) {
  const over = els.map((el) => el.scrollHeight > el.clientHeight + 1);
  els.forEach((el, i) => {
    if (!over[i]) return;
    if (!el.id) el.id = `wish-text-${++expandIds}`;
    el.classList.add('can-open');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'more-toggle';
    btn.textContent = MORE;
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', el.id);
    const toggle = () => {
      const open = !el.classList.contains('open');
      el.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? LESS : MORE;
    };
    btn.addEventListener('click', toggle);
    el.addEventListener('click', toggle); // a tap on the text does the same; the button is the control
    el.after(btn);
  });
}

// ------------------------------------------------------------------ the card in the feed

/**
 * The visitor's own wish, pinned at the top of the feed on a faint panel (no
 * outline): a small "Your wish" label, the wish itself on up to three lines
 * (More for the rest), and on the right "Received ♥ 12" with "+3 new", so
 * it doesn't read as a heart they pressed. Not approved, or private (MIN-194): "Only you can see
 * this for now." beside the label and no number. Under it, unless an email
 * is already in for this client_id, a small "Get notified" that opens the
 * email form in place (MIN-158's storage and notice).
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

  const head = document.createElement('div');
  head.className = 'my-wish-head';
  const label = document.createElement('p');
  label.className = 'my-wish-label';
  label.textContent = 'Your wish';
  if (!approved) {
    const priv = document.createElement('span');
    priv.className = 'my-wish-private';
    priv.textContent = ONLY_YOU;
    label.append(' ', priv);
  }
  head.append(label);

  let delta = null;
  if (approved) {
    delta = likeDelta(wish.likes);
    const count = document.createElement('p');
    count.className = 'my-wish-count';
    if (wish.likes === 0) count.classList.add('zero');
    const word = document.createElement('span');
    word.className = 'my-wish-received';
    word.textContent = RECEIVED;
    const n = document.createElement('span');
    n.className = 'my-wish-n';
    n.append(heart(), ` ${wish.likes}`);
    count.append(word, ' ', n);
    const badge = sinceBadge(delta);
    if (badge) count.append(' ', badge);
    count.setAttribute('aria-label', `Received ${wish.likes} likes${delta > 0 ? `, ${delta} new` : ''}`);
    head.append(count);
    rememberShown(wish.likes);
  }

  const text = document.createElement('p');
  text.className = 'my-wish-text ph-no-capture ph-mask';
  text.textContent = wish.text; // never interpret a submitted wish as HTML
  card.append(head, text);
  if (!data.email_submitted) card.append(emailAsk(screen));
  root.replaceChildren(card);
  root.hidden = false;
  makeExpandable([text]);

  const status = approved ? 'approved' : wish.status === 'private' ? 'private' : 'pending';
  track('my_wish_viewed', { status, ...countProps(wish, delta) });
}

/**
 * The email ask: only a small "Get notified" until it is pressed, then, in
 * the card, what it is for, an "Email address" field with its button, and
 * the six-month notice. email_cta_shown goes once the button is on screen.
 */
function emailAsk(screen) {
  const box = document.createElement('div');
  box.className = 'my-wish-email';
  const formId = 'my-wish-form';

  const ask = document.createElement('button');
  ask.type = 'button';
  ask.className = 'my-wish-ask';
  ask.textContent = ASK;
  ask.setAttribute('aria-expanded', 'false');
  ask.setAttribute('aria-controls', formId);

  const form = document.createElement('form');
  form.id = formId;
  form.className = 'my-wish-form';
  form.noValidate = true;
  form.hidden = true;
  const what = document.createElement('p');
  what.className = 'my-wish-what';
  what.textContent = ASK_WHAT;
  const label = document.createElement('label');
  label.className = 'my-wish-field-label';
  label.htmlFor = 'my-wish-input';
  label.textContent = EMAIL_LABEL;
  const row = document.createElement('div');
  row.className = 'my-wish-row';
  const input = document.createElement('input');
  Object.assign(input, { id: 'my-wish-input', type: 'email', name: 'email', placeholder: PLACEHOLDER, autocomplete: 'email', maxLength: 254, spellcheck: false });
  input.className = 'my-wish-input ph-no-capture ph-mask';
  input.setAttribute('inputmode', 'email');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('enterkeyhint', 'send');
  input.setAttribute('aria-describedby', 'my-wish-fine my-wish-error');
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'my-wish-submit';
  submit.textContent = NOTIFY;
  row.append(input, submit);
  const error = document.createElement('p');
  error.id = 'my-wish-error';
  error.className = 'my-wish-error';
  error.setAttribute('role', 'alert');
  const fine = document.createElement('p');
  fine.id = 'my-wish-fine';
  fine.className = 'my-wish-fine';
  fine.textContent = FINE;
  form.append(what, label, row, error, fine);

  const done = document.createElement('p');
  done.className = 'my-wish-done';
  done.setAttribute('role', 'status');
  done.textContent = DONE;
  done.hidden = true;

  ask.addEventListener('click', () => {
    const open = form.hidden;
    form.hidden = !open;
    ask.setAttribute('aria-expanded', String(open));
    if (open) input.focus({ preventScroll: true });
  });
  const showError = (msg) => {
    error.textContent = msg;
    if (msg) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };
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

  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((en) => en.isIntersecting)) return;
      io.disconnect();
      track('email_cta_shown');
    }, { threshold: 0.6 });
    io.observe(ask);
  } else track('email_cta_shown');

  box.append(ask, form, done);
  return box;
}

// ------------------------------------------------------------------ the revisit toast

/**
 * On the revisit screen only, once the visitor's own wish is known:
 * "Your wish got ♥ 12  +3 new" and the way to the feed. With no likes yet
 * (or not approved, or private), only the button. It stays until closed (×) and sits at
 * the top, clear of the lines in the middle and of Share at the bottom.
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
      const n = document.createElement('span');
      n.className = 'likes-toast-n';
      n.append(heart(), ` ${wish.likes}`);
      this.line.replaceChildren('Your wish got ', n);
      const badge = sinceBadge(delta);
      if (badge) this.line.append(' ', badge);
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
