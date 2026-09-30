// The maker's review page (MIN-183). Everything it shows comes from
// /api/admin/* behind the admin session; nothing secret is in this file, the
// URL or the browser's storage. Wish text is only ever set as text.

const API = { session: '/api/admin/session', wishes: '/api/admin/wishes' };
const TIMEOUT = 10000;

const LABEL = { pending: '대기', approved: '승인', hidden: '숨김', rejected: '반려' };
// what can be done from each status: [target, button label, style]
const ACTIONS = {
  pending: [['approved', '승인', 'approve'], ['rejected', '반려', 'reject']],
  approved: [['hidden', '숨김', 'reject']],
  hidden: [['approved', '다시 승인', 'approve']],
  rejected: [['approved', '승인', 'approve']],
};
const DONE = { approved: '승인했습니다', rejected: '반려했습니다', hidden: '숨겼습니다' };

// hints only; the decision stays with the maker
const HINTS = [
  ['링크', /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|kr|co|me|ly|gg|xyz)\b)/i],
  ['이메일', /[^\s@]+@[^\s@]+\.[^\s@]+/],
  ['전화번호', /(\+?\d[\d\s().-]{7,}\d)/],
  ['@계정', /(^|\s)@[a-z0-9_.]{3,}/i],
];

const $ = (id) => document.getElementById(id);
const el = {
  boot: $('boot'), closed: $('closed'), login: $('login'), review: $('review'), logout: $('logout'),
  form: $('login-form'), password: $('password'), loginError: $('login-error'), loginSubmit: $('login-submit'),
  tabs: $('tabs'), title: $('list-title'), refresh: $('refresh'), status: $('list-status'), cards: $('cards'), more: $('more'),
  topError: $('top-error'),
};

// generation: every list request (a newer one wins). view: the list on screen,
// renewed by a tab change, a refresh or a login; a card from an older view is
// no longer on screen. session: renewed by every login screen. moves/inflight:
// state changes started / still on their way, so counts from a list request
// that crossed one aren't trusted.
const state = {
  status: 'pending', next: null, loading: false, counts: null,
  generation: 0, view: 0, session: 0, moves: 0, inflight: 0,
};
const dateFormat = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

class HttpError extends Error {
  constructor(status, body) {
    super(`http_${status}`);
    this.status = status;
    this.body = body;
  }
}

async function api(method, url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new HttpError(res.status, json);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function show(section) {
  el.boot.hidden = true;
  for (const s of ['closed', 'login', 'review']) el[s].hidden = s !== section;
  el.logout.hidden = section !== 'review';
}

/** Anything that says the session is gone sends the maker back to the login. */
function handleAuth(err) {
  if (err instanceof HttpError && err.status === 401) {
    toLogin('세션이 만료되었습니다. 다시 로그인하세요.');
    return true;
  }
  if (err instanceof HttpError && err.status === 404 && err.body && err.body.status === 'closed') {
    show('closed');
    return true;
  }
  return false;
}

function toLogin(message = '') {
  state.generation++;
  state.view++;
  state.session++;
  el.topError.textContent = '';
  show('login');
  el.loginError.textContent = message;
  el.password.value = '';
  el.password.focus();
}

// ---------------------------------------------------------------- login

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (el.loginSubmit.disabled) return;
  const password = el.password.value;
  if (!password) {
    el.loginError.textContent = '비밀번호를 입력하세요.';
    return;
  }
  el.loginSubmit.disabled = true;
  el.loginError.textContent = '';
  try {
    await api('POST', API.session, { password });
    el.password.value = '';
    startReview();
  } catch (err) {
    const s = err instanceof HttpError ? err.status : 0;
    if (s === 404) show('closed');
    else if (s === 401) el.loginError.textContent = '비밀번호가 맞지 않습니다.';
    else if (s === 429) {
      const wait = Math.ceil(((err.body && err.body.retry_after) || 900) / 60);
      el.loginError.textContent = `시도가 너무 많습니다. 약 ${wait}분 뒤에 다시 시도하세요.`;
    } else if (s === 403) el.loginError.textContent = '요청 출처가 올바르지 않습니다. 이 사이트 주소에서 다시 여세요.';
    else el.loginError.textContent = '로그인하지 못했습니다. 연결을 확인하고 다시 시도하세요.';
    el.password.select();
  } finally {
    el.loginSubmit.disabled = false;
  }
});

