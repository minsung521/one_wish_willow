// Share: a small pill that comes up for a while on the ending and revisit
// screens, then gets out of the way. It never carries the wish itself, only
// a clean link to the site.
//
// Phones and tablets open the system share sheet; desktops copy the link.
// If the sheet is missing or fails, the link is copied instead; if copying
// fails too, the link is shown as text to select by hand.

import { track } from './analytics.js';

// The canonical address with only ?ref=share on it. The sharer's own UTM or
// other parameters must not travel on to the people they share with.
const SITE_URL = 'https://one-wish-willow-eta.vercel.app/';
const SHARE_URL = SITE_URL + '?ref=share';

const SHARE_TITLE = 'One Wish Willow';
const SHARE_TEXT = 'You only get one wish.';
// what "copy link" puts on the clipboard: the hook, then the link
const SHARE_COPY = `${SHARE_TEXT} ${SHARE_URL}`;

const LABEL = 'Share';
const COPIED = 'Link copied';

// When it comes up. These are real elapsed time (timers, not frames), so a
// slow device shows it at the same moment as a fast one.
const ENDING_DELAY = 2000; // ms after the ending's last line appears
const REVISIT_DELAY = 1000; // ms after the revisit screen's last line appears
const LINGER = 8000; // ms it stays up once nothing is holding it
const GAP = 14; // px above the credit line

// Keyboard focus keeps the toast up; focus from a click does not.
let viaKeyboard = false;
window.addEventListener('keydown', () => { viaKeyboard = true; }, true);
window.addEventListener('pointerdown', () => { viaKeyboard = false; }, true);

const coarse = () => window.matchMedia('(pointer: coarse)').matches;

export class ShareToast {
  /**
   * @param {{ avoid?: HTMLElement[] }} opts fixed elements at the bottom it must sit above
   */
  constructor({ avoid = [] } = {}) {
    this.root = document.getElementById('share');
    this.btn = document.getElementById('share-btn');
    this.url = document.getElementById('share-url');
    this.avoid = avoid;
    this.screen = null; // 'ending' | 'revisit'
    this.on = false;
    this.armed = false; // once it has been up, a tap anywhere brings it back
    this.hover = false; // a pointer over it, or a finger on it
    this.focus = false; // keyboard focus inside it
    this.busy = false; // a share or copy is under way
    this.delay = 0;
    this.timer = 0;
    this.url.textContent = SHARE_URL;
    this._bind();
  }

  /** Bring it up on this screen after its pause. */
  show(screen) {
    this.screen = screen;
    clearTimeout(this.delay);
    this.delay = setTimeout(() => {
      this.armed = true;
      this._open();
    }, screen === 'ending' ? ENDING_DELAY : REVISIT_DELAY);
  }

  _bind() {
    const { root, btn } = this;
    root.addEventListener('pointerenter', () => { this.hover = true; this._settle(); });
    root.addEventListener('pointerleave', () => { this.hover = false; this._settle(); });
    root.addEventListener('focusin', () => { this.focus = viaKeyboard; this._settle(); });
    root.addEventListener('focusout', (e) => {
      if (root.contains(e.relatedTarget)) return;
      this.focus = false;
      this._settle();
    });

    btn.addEventListener('click', () => this._share());

    // Once it has gone, a tap anywhere (or Tab) brings it back. On the tap's
    // release, not its press, so that the same tap can't land on the button.
    const reopen = () => { if (this.armed && !this.on) this._open(); };
    window.addEventListener('pointerup', reopen, true);
    window.addEventListener('keydown', (e) => { if (e.key === 'Tab') reopen(); }, true);
    window.addEventListener('resize', () => { if (this.on) this._place(); });
  }

  _open() {
    this.btn.textContent = LABEL;
    this.btn.hidden = false;
    this.url.hidden = true;
    this._place();
    this.on = true;
    this.root.classList.add('on');
    this._settle();
  }

  _close() {
    this.on = false;
    this.root.classList.remove('on');
  }

  /** (Re)start the countdown to leaving, unless something is holding it up. */
  _settle() {
    clearTimeout(this.timer);
    if (this.on && !this.hover && !this.focus && !this.busy) this.timer = setTimeout(() => this._close(), LINGER);
  }

  /** Sit just above the credit line (and anything else fixed at the bottom). */
  _place() {
    let top = Infinity;
    for (const el of this.avoid) {
      const r = el && el.getBoundingClientRect();
      if (r && r.height > 0) top = Math.min(top, r.top);
    }
    this.root.style.bottom = top < Infinity ? Math.round(window.innerHeight - top + GAP) + 'px' : '';
  }

  async _share() {
    if (this.busy) return;
    this.busy = true;
    this._settle();

    const data = { title: SHARE_TITLE, text: SHARE_TEXT, url: SHARE_URL };
    let method = 'copy_link';
    let result = 'error';
    if (coarse() && typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare(data))) {
      try {
        await navigator.share(data);
        method = 'native';
        result = 'success';
      } catch (err) {
        // closing the sheet is an answer: don't go on to overwrite their clipboard
        if (err && err.name === 'AbortError') {
          method = 'native';
          result = 'cancel';
        }
      }
    }
    if (method === 'copy_link') {
      if (await copy(SHARE_COPY)) {
        result = 'success';
        this.btn.textContent = COPIED;
      } else {
        this._showUrl();
      }
    }

    track('share_clicked', { method, result, screen: this.screen });
    this.busy = false;
    this._settle();
  }

  /** Last resort: the link as plain text, selected and ready to copy by hand. */
  _showUrl() {
    const hadFocus = document.activeElement === this.btn;
    this.btn.hidden = true;
    this.url.hidden = false;
    if (hadFocus) this.url.focus({ preventScroll: true });
    try {
      const range = document.createRange();
      range.selectNodeContents(this.url);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      /* it can still be selected by hand */
    }
  }
}

async function copy(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* try the older way */
  }
  return legacyCopy(text);
}

// execCommand still works in some in-app browsers that lack the Clipboard API.
function legacyCopy(text) {
  const active = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;font-size:16px;';
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  if (active && active !== document.body && typeof active.focus === 'function') active.focus({ preventScroll: true });
  return ok;
}
