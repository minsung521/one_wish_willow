import { SOCIAL_API } from './config.js';
import { track } from './analytics.js';

export class SocialFeed {
  constructor({ onOpen, onClose } = {}) {
    this.dlg = document.getElementById('social');
    this.list = document.getElementById('social-list');
    this.status = document.getElementById('social-status');
    this.more = document.getElementById('social-more');
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.cursor = null;
    this.busy = false;
    this.generation = 0;
    this.request = null;
    this.opener = null;
    document.getElementById('social-back').addEventListener('click', () => this.close());
    this.more.addEventListener('click', () => this.load());
    this.dlg.addEventListener('close', () => this._closed());
    this.dlg.addEventListener('click', (e) => {
      if (e.target === this.dlg) this.close();
    });
  }

  open(screen) {
    if (this.dlg.open) return;
    this.opener = document.activeElement;
    this.generation++;
    if (this.request) this.request.abort();
    this.busy = false;
    this.list.replaceChildren();
    this.cursor = null;
    this.more.hidden = true;
    this.more.textContent = 'See more wishes';
    this.status.textContent = 'Gathering wishes…';
    this.dlg.showModal();
    track('social_feed_opened', { screen });
    if (this.onOpen) this.onOpen();
    this.load();
  }

  close() {
    if (this.dlg.open) this.dlg.close();
  }

  _closed() {
    this.generation++;
    if (this.request) this.request.abort();
    this.busy = false;
    if (this.onClose) this.onClose();
    const el = this.opener;
    this.opener = null;
    if (el && el.isConnected) el.focus({ preventScroll: true });
  }

  async load() {
    if (this.busy || !this.dlg.open) return;
    this.busy = true;
    const generation = this.generation;
    this.more.hidden = true;
    this.status.textContent = this.list.children.length ? 'Gathering more wishes…' : 'Gathering wishes…';
    const ctrl = new AbortController();
    this.request = ctrl;
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const url = new URL(SOCIAL_API, location.href);
      if (this.cursor) url.searchParams.set('before', this.cursor);
      const res = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
      if (!res.ok) throw new Error('unavailable');
      const data = await res.json();
      if (generation !== this.generation) return;
      if (!Array.isArray(data.wishes)) throw new Error('invalid');
      for (const wish of data.wishes) {
        if (typeof wish.text !== 'string' || typeof wish.id !== 'number') continue;
        const item = document.createElement('li');
        item.className = 'social-wish';
        const body = document.createElement('p');
        body.textContent = wish.text; // never interpret a submitted wish as HTML
        item.append(body);
        this.list.append(item);
      }
      this.cursor = typeof data.next === 'number' ? data.next : null;
      this.status.textContent = this.list.children.length ? '' : 'No wishes to show yet. Come back soon.';
      this.more.textContent = 'See more wishes';
      this.more.hidden = this.cursor === null;
    } catch {
      if (generation !== this.generation) return;
      this.status.textContent = "Couldn't load wishes. Please try again.";
      this.more.textContent = 'Try again';
      this.more.hidden = false;
    } finally {
      clearTimeout(timer);
      if (generation === this.generation) {
        this.request = null;
        this.busy = false;
      }
    }
  }
}
