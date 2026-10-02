// Others' wishes (MIN-122): a full-screen, scrolled list of the wishes the
// maker approved one by one (api/social.js), 20 at a time. Opened from the
// "See others' wishes" buttons when SOCIAL_ENABLED is on (js/main.js).
//
// Every wish is put on the page as text, never as HTML, and the list is kept
// out of session replays. Closing it (Back, Escape) returns to where it was
// opened, the wish screen's unsent text included: nothing there is touched.
//
// With likes on (MIN-160, js/likes.js) each wish gets a heart, the visitor's
// own wish is pinned above the list instead of in it, and the visitor picks
// the order (MIN-196): Popular (the default), Latest or Random, remembered in
// localStorage. The server sorts and pages by offset.

import { SOCIAL_API, SOCIAL_ENABLED } from './config.js';
import { track } from './analytics.js';
import { visit } from './visit.js';
import { likesOn, loadMyWish, renderMyWish, sendLike, heart, makeExpandable } from './likes.js';

const TIMEOUT = 8000;
const LOADING = 'Gathering wishes…';
const LOADING_MORE = 'Gathering more…';
const MORE = 'See more wishes';
const RETRY = 'Try again';
const EMPTY = 'No wishes to show yet. Come back soon.';
const FAILED = "Couldn't load wishes. Please check your connection and try again.";

const SORT_KEY = 'oww_feed_sort';
const SORTS = [['popular', 'Popular'], ['latest', 'Latest'], ['random', 'Random']];

/** The order picked last time, or Popular. */
function savedSort() {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return SORTS.some(([k]) => k === v) ? v : 'popular';
  } catch {
    return 'popular';
  }
}

export class SocialFeed {
  /**
   * @param {{ onOpen?: (screen: string) => void, onClose?: (screen: string) => void }} hooks
   *   called with the screen it was opened from
   */
  constructor({ onOpen, onClose } = {}) {
    this.dlg = document.getElementById('social');
    this.list = document.getElementById('social-list');
    this.status = document.getElementById('social-status');
    this.more = document.getElementById('social-more');
    this.back = document.getElementById('social-back');
    this.mine = document.getElementById('social-mine');
    // likes on: the order, just above the list (under the pinned card), right-aligned
    this.sort = likesOn ? savedSort() : null;
    this.sortBar = likesOn ? this._makeSortBar() : null;
    if (this.sortBar) this.list.before(this.sortBar);
    this.skeleton = likesOn ? makeSkeleton() : null;
    if (this.skeleton) this.list.before(this.skeleton);
    // likes on: a shorter top (no intro line), so others' wishes come up sooner
    if (likesOn) this.dlg.classList.add('likes');
    // The first opening lays the whole feed out for the first time, which is
    // most of what a tap on "See others' wishes" costs. Do that once while the
    // page is idle, invisibly and within one task (nothing is painted), so the
    // tap itself only has to show it.
    if (SOCIAL_ENABLED) whenIdle(() => this._warm());
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.cursor = null;
    this.busy = false;
    this.generation = 0;
    this.request = null;
    this.opener = null;
    this.screen = null;
    this.back.addEventListener('click', () => this.close());
    this.more.addEventListener('click', () => this.load());
    this.dlg.addEventListener('close', () => this._closed());
  }

  /**
   * @param {'wish'|'final'|'revisit'} screen where it was opened from
   * @param {'final'|'revisit_button'|'revisit_toast'|'input_screen'} [entry]
   *   which way in, for the event's `entry` (likes on only)
   */
  open(screen, entry) {
    if (this.dlg.open) return;
    this.opener = document.activeElement;
    this.screen = screen;
    this.generation++;
    if (this.request) this.request.abort();
    this.busy = false;
    this.list.replaceChildren();
    this.cursor = null;
    // likes: one shuffle and one ranking time per opening, so the pages agree
    this.mix = likesOn ? freshOrder(this.sort) : null;
    this.mine.replaceChildren();
    this.mine.hidden = true;
    this.more.hidden = true;
    this.status.textContent = '';
    try {
      this.dlg.showModal();
    } catch {
      this.dlg.setAttribute('open', ''); // no <dialog> support: shown, just not modal
    }
    // The tap only puts the feed's frame up (with a few grey rows when likes
    // are on, the loading line when not); the requests, the event and the
    // rest wait until that frame is painted. Focus and the scroll reset each
    // make the browser lay the page out there and then, so they wait too (a
    // reopened dialog starts at the top). MIN-160, for any feed since MIN-195.
    if (this.skeleton) this._skeleton(true);
    else this.status.textContent = LOADING;
    const generation = this.generation;
    afterPaint(() => {
      if (generation === this.generation) {
        if (this.dlg.scrollTop) this.dlg.scrollTop = 0;
        this.back.focus({ preventScroll: true });
      }
      // sent even if the feed was closed meanwhile
      if (likesOn) this._mine(screen, entry);
      else track('social_feed_opened', { screen });
      if (generation !== this.generation) return; // closed meanwhile
      if (this.onOpen) this.onOpen(screen);
      this.load();
    });
  }

