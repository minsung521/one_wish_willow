# One Wish Willow

A fan-made, one-time web experience inspired by the One Wish Willow from the film *Obsession*.
You get one stick and one chance. Snap it in half, write one wish, and let it go.

## Run

The page is a static site with no build step. The one server part is `api/wish.js`, a Vercel Function that keeps the wish; `package.json` exists only to give that function its dependency (`@neondatabase/serverless`). There is no build script, so Vercel installs it and serves the rest of the repository as it is.

```bash
npx http-server . -p 8080   # the page only: /api/wish is missing, so storing fails quietly
vercel dev                  # the page and the function (needs DATABASE_URL and IP_HASH_SECRET)
```

It must be served over HTTP(S), because ES modules don't load from `file://`.

## The 3D model

The box and the willow come from **["One Wish Willow from Obsession movie"](https://sketchfab.com/3d-models/one-wish-willow-from-obsession-movie-7269f920284c4bb7a169ee110034d164) by [AlyStation](https://sketchfab.com/alyxyuu)**, licensed under [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/). The first screen keeps one small line at its foot, *Unofficial fan-made project. Not affiliated with Obsession or its studio.*, with a **Credits** link beside it. Credits opens a small dialog with the model's attribution: the title, AlyStation, a link to it on Sketchfab, a link to CC BY 4.0, and *modified*, because the model was changed (CC BY 4.0 asks for that). It closes with ×, Escape or a tap outside the card. After the wish (the ending and the revisit screen), only *Public wishes are shown anonymously.* stays under Share, with the maker's contact as one more small line under it: X [@sungdotio](https://x.com/sungdotio) · [sungdotio@gmail.com](mailto:sungdotio@gmail.com). When the painted fallback is used, the Credits link is left out and the notice stays. The original license note is in `assets/willow/license.txt`.

What the downloaded model contains, and what was done with it:

| | Original (Sketchfab glTF) | In this app |
|---|---|---|
| Format | glTF 2.0: `.gltf` + `.bin` + 5 textures, 6.3 MB | same structure, textures re-encoded: **1.0 MB** in `assets/willow/` |
| Meshes | `box.001` (8 triangles, a triangular prism) and `willow.001` (4,832 triangles), separate nodes | used separately: the box on the first screen, the willow for the snap |
| Materials | `Box_baked` (baseColor + metallicRoughness), `Bark_baked` (baseColor + metallicRoughness + normal), all 2048² | box colour 1536², bark colour/normal 1024², roughness maps 512² |
| Break | the willow is one closed mesh | split at runtime (`js/stage.js`) along a ragged cut into two rigid halves, each capped with a splintered, faceted fracture face |

The same list of changes is kept at the end of `assets/willow/license.txt`:

```text
Changes made to the original model:
- Textures recompressed and downscaled (glTF 6.3 MB -> about 1.0 MB)
- Roughness maps removed from the box and the willow; both rendered as matte
- Willow color map replaced with a flat dark brown; normal map kept
- At runtime the willow mesh is split into two pieces with added break faces
```

`three.js` r170 (MIT) is vendored in `vendor/three/`, so there are no CDN requests. If WebGL or the model fails to load, the previous procedural stick (`js/willow.js`) is used instead.

## The painted fallback willow

The stick follows the prop in the film: a short, rigid willow stick (about 5¾ in long) with dark brown bark and light tan branch scars where side shoots were cut away. It does not bend. It cracks, then snaps cleanly in the middle.

It is painted once per visitor, pixel by pixel, into an offscreen canvas:
- fine lengthwise bark fibres, fissures and lenticels grown from seeded noise
- raised knots with a dished tan face and shaved scars
- a visible cut end
- lighting as a solid cylinder, in linear light

At the break, the same pixels are split along a jagged fracture. There are long torn fibres on the side under tension, and the fresh wood is recoloured pale.

| File | Role |
|---|---|
| `js/willow.js` | Stick model and per-pixel renderer, fracture, broken-half images, pre-break crack |
| `js/noise.js` | Seeded Perlin noise |
| `js/main.js` | Scene, input, the stiff resistance model (a hair of give, tremor, fibre ticks and cracks, a short last-instant hold), snap choreography, state flow |
| `js/pieces.js` | Rigid-body physics for the two halves and the splinters |
| `js/audio.js` | Synthesised Web Audio: room tone, dry fibre ticks and cracks, the snap, pieces landing, wish tones |
| `js/haptics.js` | Vibration API, with the iOS 18 switch-tick as a best-effort fallback |
| `js/wish.js` | Wish prompt, press-and-hold confirm, and letters that burn away one by one |
| `js/storage.js` | One-time rule: state lives in localStorage and is mirrored to a cookie |
| `js/share.js` | The Share toast on the ending and revisit screens, with *See others' wishes* under Share |
| `js/interest.js` | The *Not open yet!* dialog behind *See others' wishes*: the email check and the one request to `/api/interest` |
| `js/config.js` | Constants: PostHog key and host, `APP_VERSION`, the wish, interest, social and like API paths, `SOCIAL_ENABLED`, `LIKES_ENABLED`, the jingle file (`JINGLE_URL`) |
| `js/visit.js` | Runs before the stage: client id, first visit, first entry, device, in-app browser; starts analytics |
| `js/analytics.js` | `track()` and PostHog's init options; everything is dropped quietly if the SDK is blocked |
| `js/keep.js` | The one request that carries the wish text, to `/api/wish` |
| `js/qa.js` | The `?qa=1` overlay and Reset button, loaded only on `?qa=1` (see QA mode) |
| `api/wish.js` | Vercel Function: validates, rate-limits and stores the wish in Postgres |
| `api/interest.js` | Vercel Function: validates and upserts an email from *See others' wishes* |
| `js/social.js` | The others' wishes feed behind `SOCIAL_ENABLED` (MIN-122) |
| `api/social.js` | Vercel Function: the public feed, approved wishes only (mixed order with likes) |
| `js/likes.js` | Likes behind `LIKES_ENABLED` (MIN-160): the visitor's own wish card, the revisit toast, the like request |
| `api/like.js`, `api/my-wish.js`, `api/_lib/likes.js` | Vercel Functions: like/unlike, the visitor's own wish; the one display-count rule (MIN-160) |
| `api/admin/session.js`, `api/admin/wishes.js`, `api/_lib/admin.js` | The maker's login and review API (MIN-183) |
| `admin/` | The maker's review page, `/admin/` |
| `vercel.json` | `noindex`, no framing, no caching for `/admin` |
| `scripts/admin/hash-password.mjs` | Makes `ADMIN_PASSWORD_HASH` (and `ADMIN_SESSION_SECRET`); run locally, not deployed |
| `scripts/dev/` | A local server for the page and `api/` on a plain Postgres, and the feed/review checks (not deployed) |
| `db/schema.sql` | The `wishes`, `social_interest` and `likes` tables (run once in the Neon SQL editor); later changes as dated files beside it (`db/2026-10-01-likes.sql`) |
| `scripts/og/render.mjs` | Renders `og.png` and the PNG icons from the site (not deployed) |

### Copy and type
All on-screen text is taken from the One Wish Willow packaging as reproduced on the model's box texture (which matches the film prop) and from the official product site: "Remove from the box and just make a wish!", "Spark the middle and break in half", "What are you wishing for?", "State your wish clearly", "Single Use Only. Once made, it cannot be undone or repeated.", "Wait up to 24 hours for your wish to come true.", "Only one wish per life per person." The type pairs a chunky rounded display face (Lilita One) for headings, in the spirit of the box's arched title, with Nunito for the fine print, in the package's cream on a dark stage with its red as the one accent.

Korean in the wish (MIN-162) is set in **NanumSquareRound** Regular, self-hosted in `assets/fonts/willow-hangul-round/` and cut to Hangul only (all 11,172 syllables and the letters ㄱ–ㅣ, 113 KB), so Latin stays Nunito and a wish without Korean downloads nothing. NAVER releases the Nanum fonts under OFL 1.1 but reserves the Nanum names, so the cut-down copy is renamed **Willow Hangul Round** inside the file and in CSS ([license](assets/fonts/willow-hangul-round/OFL.txt)). It comes after Nunito in `--serif`, with `size-adjust: 90%` so Hangul doesn't look bigger than the Latin beside it, and `font-display: swap`. It has no italic, so the browser slants it to match the italic field (and the burn, which draws with the same font).

To rebuild it from `NanumSquareRoundR.ttf`: `pyftsubset NanumSquareRoundR.ttf --unicodes="U+3131-318E,U+AC00-D7A3" --flavor=woff2 --no-hinting --desubroutinize --layout-features='*'`, then rename the family in the `name` table (fontTools) and keep NAVER's copyright line.

The wish field has `spellcheck`, `autocorrect`, `autocomplete` and `autocapitalize` off, so keyboards have less reason to underline what is being typed. The underline under the syllable still being composed is the keyboard's own and can't be styled.

### Flow and sound
The first screen shows the box. Tapping it plays the film's One Wish Willow jingle (`assets/audio/jingle.wav`, the music-box cue cut from the supplied recording, normalised, with fades), and the willow rises out of the dissolving box. If the file fails to load, a synthesised jingle plays instead. The file is set by `JINGLE_URL` in `js/config.js`. The willow rises on a fixed 2.3 s, whichever jingle plays.

```text
Jingle kill switch
- Drop the film audio: set JINGLE_URL = null in js/config.js, commit, deploy.
- Replace it: put the new file under assets/audio/, point JINGLE_URL at it.
- Then bump APP_VERSION.
```

With `JINGLE_URL = null` the file is never requested and the synthesised jingle plays.

That tap is also the user activation browsers need before they allow audio, so the snap can sound at the exact moment of the break. The snap is the only sound after that: a short, dry crack, with no sounds when the halves land.

Before the audio context is made, `navigator.audioSession.type` is set to `playback` where the browser has it (Safari), so the sound plays as media and the silent switch doesn't mute it.

Every sound checks that the audio context is actually running. If it is not, the sound is dropped instead of queued, so a snap can never play late on a later tap.

### The one-time rule
- The stick counts as broken the moment it snaps. If the visitor leaves before writing a wish, they come back to the broken halves and the wish prompt.
- Once a wish is made, every later visit shows the halves where they fell, with *YOUR WISH HAS ALREADY BEEN MADE.*
- The wish text is never stored in the browser. It is sent once to `/api/wish` and kept there privately (see below).
- For testing, clearing the site's data (`localStorage` plus the `one-wish-willow` cookie) resets it. On a phone, and in in-app browsers where that is hard to reach, use **Reset** in QA mode instead (see below).

### Share
A small **Share** pill comes up at the bottom, above the credit line: on the ending screen 2 s after its last line appears, on the revisit screen 1 s after its last line appears, so it comes up after the lines and the credit rather than ahead of them. Both are timed in real elapsed time, not frames, so slow devices show it at the same moment. It leaves after about 8 s, but not while it is hovered, touched or keyboard-focused. After that, a tap anywhere brings it back.

- **Phones and tablets** (`pointer: coarse`) open the system share sheet. Closing the sheet ends there, and the clipboard is left alone. If there is no sheet, or it fails for any other reason, the line and the link are copied.
- **Desktop** copies the line and the link straight away. The same pill then reads *Link copied*.
- If copying fails too, the link alone is shown as selected text to copy by hand.

The shared link is always the canonical address plus `?ref=share` (`https://one-wish-willow-eta.vercel.app/?ref=share`). It is never built from the current URL, so the sharer's UTM parameters are not passed on, and it never contains the wish. The copy, at the top of `js/share.js`:

| | |
|---|---|
| Share sheet title | `One Wish Willow` |
| Share sheet text | `You only get one wish.` |
| Clipboard | `You only get one wish. https://one-wish-willow-eta.vercel.app/?ref=share` |

Once there is a result, one `share_clicked` event is sent with `method` (`native` / `copy_link`, the method that was actually used), `result` (`success` / `cancel` / `error`, where showing the link as text counts as `error`) and `screen` (`ending` / `revisit`).

### See others' wishes (MIN-158)
A demand check for a social feature that doesn't exist yet: nobody can see anyone's wish. An outline button, *See others' wishes*, sits right under Share in the same toast, on both the ending and the revisit screen, stacked and the same width at every screen size (44 px tall). Share keeps its look; the new button is quieter (fainter outline, softer and smaller type).

Pressing it opens a dialog:

| | |
|---|---|
| Title | `Not open yet!` |
| Body | `Get an email when it opens — plus how many people liked your wish.` |
| Input | placeholder `your@email.com`, with `Only for this. Deleted after 6 months.` under it |
| Button | `Notify me` |
| After | `Got it! We'll write to you.` |

There is no consent checkbox. It closes with ×, Escape or a tap outside the card, and the toast stays up while it is open. The address is checked on the page and again by the server (`something@something.tld`, no spaces, at most 254 characters); a bad one gets *Please check your email address.*, a failed request *Couldn't save it. Please try again.*

`POST /api/interest` (`api/interest.js`) takes `email` and `client_id` (the same id the wish is stored with) and writes to `social_interest` (`db/schema.sql`), a table of its own apart from `wishes`: `email` (trimmed, lower-cased), `client_id` (primary key), `consented_at`. It is an upsert on `client_id`, so asking again replaces the address and the time and there is only ever one row per person. Answers: `201` stored, `400` malformed, `500` server error. The address never goes into an event, storage or a log.

The dialog promises deletion after 6 months; rows older than that (`consented_at < now() - interval '6 months'`) have to be removed.

### Others' wishes and the review page (MIN-122, MIN-123, MIN-183)

Behind two switches, both off: `SOCIAL_ENABLED` in `js/config.js` (the page) and the `SOCIAL_ENABLED=true` environment variable (the server). With the page's switch off, everything above stays as it is: the *Not open yet!* email dialog, and no link on the wish screen.

With it on:
- *See others' wishes* under Share (ending and revisit) opens the feed instead of the email dialog, and the event is `social_feed_opened` (`screen`: `final` / `revisit` / `wish`) instead of `social_interest_clicked`.
- The wish screen gets a small *See others' wishes* link under the fine print, for someone who snapped the stick but hasn't made the wish. The feed covers the screen; Back or Escape closes it and the field still holds what they were writing. It goes away once the wish is made.
- The feed is one scrolled column: each wish set like the visitor's own (italic, cream, centred, line breaks kept), a small ember between them, 20 at a time with *See more wishes*. Loading, *No wishes to show yet*, and *Couldn't load wishes* with *Try again* (also for a failed second page). Wishes are set as text, never HTML, and the list carries `ph-no-capture ph-mask`. It covers the stage completely, so the model (and its credit) isn't on screen while it is open; its footer keeps the anonymity and fan-made lines.

**Moderation.** Every wish is stored `pending` (`wishes.moderation_status`, `db/2026-09-29-social-approval.sql`). Only the maker, one by one, makes a wish public; nothing is approved automatically. The public feed returns `moderation_status = 'approved' and approved_at is not null` only and `is_private = false`.

**Private wishes (MIN-194).** The "Keep my wish private" box under the field sends `is_private` with the wish (`wishes.is_private`, default `false`, `db/2026-10-01-wish-is-private.sql`; anything other than a real `true` is stored as `false`). It is independent of moderation: a private wish can be approved in the admin (shown with a `Private` badge) but the feed query excludes it. The migration has been applied to the production Neon database; a fresh database gets the column from `db/schema.sql`.

| API | |
|---|---|
| `GET /api/social?before=<id>` | `{ wishes: [{ id, text }], next: id \| null }`, newest first, 20 a page. `400` bad cursor, `404 {status:'closed'}` server switch off, `503` no database. `no-store`. |
| `GET /api/admin/session` | `200 { authenticated, expires_at }` or `401` |
| `POST /api/admin/session` `{ password }` | `200` + session cookie; `401 invalid_password`; `429 rate_limited` (`Retry-After`); `403` another origin; `400` not JSON |
| `DELETE /api/admin/session` | `200`, cookie cleared (logout); `403` another origin |
| `GET /api/admin/wishes?status=pending\|approved\|rejected\|hidden&before=<id>` | `{ wishes: [{ id, text, status, created_at, reviewed_at, approved_at }], next, counts }`, newest first, 20 a page; `401` without a session |
| `PATCH /api/admin/wishes` `{ id, from, status }` | `pending → approved\|rejected`, `approved → hidden`, `rejected\|hidden → approved`. `200 { wish }`; `200 { wish, unchanged: true }` when it already has that status (a double tap); `409 { status: 'conflict', wish }` when it moved elsewhere first; `400 invalid_transition`; `404`; `401`; `403` another origin |

Every admin route answers `404 {status:'closed'}` unless `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET` are both set. Approving sets `approved_at` and `reviewed_at` to `now()`; rejecting and hiding set `reviewed_at = now()` and `approved_at = NULL`. The move is one conditional `UPDATE … WHERE id = $1 AND moderation_status = $from`, so two taps or two tabs can't both apply it, and a hidden wish is gone from the next `GET /api/social`.

**Admin login.** One password, never stored: `ADMIN_PASSWORD_HASH` is its scrypt hash (N=32768). A good login sets `__Host-oww_admin`, an HMAC-signed 12-hour session, `HttpOnly; Secure; SameSite=Strict; Path=/`. Its key is derived from `ADMIN_SESSION_SECRET` and the hash, so changing either signs every session out. `POST`/`PATCH`/`DELETE` must carry the site's own `Origin` (or `Sec-Fetch-Site: same-origin`) and a JSON body. Five wrong passwords from one address (thirty from all) in 15 minutes answer `429` for the rest of the window; this is kept in the function's memory, so it holds per instance, and the password's length is what really stops guessing. Bodies, passwords, cookies and wish text are never logged, only error codes; the review page loads no analytics.

To switch the review page on for an environment (Preview first):
1. On your own computer: `node scripts/admin/hash-password.mjs --generate --secret`. Keep the password it shows in a password manager.
2. Vercel → Settings → Environment Variables: add `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET` (at least 32 characters) with the printed values, only for the environments that should have it. Redeploy.
3. Open `/admin/`. Remove either variable to switch it off again.

On the page, logging out says so only once the server has cleared the cookie; if that request fails, the page stays, says the session is still valid, and the button can be pressed again. An approve/reject/hide answer that arrives after the list was reloaded (another tab, Refresh) or after logging out doesn't touch the list on screen: if the wish did move, the page asks the server again for the current tab (or only its counts).

To try the feed on a preview: `SOCIAL_ENABLED=true` in that Preview's environment variables, and `SOCIAL_ENABLED = true` in `js/config.js` on a preview-only branch. Rolling back in production is the reverse: the page's switch off (commit, deploy) and/or the variable removed.

**Local checks** (no Vercel, no Neon): `scripts/dev/server.mjs` serves the site and runs `api/` against a plain Postgres, swapping the Neon driver for `pg`.

```bash
npm --prefix scripts/dev install
createdb oww && psql -d oww -f db/schema.sql
export LOCAL_PG=1 DATABASE_URL=postgres://localhost/oww SOCIAL_ENABLED=true IP_HASH_SECRET=local-only-secret
eval "$(printf 'a-local-test-password' | node scripts/admin/hash-password.mjs --secret | sed 's/^/export /')"
node scripts/dev/server.mjs 8080 &
ADMIN_TEST_PASSWORD=a-local-test-password node scripts/dev/api-test.mjs http://localhost:8080
ADMIN_TEST_PASSWORD=a-local-test-password node scripts/dev/flow-test.mjs http://localhost:8080 scripts/dev/checks
# likes (MIN-160): start the server with LIKES_ENABLED=true too (and IP_HASH_SECRET);
# a second one without it, to check the switch-off answers
psql -d oww -f db/2026-10-01-likes.sql   # only for a database made before MIN-160
node scripts/dev/likes-test.mjs http://localhost:8080 http://localhost:8081
node scripts/dev/likes-flow.mjs http://localhost:8080 scripts/dev/checks/likes [http://localhost:8082]   # 3rd: main, for the switch-off comparison
node scripts/dev/likes-compare.mjs scripts/dev/checks/likes/compare before=<old build> after=http://localhost:8080   # before/after captures
```

All of them refuse a `DATABASE_URL` that isn't on localhost (they empty `wishes`). `flow-test.mjs` sets `SOCIAL_ENABLED` inside its browsers, and `likes-flow.mjs` turns `LIKES_ENABLED` on there; the files keep their own values. `scripts/dev/checks/` keeps the last run's results and screenshots.

### Likes (MIN-160)

Behind two more switches, both off: `LIKES_ENABLED` in `js/config.js` (the page; it also needs `SOCIAL_ENABLED`) and the `LIKES_ENABLED=true` environment variable (the server). With either off, the feed and the revisit screen are exactly as above: newest first by cursor, no hearts, no card, no toast, and `social_feed_opened` carries only `screen`. The ending (*Wait up to 24 hours…*) is never changed.

**Data** (`db/2026-10-01-likes.sql`, **applied to production on 2026-10-01**; for any other database, run it once before its server switch is turned on): a `likes` table (`wish_id`, `client_id`, `ip_hash`, `created_at`, unique on `wish_id, client_id`, deleted with its wish), and `wishes.seed_likes` (int, default 0; filled later by MIN-193). The number a wish shows is **real likes + `seed_likes`**, worked out only in `displayLikes()` in `api/_lib/likes.js`. Events get the real count.

| API | |
|---|---|
| `POST /api/like` `{ wish_id, client_id, action: 'like' \| 'unlike' }` | `200 { wish_id, liked, likes }`; `403 own_wish`; `404 not_found` (no such wish, not approved, or kept private by its maker, MIN-194: one answer for all three); `429 rate_limited`; `400`; `404 closed` with the switch off. One like per `client_id` per wish (the unique key); per salted daily IP hash (MIN-121's `ip_hash`), at most 5 likes on one wish and 120 likes an hour, under an advisory lock. Unliking is never limited. |
| `GET /api/my-wish?client_id=` | `200 { wish: { id, text, status: approved\|pending\|rejected\|private, likes, like_count } \| null, email_submitted }`. `private` is a wish its maker kept private (MIN-194), whatever its review; it is never shown as approved. `likes`/`like_count` are null unless approved; a hidden wish reads as `rejected`; `email_submitted` is whether `social_interest` has this `client_id`. |
| `GET /api/social?client_id=&seed=&at=&offset=` | With likes: `{ mode: 'mix', wishes: [{ id, text, likes, liked, slot }], next: offset \| null }`, 20 a page, never the visitor's own wish and never a private one (`is_private = false` in both of its queries, as the old feed does). Without `client_id` (or with the server switch off) it answers as before. |

**Feed order.** Approved wishes only. Three orders of them, most liked (`like`), a shuffle (`random`) and newest (`latest`), are drawn from in turn, like → random → latest → like…, each taking its next wish not drawn yet; `slot` says which. The page keeps one `seed` (the shuffle) and `at` (likes are ranked as of then) for one opening of the feed, so the order holds still while it scrolls, and it also drops any id it has already shown.

**On the page**
- The top of the feed is shorter (tighter title, no intro line), so others' wishes come up sooner.
- The feed reads as rows: the wish on the left in upright type (easier for long wishes and Hangul), its heart and number on the right at the height of the first line (♥ 12, nothing else; 44×44 to touch; the empty heart a little brighter than the fine print). A wish longer than three lines is cut with … (`-webkit-line-clamp`, line breaks exactly as written) and gets *More* under it; *More* (or a tap on the text) shows all of it and turns into *Less*. Only wishes that really overflow, measured once a page is on screen, get it. A tap on the heart turns it on or off at once with a short beat; if the request fails, it goes back. Taps made while a request is out end in one more request.
- Opening the feed is kept light: the tap only puts the feed's frame up with a few grey rows, and the requests, the event and the Share hold come after that frame is painted. While the feed covers the stage, the stage isn't drawn. On the wish, ending and revisit screens the halves lie still, so the 3D frame is rendered again only when it changes and otherwise copied from a 2D cache (re-rendering WebGL every frame held up taps there). From the wish screen nothing is asked about the visitor's own wish: it isn't made yet.
- The visitor's own wish is pinned above the list on a faint panel (no outline): a small red *Your wish* label, and on the right *Received ♥ 12* with *+3 new*, so it doesn't read as a heart they pressed (no heart to press there). With no likes, a faint *♥ 0*. Below, the wish itself on up to three lines, with *More* when it is longer. Pending, not approved, or private (MIN-194): *Only you can see this for now.* in small type beside the label, and no number. No wish under this `client_id` (not made yet, or made in another browser): no card.
- Under it, unless this `client_id` already left an email: only a small *Get notified*. Pressing it opens the form in the card: *We'll email you when people ♥ your wish.*, an *Email address* field with *Notify*, and MIN-158's notice (*Only for this. Deleted after 6 months.*) under it in readable contrast. The address goes to `/api/interest`, the same upsert and 6-month rule. Once sent, it reads *✓ We'll email you.*; on later visits there is nothing.
- The revisit screen, once their wish is found, gets a toast at the top (clear of the lines and of Share at the foot): with one like or more, *Your wish got ♥ 12* *+3 new* and *See others' wishes*; with none, not approved, or private, only the button. It stays until × is pressed; the button opens the feed.
- *+3 new*: the number last shown (card or toast) is kept in `localStorage` as `oww_last_likes`, read once when the page loads, so both show the same increase on one visit. Nothing is shown when the increase is 0 or there is no stored number yet.

To switch likes on for an environment (Preview first): make sure `db/2026-10-01-likes.sql` has run there (production: done, 2026-10-01), set `LIKES_ENABLED=true` (and keep `SOCIAL_ENABLED=true`, `IP_HASH_SECRET`) in its environment variables, then `LIKES_ENABLED = true` in `js/config.js` (commit, deploy) and bump `APP_VERSION`. Rolling back is the reverse: the page's switch off, and/or the variable removed.

### Link previews (MIN-127)
A shared link has to work as the message on its own, so `<head>` carries the title, description, Open Graph and Twitter Card tags as plain HTML (crawlers don't run JS). `og:url` and the canonical link are always the bare address, even for `?ref=share`. None of this text uses ™: a preview card is seen without the page around it and must not read as the official product.

| | |
|---|---|
| Title | `One Wish Willow — You only get one wish.` |
| Description | `Break the willow. Make one wish. Only one per life. (Unofficial fan-made)` |
| Image | `og.png`, 1200×630: the first screen with *You only get one wish.* and *Unofficial fan-made*, box and text inside the centre 630×630, which KakaoTalk may crop to |
| Icons | `favicon.svg`, plus `favicon-32.png` and `apple-touch-icon.png` (180×180) for browsers and previews that don't take SVG |

`og.png` and the two PNG icons are rendered from the site itself by `scripts/og/render.mjs` (headless Chromium via Playwright; analytics and the wish API are blocked while it runs):

```bash
npm --prefix scripts/og install
npx --prefix scripts/og playwright install chromium   # once, if Playwright has no Chromium yet
node scripts/og/render.mjs   # writes og.png, favicon-32.png, apple-touch-icon.png
```

It prints where the box and both lines fall, and whether they are inside the centre square. `scripts/og/checks/` keeps the captures the first image was checked with: its centre 630×630 crop, and the bottom of the ending screen at 390×844 with the Share pill up.

After changing the image, clear the KakaoTalk cache in the Kakao developers share debugger for both the bare address and `?ref=share`.

### Controls
- **Pointer or touch:** press on the stick and pull across it (up or down) to snap it.
- **Keyboard:** after the first screen, focus the stick and hold <kbd>Space</kbd>. On the wish screen, hold <kbd>Enter</kbd> or the button to confirm.
- **The wish screen on a phone** (`pointer: coarse`): the **Hold to make your wish** button sits at the foot of the screen, under the broken halves and above the fine print, in the page's own flow (the safe area is kept clear below it). It fades in once the wish has at least one character and the field is not focused, so it never shows half hidden by the on-screen keyboard. Enter / Done or a tap outside the field puts the keyboard away. While the keyboard is up, the prompt and the field sit a little above the middle of the space left over it. Holding fills the line under the label, for 1.5 s. On a desktop the button shows as soon as there is text, and holding Enter in the field still confirms.

## Keeping the wish (MIN-121)

When the 1.5 s hold completes, `js/keep.js` sends one `POST /api/wish` (`keepalive`, 5 s timeout) and the burn carries on without waiting. A failure is neither shown nor retried; `wish_store_result` records it.

`api/wish.js` writes one row to the `wishes` table (`db/schema.sql`) in Neon Postgres.

| | |
|---|---|
| Request | `wish_text`, `client_id`, `locale`, `tz_offset` (minutes ahead of UTC, Seoul = 540), `device_type`, `referrer`, `utm_source`, `snap_to_submit_ms`, `app_version` |
| Filled in by the server | `country` (`x-vercel-ip-country`), `ip_hash`, `char_length` (code points), `created_at`, and `app_version`: the first 7 characters of `VERCEL_GIT_COMMIT_SHA`, the commit Vercel deployed. The page's `app_version` is used only when that variable is missing (local runs). |
| Validation | `wish_text` is trimmed and must be 1–140 characters, the input's own limit, counted the same way. `client_id` must be a UUID. Any other field of the wrong type or out of range is stored as null. |
| Limits | One wish per `client_id`, ever (an advisory lock keeps this true for simultaneous requests), and 20 an hour per `ip_hash`, generous for schools, offices and shared Wi-Fi |
| Answers | `201` stored, `429 {"status":"rate_limited"}`, `400` malformed, `500` server error |

- `client_id` is a random UUID made on the first visit and kept in `localStorage` as `oww_client_id`. It is also the PostHog distinct id, so a row and its events can be matched without identifying anyone.
- `ip_hash` is SHA-256 of the IP, `IP_HASH_SECRET` and the UTC date. The same address hashes differently each day, so it can't be followed across days. The raw IP and the user agent are never stored.
- `referrer` is stored as an origin only (`https://www.reddit.com`), because paths can carry personal data.
- Environment variables: `DATABASE_URL` (added by the Neon integration) and `IP_HASH_SECRET` (32+ random characters). Without either, the function answers 500.

## Analytics (MIN-124)

PostHog (US Cloud) is loaded by its official snippet in `<head>` and started by `js/visit.js` before the stage. Autocapture, automatic page views, page-leave, heatmaps, dead clicks, exceptions and web vitals are all off, so only the events below are sent. They all go through `track()` in `js/analytics.js`. Each event carries `app_version`, `device_type` and `in_app_browser` (`instagram` / `kakaotalk` / `facebook` / `naver` / `other` / `none`, worked out from the user agent, which itself is not sent), and `qa: true` on a `?qa=1` visit (see QA mode). From `scene_ready` on, each event also carries `renderer` (`webgl` / `fallback`). The first entry is fixed with `register_once`: `entry_source`, `entry_referrer`, `entry_utm_source`, `entry_utm_medium`, `entry_utm_campaign`, `entry_utm_content`. The single `$pageview` is sent after these are registered, so it already has them.

`entry_source` is `share` for `?ref=share`, `utm` when there is a `utm_source`, `referral` for another site's referrer, and `direct` otherwise. Instagram and KakaoTalk in-app browsers usually send no referrer, so they show up as `direct` unless the link carries UTM tags. Use `utm_content` to tell posts apart.

| Event | When | Properties |
|---|---|---|
| `visit_started` | page load, once | `visit_type`: `first` / `revisit_unused` / `revisit_used` |
| `scene_ready` | the box or the broken halves first drawn | `load_ms` (from navigation start), `renderer` |
| `revisit_blocked` | *Your wish has already been made.* appears | |
| `revisit_unused` | a return visit before the stick was snapped | |
| `box_tapped` | the box is opened (the jingle) | `ms_since_ready` |
| `branch_grab_started` | the stick is first grabbed | |
| `branch_snapped` | the snap | `grab_attempts`, `ms_since_box_tap`, `days_since_first_visit` |
| `wish_prompt_shown` | the wish field is on screen (a hidden tab waits until it is seen) | `ms_since_snap` |
| `wish_input_focused` | the field first gets focus (a tap on a phone) | `ms_since_snap` |
| `wish_input_started` | the first character typed | |
| `wish_hold_released_early` | the Hold pill let go before 1.5 s (every time) | `held_ms`, `hold_progress` (0–1, the fill when let go; it drains, so a quick re-press starts part-way), `attempt` (1, 2, …) |
| `wish_submitted` | the 1.5 s hold completes | `char_length`, `snap_to_submit_ms`, `hold_early_releases` (never the text) |
| `wish_store_result` | `/api/wish` answers or times out | `status`: `ok` / `error` / `rate_limited` / `timeout`, `latency_ms` |
| `ending_viewed` | *Wait up to 24 hours…* appears | |
| `share_clicked` | see Share above | `method`, `result`, `screen` |
| `social_interest_clicked` | *See others' wishes* pressed (every press) | `screen`: `final` / `revisit` |
| `email_submitted` | `/api/interest` stored the email (never the address itself) | `screen`: `final` / `revisit` (and `wish`, from the feed); from the card on their own wish also `source: feed_my_wish` |
| `social_feed_opened` | the feed opened (only with `SOCIAL_ENABLED` on; replaces `social_interest_clicked`) | `screen`: `final` / `revisit` / `wish`; with likes on also `entry` (`final` / `revisit_button` / `revisit_toast` / `input_screen`) and `has_my_wish`, sent once the visitor's own wish has been asked for |
| `wish_liked` / `wish_unliked` | the server confirmed a like / unlike in the feed (likes on) | `wish_id`, `position` (1 = first in the list), `slot`: `like` / `random` / `latest` |
| `my_wish_viewed` | the card on their own wish is shown (likes on) | `status`: `approved` / `pending` / `private` (pending also for rejected and hidden; private for their own private wish, MIN-194), `like_count` (real likes, without `seed_likes`), `display_like_count` (what is shown), `like_delta` (null on the first look); the counts are null unless approved |
| `revisit_toast_shown` / `revisit_toast_clicked` | the toast on the revisit screen / its button (likes on) | `like_count`, `display_like_count`, `like_delta`, as above |
| `email_cta_shown` | *Get notified* in their card is actually on screen (likes on) | |
| `page_hidden` | the page is hidden or closed, once per hide (sent by beacon) | `stage` (the phase: `gate` / `opening` / `intro` / `idle` / `broken` / `wish` / `releasing` / `done` / `already`), `via`: `visibilitychange` / `pagehide`, `ms_since_snap` (null before the snap); in `wish` also `wish_prompt_visible`, `wish_focused`, `wish_has_text` (a boolean, never the text), `wish_hold_early_releases` |

For MIN-177, a typed-but-not-sent drop-off with `wish_hold_early_releases: 0` never tried the Hold pill (didn't know how); one with several let go again and again (found it tedious).

A drop-off after the snap (MIN-175) splits into: gone before `wish_prompt_shown`; shown but never `wish_input_focused`; focused but no `wish_input_started`; typed but no `wish_submitted`. `page_hidden` with `stage: wish` says where each one left.

For *See others' wishes*, the share of people who pressed it is `social_interest_clicked` over the people who reached one of its two screens: `ending_viewed` (the ending) or `revisit_blocked` (the revisit screen).

Reserved for Wish Score, not sent yet: `score_cta_viewed`, `score_cta_clicked`, `score_requested`, `score_result_shown`, `score_failed`, `score_rate_limited`, `score_feedback`, `score_retry_intent`.

`APP_VERSION` in `js/config.js` is the `app_version` on events. It is set by hand when releasing, to the short hash of the commit that changed the app, because a site with no build step can't read its own commit. Stored wishes don't rely on it: the function knows the deployed commit. The two can differ (a merge commit, a docs-only commit), so match rows and events by `client_id`, not by version.

### Where the wish may go
Only into the body of the `/api/wish` request, and from there into the `wishes` table:
- never in a URL, an event (only `char_length`), `localStorage`/`sessionStorage`, the console or an error message;
- in session replays, the input and the burn canvas carry `ph-no-capture` and `ph-mask`, as does the hidden copy of the text the burn measures briefly. Inputs are masked, canvas and console recording are off, and network bodies are removed from recordings even if payload capture is turned on for the project;
- the textarea is emptied once the burn has taken its letters;
- the function never logs the request, only an error code.

To check: make a wish containing `OWW_SENTINEL_7319`. It should be found in the `wishes` table and nowhere else (PostHog event search, session replays, Vercel function logs, the browser's storage).

## QA mode (MIN-125)

For testing on real phones, including the KakaoTalk, Instagram and X in-app browsers: open the site with `?qa=1` (`https://one-wish-willow-eta.vercel.app/?qa=1`). Without it, `js/qa.js` is never requested and nothing below runs, so ordinary visits load and send exactly what they did before.

A small overlay sits top left. It takes no touches except its Reset button, so the stick can be pulled through it.

| Line | Shows |
|---|---|
| `fps` | now (the last 0.5 s) · 5 s average · 5 s low (the longest frame in the last 5 s) |
| `grab` | from grabbing the stick to the snap, the snap's own frame included: average fps, low fps, frames longer than 50 ms, and `grabbing` / `released` / `snapped` with the time. A new grab starts it over; after the snap it stays |
| `scene` | `scene_ready`'s `load_ms` · renderer (`webgl` / `fallback`) · the DPR actually drawn at, then the device's (`dev`) |
| `audio` | the `AudioContext` state, live (`none` until the first tap) · `navigator.audioSession` type/state, or `n/a` |
| `vib` | whether `navigator.vibrate` exists · the `in_app_browser` value events carry |

**Reset** forgets this browser and reloads `?qa=1`: it removes `one-wish-willow`, `oww_client_id`, `oww_visited`, `oww_entry` and `oww_last_likes` from `localStorage`, expires the `one-wish-willow` cookie, and resets PostHog's ids (`posthog.reset(true)`, and its stored copy is removed too). The next run starts on the first screen as a first visit with a new `client_id`, so `/api/wish`'s one-wish-per-`client_id` rule doesn't stop it and every run goes all the way to the stored wish. The per-IP limit (20 an hour) still applies.

Every event on a `?qa=1` visit carries `qa: true`, the `$pageview` included. It is not carried over: a later visit without `?qa=1` drops it. To leave QA traffic out in PostHog, filter on `qa` is not set. Wishes made in QA mode are stored like any other (the server is not told about QA mode); they and the QA events are to be deleted together later (MIN-141).
