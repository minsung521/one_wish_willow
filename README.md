# One Wish Willow

A fan-made, one-time web experience inspired by the One Wish Willow from the film *Obsession*.
You get one stick and one chance. Snap it in half, write one wish, and let it go.

## Run

This is a static site with no build step and no dependencies.

```bash
npx http-server . -p 8080   # or any static file server
```

To deploy, publish the repository root as-is (Vercel, Netlify, GitHub Pages, …).
It must be served over HTTP(S), because ES modules don't load from `file://`.

## The willow

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

### Sound timing
Browsers only start audio from a user activation (a click, a released tap, a key). A finger pressing and dragging is not one on mobile. So the first screen asks for one tap ("Tap to begin"), which unlocks audio before the stick can be touched.

Every sound checks that the audio context is actually running. If it is not, the sound is dropped instead of queued, so a snap can never play late on a later tap.

### The one-time rule
- The stick counts as broken the moment it snaps. If the visitor leaves before writing a wish, they come back to the broken halves and the wish prompt.
- Once a wish is made, every later visit shows the halves where they fell, with *YOUR WISH HAS ALREADY BEEN MADE.*
- The wish text is never stored or sent anywhere.
- For testing, clearing the site's data (`localStorage` plus the `one-wish-willow` cookie) resets it.

### Controls
- **Pointer or touch:** press on the stick and pull across it (up or down) to snap it.
- **Keyboard:** after the first screen, focus the stick and hold <kbd>Space</kbd>. On the wish screen, hold <kbd>Enter</kbd> or the button to confirm.
