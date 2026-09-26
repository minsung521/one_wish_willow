// The branch only breaks once per browser. State is kept in localStorage and
// mirrored to a long-lived cookie, and whichever copy is further along wins.
// The wish text is never stored in the browser: it is sent once, privately,
// to api/wish.js (js/keep.js) and then let go.

const KEY = 'one-wish-willow';
const RANK = { fresh: 0, broken: 1, wished: 2 };

function readCookie() {
  try {
    const m = document.cookie.match(new RegExp('(?:^|; )' + KEY + '=([^;]*)'));
    return m ? JSON.parse(decodeURIComponent(m[1])) : null;
  } catch {
    return null;
  }
}

function readLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function valid(rec) {
  return rec && typeof rec === 'object' && typeof rec.seed === 'number' && rec.state in RANK;
}

export function loadRecord() {
  const a = readLocal();
  const b = readCookie();
  const candidates = [a, b].filter(valid);
  if (!candidates.length) return null;
  candidates.sort((x, y) => RANK[y.state] - RANK[x.state]);
  const rec = candidates[0];
  saveRecord(rec); // heal whichever copy was missing
  return rec;
}

export function saveRecord(rec) {
  const json = JSON.stringify(rec);
  try {
    localStorage.setItem(KEY, json);
  } catch {
    /* private mode etc. — the cookie still holds it */
  }
  try {
    document.cookie =
      KEY + '=' + encodeURIComponent(json) + '; max-age=' + 60 * 60 * 24 * 365 * 10 + '; path=/; SameSite=Lax';
  } catch {
    /* ignore */
  }
}
