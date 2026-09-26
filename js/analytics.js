// Analytics: one thin wrapper around PostHog. The SDK comes from the snippet
// in index.html; whenever it fails to load or is blocked, every call is
// silently dropped. Nothing here may ever break the experience.
//
// Only the events the code names are sent: no autocapture, no page-leave,
// heatmaps, dead clicks, exceptions or web vitals, and no console logs or
// canvas in replays. The wish itself never goes through here.

import { POSTHOG_KEY, POSTHOG_HOST } from './config.js';

/**
 * @param {string} event event name, e.g. 'share_clicked'
 * @param {Record<string, unknown>} [props] event properties
 */
export function track(event, props) {
  try {
    const ph = window.posthog;
    if (ph && typeof ph.capture === 'function') ph.capture(event, props);
  } catch {
    /* ignore */
  }
}

/** Properties sent with every event from now on. */
export function setProps(props) {
  try {
    const ph = window.posthog;
    if (ph && typeof ph.register === 'function') ph.register(props);
  } catch {
    /* ignore */
  }
}

/**
 * Start PostHog for this visit and send the one $pageview. The first-entry
 * properties are registered before it, so even that first event carries them.
 *
 * @param {{ clientId: string, props: object, once: object }} visit
 */
export function startAnalytics({ clientId, props, once }) {
  try {
    const ph = window.posthog;
    if (!ph || typeof ph.init !== 'function') return;
    ph.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      defaults: '2026-08-30',
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_exceptions: false,
      capture_performance: { web_vitals: false },
      rageclick: false,
      persistence: 'localStorage+cookie',
      person_profiles: 'identified_only',
      // the same id as the stored wish's client_id; never identify()
      bootstrap: { distinctID: clientId },
      // in_app_browser says what we need to know; the raw user agent stays here
      property_denylist: ['$raw_user_agent'],
      enable_recording_console_log: false,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '.ph-mask',
        captureCanvas: { recordCanvas: false },
        recordHeaders: false,
        recordBody: false,
        // even if payload capture is ever switched on for the project,
        // no request or response body goes into a recording
        maskCapturedNetworkRequestFn: (req) => {
          if (req) {
            req.requestBody = null;
            req.responseBody = null;
          }
          return req;
        },
      },
    });
    // the renderer is known only once the stage is up; don't carry the last visit's.
    // Nor its qa flag: only a ?qa=1 visit registers it again.
    ph.unregister('renderer');
    ph.unregister('qa');
    ph.register(props);
    ph.register_once(once);
    ph.capture('$pageview');
  } catch {
    /* ignore */
  }
}
