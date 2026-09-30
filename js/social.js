// Others' wishes (MIN-122): a full-screen, scrolled list of the wishes the
// maker approved one by one (api/social.js), 20 at a time. Opened from the
// "See others' wishes" buttons when SOCIAL_ENABLED is on (js/main.js).
//
// Every wish is put on the page as text, never as HTML, and the list is kept
// out of session replays. Closing it (Back, Escape) returns to where it was
// opened, the wish screen's unsent text included: nothing there is touched.

import { SOCIAL_API } from './config.js';
import { track } from './analytics.js';

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

  /** @param {'wish'|'final'|'revisit'} screen where it was opened from */
  open(screen) {
    if (this.dlg.open) return;
    this.opener = document.activeElement;
    this.screen = screen;
    this.generation++;
    if (this.request) this.request.abort();
    this.busy = false;
    this.list.replaceChildren();
    this.cursor = null;
    this.more.hidden = true;
    this.status.textContent = '';
    try {
      this.dlg.showModal();
    } catch {
      this.dlg.setAttribute('open', ''); // no <dialog> support: shown, just not modal
    }
    this.dlg.scrollTop = 0;
    this.back.focus({ preventScroll: true });
    track('social_feed_opened', { screen });
    if (this.onOpen) this.onOpen(screen);
    this.load();
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
      if (this.cursor) url.searchParams.set('before', String(this.cursor));
      const res = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
      if (!res.ok) throw new Error('unavailable');
      const data = await res.json();
      if (generation !== this.generation) return;
      if (!data || !Array.isArray(data.wishes)) throw new Error('invalid');
      const items = [];
      for (const wish of data.wishes) {
        if (!wish || typeof wish.text !== 'string' || typeof wish.id !== 'number') continue;
        const item = document.createElement('li');
        item.className = 'social-wish';
        const body = document.createElement('p');
        body.textContent = wish.text; // never interpret a submitted wish as HTML
        item.append(body);
        items.push(item);
      }
      const moreHadFocus = document.activeElement === this.more;
      this.list.append(...items);
      this.cursor = typeof data.next === 'number' && data.next > 0 ? data.next : null;
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
}