  _warm() {
    if (this.dlg.open) return;
    const d = this.dlg;
    const before = d.getAttribute('style');
    d.style.cssText = 'display:block;visibility:hidden;pointer-events:none';
    void d.offsetHeight;
    if (before === null) d.removeAttribute('style');
    else d.setAttribute('style', before);
  }

  /** Whether the feed is up, covering the stage (main.js stops drawing it meanwhile). */
  get covering() {
    return this.dlg.open;
  }

  _skeleton(on) {
    if (!this.skeleton) return;
    this.skeleton.hidden = !on;
    // the status line still says "Gathering wishes…" to screen readers
    this.status.classList.toggle('social-status-quiet', on);
  }

  /** The visitor's own wish above the list, and the opening event once it is known. */
  async _mine(screen, entry) {
    const generation = this.generation;
    if (screen === 'wish') {
      // the wish screen: the wish isn't made yet, so there is nothing to ask for
      track('social_feed_opened', { screen, entry: entry || null, has_my_wish: false, sort: this.sort });
      return;
    }
    const data = await loadMyWish();
    // a wish its maker kept private (MIN-194) gets no card here (MIN-196)
    const has = !!(data && data.wish && data.wish.status !== 'private');
    // sent even if the feed was closed meanwhile; only the card needs it open
    track('social_feed_opened', { screen, entry: entry || null, has_my_wish: has, sort: this.sort });
    if (has && generation === this.generation) renderMyWish(this.mine, data, screen);
  }

  close() {
    if (!this.dlg.open) return;
    if (typeof this.dlg.close === 'function') this.dlg.close();
    else {
      this.dlg.removeAttribute('open');
      this._closed();
    }
  }

  _closed() {
    this.generation++;
    if (this.request) this.request.abort();
    this.request = null;
    this.busy = false;
    this.list.removeAttribute('aria-busy');
    this._skeleton(false);
    this._menu(false);
    if (this.onClose) this.onClose(this.screen);
    const el = this.opener;
    this.opener = null;
    if (el && el.isConnected && typeof el.focus === 'function') el.focus({ preventScroll: true });
  }

