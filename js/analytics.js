// Analytics: one thin wrapper around PostHog. The SDK is not on the page yet
// (MIN-124); until it is, and whenever it fails to load or is blocked, every
// call is silently dropped. Nothing here may ever break the experience.

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
