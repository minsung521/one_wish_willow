# One Wish Willow

A fan-made, one-time web experience inspired by the One Wish Willow from the film *Obsession*.
You get one branch and one chance. Bend it until it snaps, write one wish, and let it go.

## Run

This is a static site with no build step and no dependencies.

```bash
npx http-server . -p 8080   # or any static file server
```

To deploy, publish the repository root as-is (Vercel, Netlify, GitHub Pages, …).
It must be served over HTTP(S), because ES modules don't load from `file://`.

## How it works

| File | Role |
|---|---|
| `js/twig.js` | Branch model (seeded per visitor): bark shading, streaks, lenticels, buds, leaves, cut end, torn fibres, stress cracks |
| `js/main.js` | Scene, input, bending model (beam deflection plus a resistance curve plus a short "brink" hold before the snap), snap choreography, state flow |
| `js/pieces.js` | Rigid-body physics for the two halves and the wood chips |
| `js/audio.js` | All sound is synthesised with Web Audio: room tone, stick-slip creak, fibre cracks, the snap, pieces landing, wish tones |
| `js/haptics.js` | Vibration API, with the iOS 18 switch-tick as a best-effort fallback |
| `js/wish.js` | Wish prompt, press-and-hold confirm, and letters that burn away one by one |
| `js/storage.js` | One-time rule: state lives in localStorage and is mirrored to a cookie |

### The one-time rule
- The branch counts as broken the moment it snaps. If the visitor leaves before writing a wish, they come back to the broken branch and the wish prompt.
- Once a wish is made, every later visit shows the broken halves where they fell, with *YOUR WISH HAS ALREADY BEEN MADE.*
- The wish text is never stored or sent anywhere.
- For testing, clearing the site's data (`localStorage` plus the `one-wish-willow` cookie) resets it.

### Controls
- **Pointer or touch:** press on the branch and drag across it (up or down) to bend it.
- **Keyboard:** focus the branch and hold <kbd>Space</kbd>. On the wish screen, hold <kbd>Enter</kbd> or the button to confirm.
