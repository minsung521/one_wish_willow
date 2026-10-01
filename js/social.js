// Others' wishes (MIN-122): a full-screen, scrolled list of the wishes the
// maker approved one by one (api/social.js), 20 at a time. Opened from the
// "See others' wishes" buttons when SOCIAL_ENABLED is on (js/main.js).
//
// Every wish is put on the page as text, never as HTML, and the list is kept
// out of session replays. Closing it (Back, Escape) returns to where it was
// opened, the wish screen's unsent text included: nothing there is touched.
//
// With likes on (MIN-160, js/likes.js) the server mixes the order (most liked,
// shuffled, newest in turn) and pages by offset; each wish gets a heart, and
// the visitor's own wish is pinned above the list instead of in it.

import { SOCIAL_API } from './config.js';
import { track } from './analytics.js';
import { visit } from './visit.js';
import { likesOn, loadMyWish, renderMyWish, sendLike, heart } from './likes.js';

const TIMEOUT = 8000;
const LOADING = 'Gathering wishes…';
const LOADING_MORE = 'Gathering more…';
const MORE = 'See more wishes';
const RETRY = 'Try again';
const EMPTY = 'No wishes to show yet. Come back soon.';
const FAILED = "Couldn't load wishes. Please check your connection and try again.";

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
    this.mix = likesOn ? { seed: (Math.random() * 0x7fffffff) | 0, at: Date.now(), offset: 0, seen: new Set() } : null;
    this.mine.replaceChildren();
    this.mine.hidden = true;
    this.more.hidden = true;
    this.status.textContent = '';
    try {
      this.dlg.showModal();
    } catch {
      this.dlg.setAttribute('open', ''); // no <dialog> support: shown, just not modal
    }
    this.dlg.scrollTop = 0;
    this.back.focus({ preventScroll: true });
    if (likesOn) this._mine(screen, entry);
    else track('social_feed_opened', { screen });
    if (this.onOpen) this.onOpen(screen);
    this.load();
  }

  /** The visitor's own wish above the list, and the opening event once it is known. */
  async _mine(screen, entry) {
    const generation = this.generation;
    const data = await loadMyWish();
    const has = !!(data && data.wish);
    // sent even if the feed was closed meanwhile; only the card needs it open
    track('social_feed_opened', { screen, entry: entry || null, has_my_wish: has });
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
      const items = [];
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
        item.append(body);
        if (mixed && typeof wish.likes === 'number') item.append(this._heart(item, wish));
        items.push(item);
      }
      const moreHadFocus = document.activeElement === this.more;
      this.list.append(...items);
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
        track(r.liked ? 'wish_liked' : 'wish_unliked', { wish_id: wish.id, position, slot: wish.slot || null });
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
