// Site-wide constants: the one place the PostHog project and the release live.

// PostHog project, US Cloud. A project token is public by design: it can send
// events but not read them.
export const POSTHOG_KEY = 'phc_qnAFakBY8siycbwEoQmDAiRNUH7bhHeYTmNwFPC8nrPb';
export const POSTHOG_HOST = 'https://us.i.posthog.com';

// Sent as `app_version` with every event. A site with no build step can't read
// its own commit, so this is set by hand when releasing: the short hash of the
// commit that changed the app. (Stored wishes get the deployed commit from the
// server; this value is only their fallback.)
export const APP_VERSION = '39b6f11';

// Where the wish is kept (api/wish.js).
export const WISH_API = '/api/wish';

// The box's opening jingle. Set to null to drop the recorded file and use
// the synthesised jingle in js/audio.js instead (e.g. if the film audio
// has to come down). Swap the path to use a replacement file.
export const JINGLE_URL = 'assets/audio/jingle.wav';
