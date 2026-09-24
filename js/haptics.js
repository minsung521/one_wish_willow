// Haptics: the Vibration API where it exists (Android), and the iOS 18+
// "switch" checkbox tick as a best-effort fallback on iPhone.

const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
let iosSwitch = null;
let last = 0;

function iosTick() {
  if (!iosSwitch) {
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
    iosSwitch = label;
  }
  try {
    iosSwitch.click();
  } catch {
    /* ignore */
  }
}

/**
 * @param {number|number[]} pattern vibration pattern in ms
 * @param {number} minGap minimum ms since the previous buzz
 */
export function buzz(pattern, minGap = 0) {
  const now = performance.now();
  if (now - last < minGap) return;
  last = now;
  if (canVibrate) {
    try {
      navigator.vibrate(pattern);
    } catch {
      /* ignore */
    }
    return;
  }
  iosTick();
}