// Logged out only once the server has cleared the cookie. Until then the
// session is still good (a reload would show this page again), so say so and
// leave the button to try again.
el.logout.addEventListener('click', async () => {
  if (el.logout.disabled) return;
  el.logout.disabled = true;
  el.topError.textContent = '';
  try {
    await api('DELETE', API.session);
  } catch (err) {
    el.logout.disabled = false;
    if (err instanceof HttpError && err.status === 404 && err.body && err.body.status === 'closed') {
      show('closed');
      return;
    }
    const s = err instanceof HttpError ? err.status : 0;
    const why = s === 403 ? '요청 출처가 올바르지 않아 거부되었습니다. 이 사이트 주소에서'
      : s >= 500 ? '서버 오류가 났습니다.'
      : s ? `응답 ${s}.`
      : '연결을 확인하고';
    el.topError.textContent = `로그아웃하지 못했습니다. ${why} 다시 시도하세요. 세션은 아직 유효합니다.`;
    return;
  }
  el.logout.disabled = false;
  el.cards.replaceChildren();
  toLogin('로그아웃했습니다.');
});

// ---------------------------------------------------------------- list

function startReview() {
  show('review');
  selectTab(state.status, false);
}

function selectTab(status, focusTitle = true) {
  state.status = status;
  for (const b of el.tabs.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.status === status));
  }
  el.title.textContent = LABEL[status];
  load(true);
  if (focusTitle) el.title.focus({ preventScroll: true });
}

el.tabs.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-status]');
  if (b) selectTab(b.dataset.status);
});
el.refresh.addEventListener('click', () => load(true));
el.more.addEventListener('click', () => load(false));

function listUrl(before) {
  const url = new URL(API.wishes, location.origin);
  url.searchParams.set('status', state.status);
  if (before) url.searchParams.set('before', String(before));
  return url.pathname + url.search;
}

/** Counts from a list that no state change crossed (none started or open since). */
function takeCounts(counts, moves) {
  if (state.inflight === 0 && state.moves === moves) setCounts(counts);
}

async function load(fresh) {
  if (state.loading && !fresh) return;
  const generation = ++state.generation;
  const moves = state.moves;
  state.loading = true;
  if (fresh) {
    state.view++;
    state.next = null;
    el.cards.replaceChildren();
  }
  el.more.disabled = true;
  el.refresh.disabled = true;
  el.status.textContent = '불러오는 중…';
  try {
    const data = await api('GET', listUrl(fresh ? null : state.next));
    if (generation !== state.generation) return;
    for (const w of data.wishes) el.cards.append(card(w));
    state.next = data.next;
    takeCounts(data.counts, moves);
    el.status.textContent = el.cards.children.length ? '' : `${LABEL[state.status]} 상태의 소원이 없습니다.`;
    el.more.hidden = state.next === null;
  } catch (err) {
    if (generation !== state.generation) return;
    if (handleAuth(err)) return;
    el.status.textContent = '목록을 불러오지 못했습니다. 새로고침으로 다시 시도하세요.';
  } finally {
    if (generation === state.generation) {
      state.loading = false;
      el.more.disabled = false;
      el.refresh.disabled = false;
    }
  }
}

/** Only the tab counts, from the server, for the list still on screen. */
async function refreshCounts() {
  const { view, session } = state;
  const moves = state.moves;
  try {
    const data = await api('GET', listUrl(null));
    if (view === state.view && session === state.session) takeCounts(data.counts, moves);
  } catch {
    /* the next list load brings them */
  }
}

function setCounts(counts) {
  if (!counts) return;
  state.counts = counts;
  for (const span of el.tabs.querySelectorAll('[data-count]')) {
    span.textContent = String(counts[span.dataset.count] ?? 0);
  }
}

