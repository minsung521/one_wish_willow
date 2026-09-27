// "See others' wishes" (MIN-158). There is nothing to see yet: the button
// measures whether people want it, and the dialog lets them leave an email to
// hear when it opens. The address goes only to /api/interest (api/interest.js),
// with the same client_id the wish was stored under, and never into an event.

import { INTEREST_API } from './config.js';
import { track } from './analytics.js';
import { visit } from './visit.js';

const TIMEOUT = 8000;
// the same check as the server: something@something.tld, no spaces
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/;
const MAX_EMAIL = 254;

const BAD_EMAIL = 'Please check your email address.';
const FAILED = "Couldn't save it. Please try again.";

export class InterestDialog {
  /**
   * @param {{ onOpen?: () => void, onClose?: () => void }} hooks
   */
  constructor({ onOpen, onClose } = {}) {
    this.dlg = document.getElementById('interest');
    this.form = document.getElementById('interest-form');
    this.input = document.getElementById('interest-email');
    this.error = document.getElementById('interest-error');
    this.submit = document.getElementById('interest-submit');
    this.done = document.getElementById('interest-done');
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.screen = null;
    this.busy = false;
    this.opener = null;
    this._bind();
  }

  /** @param {'final'|'revisit'} screen where the button was pressed */
  open(screen) {
    if (this.dlg.open) return;
    this.screen = screen;
    track('social_interest_clicked', { screen });
    this.opener = document.activeElement;
    this._reset();
    try {
      this.dlg.showModal();
    } catch {
      this.dlg.setAttribute('open', ''); // no <dialog> support: shown, just not modal
    }
    if (this.onOpen) this.onOpen();
  }

  close() {
    if (!this.dlg.open) return;
    if (typeof this.dlg.close === 'function') this.dlg.close();
    else {
      this.dlg.removeAttribute('open');
      this._closed();
    }
  }

  _bind() {
    const { dlg, form, input } = this;
    document.getElementById('interest-close').addEventListener('click', () => this.close());
    // a tap on the dim area around the card
    dlg.addEventListener('click', (e) => { if (e.target === dlg) this.close(); });
    dlg.addEventListener('close', () => this._closed());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this._send();
    });
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') this._error('');
    });
  }

  _closed() {
    if (this.onClose) this.onClose();
    const el = this.opener;
    this.opener = null;
    if (el && el.isConnected && typeof el.focus === 'function') el.focus({ preventScroll: true });
  }

  _reset() {
    this.form.hidden = false;
    this.done.hidden = true;
    this.input.value = '';
    this.submit.disabled = false;
    this._error('');
  }

  _error(msg) {
    this.error.textContent = msg;
    if (msg) this.input.setAttribute('aria-invalid', 'true');
    else this.input.removeAttribute('aria-invalid');
  }

  async _send() {
    if (this.busy) return;
    const email = this.input.value.trim();
    if (email.length > MAX_EMAIL || !EMAIL.test(email)) {
      this._error(BAD_EMAIL);
      this.input.focus({ preventScroll: true });
      return;
    }
    this._error('');
    this.busy = true;
    this.submit.disabled = true;

    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), TIMEOUT);
    let status = 0;
    try {
      const res = await fetch(INTEREST_API, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, client_id: visit.clientId }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      status = res.status;
    } catch {
      status = 0;
    }
    clearTimeout(timer);
    this.busy = false;
    this.submit.disabled = false;

    if (status === 201) {
      track('email_submitted', { screen: this.screen });
      this.input.value = '';
      this.form.hidden = true;
      this.done.hidden = false;
      this.done.setAttribute('tabindex', '-1');
      this.done.focus({ preventScroll: true });
    } else if (status === 400) {
      this._error(BAD_EMAIL);
    } else {
      this._error(FAILED);
    }
  }
}
