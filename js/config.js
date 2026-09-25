// Site-wide constants: the one place the PostHog project and the release live.

// PostHog project, US Cloud. A project token is public by design: it can send
// events but not read them.
export const POSTHOG_KEY = 'phc_Bv5AMLBBPJhoeniaa28Ew4Xh7FvEDjhJgnShPikQGWhe';
export const POSTHOG_HOST = 'https://us.i.posthog.com';

// Sent as `app_version` with every event and every stored wish. A site with no
// build step can't read its own commit, so this is set by hand when releasing:
// the short hash of the commit that changed the app.
export const APP_VERSION = '589d196';

// Where the wish is kept (api/wish.js).
export const WISH_API = '/api/wish';