  /** The first page, the next page, or a retry of whichever failed. */
  async load() {
    if (this.busy || !this.dlg.open) return;
    this.busy = true;
    const generation = this.generation;
    const first = this.list.children.length === 0;
    this.list.setAttribute('aria-busy', 'true');
    if (first && document.activeElement !== this.more) {
      // nothing to keep focus on yet: say so in the status line
      this.more.hidden = true;
      this.status.textContent = LOADING;
    } else {
      // More or Try again was pressed: keep the button (and a keyboard user's
      // focus) where it is while the page comes. aria-disabled, not disabled:
      // a disabled button would drop the focus.
      this.more.hidden = false;
      this.more.setAttribute('aria-disabled', 'true');
      this.more.textContent = first ? LOADING : LOADING_MORE;
      this.status.textContent = '';
    }
    const ctrl = new AbortController();
    this.request = ctrl;
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const url = new URL(SOCIAL_API, location.href);
      if (this.mix && this.mix.offset !== null) {
        url.searchParams.set('client_id', visit.clientId);
        url.searchParams.set('sort', this.mix.sort);
        url.searchParams.set('seed', String(this.mix.seed));
        url.searchParams.set('at', String(this.mix.at));
        url.searchParams.set('offset', String(this.mix.offset));
      } else if (this.cursor) url.searchParams.set('before', String(this.cursor));
      const res = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
      if (!res.ok) throw new Error('unavailable');
      const data = await res.json();
      if (generation !== this.generation) return;
      if (!data || !Array.isArray(data.wishes)) throw new Error('invalid');
      // the server without likes answers the old way: newest first, by cursor
      const mixed = !!this.mix && data.mode === 'mix';
      if (this.mix && !mixed) this.mix.offset = null;
      if (this.sortBar) this.sortBar.hidden = !mixed; // the old answer has no order to pick
      this.list.classList.toggle('rows', mixed);
      const items = [];
      const texts = [];
      for (const wish of data.wishes) {
        if (!wish || typeof wish.text !== 'string' || typeof wish.id !== 'number') continue;
        if (mixed) {
          // likes moving between pages can shift the order: never show one twice
          if (this.mix.seen.has(wish.id)) continue;
          this.mix.seen.add(wish.id);
        }
        const item = document.createElement('li');
        item.className = 'social-wish';
        const body = document.createElement('p');
        body.textContent = wish.text; // never interpret a submitted wish as HTML
        if (mixed) {
          // the text (and its More, when it is cut) on the left, the heart on the right
          body.className = 'social-text';
          texts.push(body);
          const col = document.createElement('div');
          col.className = 'social-body';
          col.append(body);
          item.append(col);
          if (typeof wish.likes === 'number') item.append(this._heart(item, wish));
        } else item.append(body);
        items.push(item);
      }
      const moreHadFocus = document.activeElement === this.more;
      this._skeleton(false);
      this.list.append(...items);
      // which of the new ones overflow their three lines: measured together, once
      if (texts.length) requestAnimationFrame(() => { if (generation === this.generation) makeExpandable(texts); });
      if (mixed) {
        this.mix.offset = typeof data.next === 'number' && data.next > 0 ? data.next : null;
        this.cursor = this.mix.offset;
      } else this.cursor = typeof data.next === 'number' && data.next > 0 ? data.next : null;
      const count = this.list.children.length;
      this.status.textContent = count ? '' : EMPTY;
      this.more.textContent = MORE;
      this.more.hidden = this.cursor === null;
      if (moreHadFocus && this.more.hidden) {
        // the button goes away with the last page: hand focus to the first new wish
        const target = items[0] || this.back;
        if (target !== this.back) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    } catch {
      if (generation !== this.generation) return;
      this._skeleton(false);
      this.status.textContent = FAILED;
      this.more.textContent = RETRY;
      this.more.hidden = false;
    } finally {
      clearTimeout(timer);
      if (generation === this.generation) {
        this.request = null;
        this.busy = false;
        this.more.removeAttribute('aria-disabled');
        this.list.removeAttribute('aria-busy');
      }
    }
  }