function card(w) {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset.id = String(w.id);
  li.dataset.status = w.status;

  const meta = document.createElement('p');
  meta.className = 'meta';
  const id = document.createElement('span');
  id.textContent = `#${w.id}`;
  const time = document.createElement('time');
  time.dateTime = w.created_at;
  time.textContent = dateFormat.format(new Date(w.created_at));
  const badge = document.createElement('span');
  badge.className = `badge ${w.status}`;
  badge.textContent = LABEL[w.status];
  meta.append(id, time, badge);
  if (w.status === 'approved' && w.approved_at) {
    const at = document.createElement('span');
    at.className = 'sub';
    at.textContent = `승인 ${dateFormat.format(new Date(w.approved_at))}`;
    meta.append(at);
  }

  const text = document.createElement('p');
  text.className = 'text';
  text.textContent = w.text; // a submitted wish is never HTML

  const hints = HINTS.filter(([, re]) => re.test(w.text)).map(([name]) => name);
  const flags = document.createElement('p');
  flags.className = 'flags';
  if (hints.length) flags.textContent = `확인 필요: ${hints.join(' · ')}`;
  else flags.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'actions';
  for (const [to, label, style] of ACTIONS[w.status] || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${style}`;
    b.textContent = label;
    b.setAttribute('aria-label', `#${w.id} ${label}`);
    b.addEventListener('click', () => moderate(li, w, to));
    actions.append(b);
  }
  const error = document.createElement('p');
  error.className = 'error';
  error.setAttribute('role', 'alert');

  li.append(meta, text, flags, actions, error);
  return li;
}

async function moderate(li, w, to) {
  if (li.dataset.busy) return; // a second tap while the first is on its way
  li.dataset.busy = '1';
  const buttons = li.querySelectorAll('.actions button');
  for (const b of buttons) b.disabled = true;
  const error = li.querySelector('.error');
  error.textContent = '';
  const { view, session } = state;
  state.moves++;
  state.inflight++;
  let data = null;
  let err = null;
  try {
    data = await api('PATCH', API.wishes, { id: w.id, from: w.status, status: to });
  } catch (e) {
    err = e;
  } finally {
    state.inflight--;
  }

  // logged out (or in again) since: this answer belongs to no screen now
  if (session !== state.session) return;
  if (err && handleAuth(err)) return;

  // The list was reloaded (another tab, Refresh) while this was on its way: its
  // card is gone and the counts on screen came from the server. Don't touch
  // them; if the wish did move, ask the server again for this tab.
  if (view !== state.view || !li.isConnected) {
    const moved = (data && !data.unchanged) || (err instanceof HttpError && err.status === 409);
    if (moved) {
      if (el.cards.querySelector(`.card[data-id="${w.id}"]`)) load(true);
      else refreshCounts();
    }
    return;
  }

  if (data) {
    removeCard(li, `#${w.id} ${data.unchanged ? '이미 처리되어 있습니다' : DONE[to]}.`, w.status, data.wish.status);
    return;
  }
  if (err instanceof HttpError && err.status === 409 && err.body && err.body.wish) {
    const now = err.body.wish.status;
    removeCard(li, `#${w.id}은(는) 이미 다른 곳에서 ${LABEL[now]} 처리되었습니다.`, w.status, now);
    return;
  }
  if (err instanceof HttpError && err.status === 404) {
    removeCard(li, `#${w.id}을(를) 찾을 수 없습니다.`, w.status, null);
    return;
  }
  error.textContent = err instanceof HttpError && err.status === 403
    ? '요청 출처가 올바르지 않습니다.'
    : '처리하지 못했습니다. 다시 시도하세요.';
  delete li.dataset.busy;
  for (const b of buttons) b.disabled = false;
}

/** The wish left this tab's status: take its card away and say what happened. */
function removeCard(li, message, from, to) {
  const hadFocus = li.contains(document.activeElement);
  const next = li.nextElementSibling || li.previousElementSibling;
  li.remove();
  if (state.counts && from !== to) {
    if (from in state.counts) state.counts[from] = Math.max(0, state.counts[from] - 1);
    if (to && to in state.counts) state.counts[to] += 1;
    setCounts(state.counts);
  }
  el.status.textContent = message;
  if (!el.cards.children.length) {
    if (state.next !== null) load(true);
    else el.status.textContent = `${message} ${LABEL[state.status]} 상태의 소원이 더 없습니다.`;
  }
  if (hadFocus) {
    const target = next && next.querySelector('.actions button');
    if (target) target.focus({ preventScroll: false });
    else el.title.focus({ preventScroll: true });
  }
}

// ---------------------------------------------------------------- boot

(async () => {
  try {
    await api('GET', API.session);
    startReview();
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) show('closed');
    else if (err instanceof HttpError && err.status === 401) toLogin();
    else {
      el.boot.textContent = '관리자 API에 연결하지 못했습니다. 새로고침해 보세요.';
    }
  }
})();
