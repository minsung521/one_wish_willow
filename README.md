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

The box and the willow come from **["One Wish Willow from Obsession movie"](https://sketchfab.com/3d-models/one-wish-willow-from-obsession-movie-7269f920284c4bb7a169ee110034d164) by [AlyStation](https://sketchfab.com/alyxyuu)**, licensed under [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/). The credit is shown on the first screen and after the wish, above two notices: *Wishes are kept anonymously.* and *Unofficial fan-made project. Not affiliated with Obsession or its studio.* When the painted fallback is used, the model credit is left out and the notices stay. The original license note is in `assets/willow/license.txt`.

What the downloaded model contains, and what was done with it:

| | Original (Sketchfab glTF) | In this app |
|---|---|---|
| Format | glTF 2.0: `.gltf` + `.bin` + 5 textures, 6.3 MB | same structure, textures re-encoded: **1.0 MB** in `assets/willow/` |
| Meshes | `box.001` (8 triangles, a triangular prism) and `willow.001` (4,832 triangles), separate nodes | used separately: the box on the first screen, the willow for the snap |
| Materials | `Box_baked` (baseColor + metallicRoughness), `Bark_baked` (baseColor + metallicRoughness + normal), all 2048² | box colour 1536², bark colour/normal 1024², roughness maps 512² |
| Break | the willow is one closed mesh | split at runtime (`js/stage.js`) along a ragged cut into two rigid halves, each capped with a splintered, faceted fracture face |

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
| `js/share.js` | The Share toast on the ending and revisit screens |
| `js/config.js` | Constants: PostHog key and host, `APP_VERSION`, the wish API path |
| `js/visit.js` | Runs before the stage: client id, first visit, first entry, device, in-app browser; starts analytics |
| `js/analytics.js` | `track()` and PostHog's init options; everything is dropped quietly if the SDK is blocked |
| `js/keep.js` | The one request that carries the wish text, to `/api/wish` |
| `api/wish.js` | Vercel Function: validates, rate-limits and stores the wish in Postgres |
| `db/schema.sql` | The `wishes` table (run once in the Neon SQL editor) |

### Copy and type
All on-screen text is taken from the One Wish Willow packaging as reproduced on the model's box texture (which matches the film prop) and from the official product site: "Remove from the box and just make a wish!", "Spark the middle and break in half", "What are you wishing for?", "State your wish clearly", "Single Use Only. Once made, it cannot be undone or repeated.", "Wait up to 24 hours for your wish to come true.", "Only one wish per life per person." The type pairs a chunky rounded display face (Lilita One) for headings, in the spirit of the box's arched title, with Nunito for the fine print, in the package's cream on a dark stage with its red as the one accent.

### Flow and sound
The first screen shows the box. Tapping it plays the film's One Wish Willow jingle (`assets/audio/jingle.wav`, the music-box cue cut from the supplied recording, normalised, with fades), and the willow rises out of the dissolving box. If the file fails to load, a synthesised jingle plays instead.

That tap is also the user activation browsers need before they allow audio, so the snap can sound at the exact moment of the break. The snap is the only sound after that: a short, dry crack, with no sounds when the halves land.

Every sound checks that the audio context is actually running. If it is not, the sound is dropped instead of queued, so a snap can never play late on a later tap.

### The one-time rule
- The stick counts as broken the moment it snaps. If the visitor leaves before writing a wish, they come back to the broken halves and the wish prompt.
- Once a wish is made, every later visit shows the halves where they fell, with *YOUR WISH HAS ALREADY BEEN MADE.*
- The wish text is never stored in the browser. It is sent once to `/api/wish` and kept there privately (see below).
- For testing, clearing the site's data (`localStorage` plus the `one-wish-willow` cookie) resets it.

### Share
A small **Share** pill comes up at the bottom, above the credit line: on the ending screen 2 s after its last line appears, on the revisit screen 1 s after it opens. Both are timed in real elapsed time, not frames, so slow devices show it at the same moment. It leaves after about 8 s, but not while it is hovered, touched or keyboard-focused. After that, a tap anywhere brings it back.

- **Phones and tablets** (`pointer: coarse`) open the system share sheet. Closing the sheet ends there, and the clipboard is left alone. If there is no sheet, or it fails for any other reason, the link is copied.
- **Desktop** copies the link straight away. The same pill then reads *Link copied*.
- If copying fails too, the link is shown as selected text to copy by hand.

The shared link is always the canonical address plus `?ref=share` (`https://one-wish-willow-eta.vercel.app/?ref=share`). It is never built from the current URL, so the sharer's UTM parameters are not passed on, and it never contains the wish. The share title, text and clipboard content are placeholders at the top of `js/share.js` until the copy is final (MIN-127).

Once there is a result, one `share_clicked` event is sent with `method` (`native` / `copy_link`, the method that was actually used), `result` (`success` / `cancel` / `error`, where showing the link as text counts as `error`) and `screen` (`ending` / `revisit`).

### Controls
- **Pointer or touch:** press on the stick and pull across it (up or down) to snap it.
- **Keyboard:** after the first screen, focus the stick and hold <kbd>Space</kbd>. On the wish screen, hold <kbd>Enter</kbd> or the button to confirm.

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

PostHog (US Cloud) is loaded by its official snippet in `<head>` and started by `js/visit.js` before the stage. Autocapture, automatic page views, page-leave, heatmaps, dead clicks, exceptions and web vitals are all off, so only the events below are sent. They all go through `track()` in `js/analytics.js`. Each event carries `app_version`, `device_type` and `in_app_browser` (`instagram` / `kakaotalk` / `facebook` / `naver` / `other` / `none`, worked out from the user agent, which itself is not sent). From `scene_ready` on, each event also carries `renderer` (`webgl` / `fallback`). The first entry is fixed with `register_once`: `entry_source`, `entry_referrer`, `entry_utm_source`, `entry_utm_medium`, `entry_utm_campaign`, `entry_utm_content`. The single `$pageview` is sent after these are registered, so it already has them.

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
| `wish_input_started` | the first character typed | |
| `wish_submitted` | the 1.5 s hold completes | `char_length`, `snap_to_submit_ms` (never the text) |
| `wish_store_result` | `/api/wish` answers or times out | `status`: `ok` / `error` / `rate_limited` / `timeout`, `latency_ms` |
| `ending_viewed` | *Wait up to 24 hours…* appears | |
| `share_clicked` | see Share above | `method`, `result`, `screen` |

Reserved for Wish Score, not sent yet: `score_cta_viewed`, `score_cta_clicked`, `score_requested`, `score_result_shown`, `score_failed`, `score_rate_limited`, `score_feedback`, `score_retry_intent`.

`APP_VERSION` in `js/config.js` is the `app_version` on events. It is set by hand when releasing, to the short hash of the commit that changed the app, because a site with no build step can't read its own commit. Stored wishes don't rely on it: the function knows the deployed commit. The two can differ (a merge commit, a docs-only commit), so match rows and events by `client_id`, not by version.

### Where the wish may go
Only into the body of the `/api/wish` request, and from there into the `wishes` table:
- never in a URL, an event (only `char_length`), `localStorage`/`sessionStorage`, the console or an error message;
- in session replays, the input and the burn canvas carry `ph-no-capture` and `ph-mask`, as does the hidden copy of the text the burn measures briefly. Inputs are masked, canvas and console recording are off, and network bodies are removed from recordings even if payload capture is turned on for the project;
- the textarea is emptied once the burn has taken its letters;
- the function never logs the request, only an error code.

To check: make a wish containing `OWW_SENTINEL_7319`. It should be found in the `wishes` table and nowhere else (PostHog event search, session replays, Vercel function logs, the browser's storage).