  /**
   * A small menu: "Popular ▾" opens Popular / Latest / Random. Closed by a
   * choice, a tap elsewhere, or Escape (which then leaves the feed open).
   */
  _makeSortBar() {
    const bar = document.createElement('div');
    bar.className = 'social-sort';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'social-sort-btn';
    btn.id = 'social-sort-btn';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div');
    menu.className = 'social-sort-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-labelledby', 'social-sort-btn');
    menu.hidden = true;
    for (const [key, label] of SORTS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'social-sort-item';
      item.setAttribute('role', 'menuitemradio');
      item.dataset.sort = key;
      item.textContent = label;
      item.addEventListener('click', () => {
        this._menu(false);
        this._setSort(key);
        btn.focus({ preventScroll: true });
      });
      menu.append(item);
    }
    btn.addEventListener('click', () => this._menu(menu.hidden));
    // a tap anywhere else closes it
    this.dlg.addEventListener('pointerdown', (e) => { if (!bar.contains(e.target)) this._menu(false); });
    // Escape closes the menu first, not the feed
    this.dlg.addEventListener('cancel', (e) => {
      if (menu.hidden) return;
      e.preventDefault();
      this._menu(false);
      btn.focus({ preventScroll: true });
    });
    bar.append(btn, menu);
    this.sortBtn = btn;
    this.sortMenu = menu;
    this._paintSort();
    return bar;
  }

  _menu(open) {
    if (!this.sortMenu) return;
    this.sortMenu.hidden = !open;
    this.sortBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      const cur = this.sortMenu.querySelector('[aria-checked="true"]');
      if (cur) cur.focus({ preventScroll: true });
    }
  }

  _paintSort() {
    const label = SORTS.find(([k]) => k === this.sort)[1];
    this.sortBtn.textContent = label;
    this.sortBtn.setAttribute('aria-label', `Order: ${label}`);
    for (const it of this.sortMenu.children) it.setAttribute('aria-checked', String(it.dataset.sort === this.sort));
  }

  /** Another order: the list starts again from the top in it; the pinned card stays. */
  _setSort(next) {
    if (next === this.sort || !this.mix) return;
    track('feed_sort_changed', { from: this.sort, to: next });
    this.sort = next;
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      /* not remembered, still applied */
    }
    this._paintSort();
    if (!this.dlg.open) return;
    this.generation++;
    if (this.request) this.request.abort();
    this.request = null;
    this.busy = false;
    this.mix = freshOrder(next);
    this.cursor = null;
    this.list.replaceChildren();
    this.list.removeAttribute('aria-busy');
    this.more.hidden = true;
    this.status.textContent = '';
    this._skeleton(true);
    this.dlg.scrollTop = 0;
    this.load();
  }

  /**
   * The heart under a wish: ♥ and the count, nothing else. A tap turns it on
   * or off at once; the server is told after, and if it says no, it goes back.
   * Taps while a request is out are folded into one more request at the end.
   */
  _heart(item, wish) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'social-like';
    const count = document.createElement('span');
    count.className = 'social-like-count';
    btn.append(heart('social-like-heart'), count);
    // liked/likes: what the server last confirmed; want/shown: what the button shows
    const st = { liked: wish.liked === true, likes: wish.likes, want: wish.liked === true, shown: wish.likes, busy: false };
    const paint = () => {
      btn.setAttribute('aria-pressed', String(st.want));
      btn.setAttribute('aria-label', `${st.want ? 'Liked' : 'Like'}, ${st.shown}`);
      count.textContent = String(st.shown);
    };
    const generation = this.generation;
    const sort = this.mix ? this.mix.sort : null; // the order this list is in
    const send = async () => {
      st.busy = true;
      const r = await sendLike(wish.id, st.want);
      st.busy = false;
      if (generation !== this.generation) return;
      if (!r.ok) {
        // back to what the server last confirmed
        st.want = st.liked;
        st.shown = st.likes;
        paint();
        return;
      }
      const changed = r.liked !== st.liked;
      st.liked = r.liked;
      if (typeof r.likes === 'number') st.likes = r.likes;
      if (changed) {
        const position = Array.prototype.indexOf.call(this.list.children, item) + 1;
        track(r.liked ? 'wish_liked' : 'wish_unliked', { wish_id: wish.id, position, sort });
      }
      if (st.want !== st.liked) send(); // tapped again meanwhile
      else {
        st.shown = st.likes;
        paint();
      }
    };
    btn.addEventListener('click', () => {
      st.want = !st.want;
      st.shown = Math.max(0, st.shown + (st.want ? 1 : -1));
      paint();
      btn.classList.remove('pop');
      if (st.want) {
        void btn.offsetWidth; // restart the little beat
        btn.classList.add('pop');
      }
      if (!st.busy) send();
    });
    paint();
    return btn;
  }
}

/** One order for one opening of the feed (or one choice of order): its shuffle, its ranking time, what was shown. */
function freshOrder(sort) {
  return { sort, seed: (Math.random() * 0x7fffffff) | 0, at: Date.now(), offset: 0, seen: new Set() };
}

/** Run fn when the page has a moment (or after a while, where there is no requestIdleCallback). */
function whenIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 4000 });
  else setTimeout(fn, 1500);
}

/** Run fn once the next frame has been painted. */
function afterPaint(fn) {
  requestAnimationFrame(() => setTimeout(fn, 0));
}

/** A few grey rows standing in for the wishes while the first page comes. */
function makeSkeleton() {
  const box = document.createElement('div');
  box.className = 'social-skeleton';
  box.setAttribute('aria-hidden', 'true');
  box.hidden = true;
  for (const widths of [[92, 64], [80], [96, 88, 40], [70], [86, 52]]) {
    const row = document.createElement('div');
    row.className = 'social-skeleton-row';
    const lines = document.createElement('div');
    lines.className = 'social-skeleton-lines';
    for (const w of widths) {
      const bar = document.createElement('span');
      bar.style.width = `${w}%`;
      lines.append(bar);
    }
    const dot = document.createElement('span');
    dot.className = 'social-skeleton-heart';
    row.append(lines, dot);
    box.append(row);
  }
  return box;
}
