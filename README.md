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

## The 3D model

The box and the willow come from **["One Wish Willow from Obsession movie"](https://sketchfab.com/3d-models/one-wish-willow-from-obsession-movie-7269f920284c4bb7a169ee110034d164) by [AlyStation](https://sketchfab.com/alyxyuu)**, licensed under [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/). The credit is shown on the first screen and after the wish. The original license note is in `assets/willow/license.txt`.

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

### Flow and sound
The first screen shows the box. Tapping it plays a short, slightly warped novelty jingle with a pop ("open the package to magically jingle and a fun pop surprise", as the box says), and the willow rises out of the dissolving box.

That tap is also the user activation browsers need before they allow audio, so the snap can sound at the exact moment of the break. The snap is the only sound after that: a short, dry crack, with no sounds when the halves land.

Every sound checks that the audio context is actually running. If it is not, the sound is dropped instead of queued, so a snap can never play late on a later tap.

### The one-time rule
- The stick counts as broken the moment it snaps. If the visitor leaves before writing a wish, they come back to the broken halves and the wish prompt.
- Once a wish is made, every later visit shows the halves where they fell, with *YOUR WISH HAS ALREADY BEEN MADE.*
- The wish text is never stored or sent anywhere.
- For testing, clearing the site's data (`localStorage` plus the `one-wish-willow` cookie) resets it.

### Controls
- **Pointer or touch:** press on the stick and pull across it (up or down) to snap it.
- **Keyboard:** after the first screen, focus the stick and hold <kbd>Space</kbd>. On the wish screen, hold <kbd>Enter</kbd> or the button to confirm.
