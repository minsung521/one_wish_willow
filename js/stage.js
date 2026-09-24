// The 3D side of One Wish Willow: the Sketchfab model (box + willow), its
// lighting, and the break.
//
// The rest of the app works in 2D screen space (poses, physics, shadows,
// UI). The camera here is set up so that the z = 0 plane maps 1:1 onto CSS
// pixels, so a 2D pose {x, y, ang} can drive a 3D object directly. Each
// frame the WebGL canvas is composited into the 2D scene canvas.
//
// Model: "One Wish Willow from Obsession movie" by AlyStation, CC BY 4.0
// https://sketchfab.com/3d-models/one-wish-willow-from-obsession-movie-7269f920284c4bb7a169ee110034d164

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mulberry32, clamp } from './util.js';

const FOV = 16;
// The willow is presented rolled about its own axis so its best side (and a
// little of the cut end) faces the light.
const WILLOW_ROLL = 0.35;
const WILLOW_YAW = -0.14;

/** Bake a mesh into world space, lay its long axis along +x, centre it and scale its length to 1. */
function normalize(mesh, roll = 0) {
  const geo = mesh.geometry.clone();
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.attributes[name];
    if (a.isInterleavedBufferAttribute) geo.setAttribute(name, a.clone());
  }
  geo.applyMatrix4(mesh.matrixWorld);
  geo.deleteAttribute('uv1');
  geo.rotateY(Math.PI / 2); // the model lies along z
  if (roll) geo.rotateX(roll);
  geo.computeBoundingBox();
  const c = geo.boundingBox.getCenter(new THREE.Vector3());
  geo.translate(-c.x, -c.y, -c.z);
  const len = geo.boundingBox.max.x - geo.boundingBox.min.x;
  geo.scale(1 / len, 1 / len, 1 / len);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return { geometry: geo, material: mesh.material };
}

/** Cross-section profile along the stick: centre and half-extents per slice. */
function profile(geo, bins = 48) {
  const pos = geo.attributes.position;
  const bb = geo.boundingBox;
  const x0 = bb.min.x, x1 = bb.max.x;
  const minY = new Float32Array(bins).fill(Infinity), maxY = new Float32Array(bins).fill(-Infinity);
  const minZ = new Float32Array(bins).fill(Infinity), maxZ = new Float32Array(bins).fill(-Infinity);
  for (let i = 0; i < pos.count; i++) {
    const b = clamp(Math.floor(((pos.getX(i) - x0) / (x1 - x0)) * bins), 0, bins - 1);
    const y = pos.getY(i), z = pos.getZ(i);
    if (y < minY[b]) minY[b] = y;
    if (y > maxY[b]) maxY[b] = y;
    if (z < minZ[b]) minZ[b] = z;
    if (z > maxZ[b]) maxZ[b] = z;
  }
  const p = { x0, x1, bins, cy: [], cz: [], ry: [], rz: [] };
  for (let b = 0; b < bins; b++) {
    const ok = isFinite(minY[b]);
    p.cy.push(ok ? (minY[b] + maxY[b]) / 2 : 0);
    p.cz.push(ok ? (minZ[b] + maxZ[b]) / 2 : 0);
    p.ry.push(ok ? (maxY[b] - minY[b]) / 2 : 0);
    p.rz.push(ok ? (maxZ[b] - minZ[b]) / 2 : 0);
  }
  // fill empty slices from neighbours
  for (let b = 0; b < bins; b++) if (!p.ry[b]) { const n = p.ry[b - 1] ? b - 1 : b + 1; p.cy[b] = p.cy[n]; p.cz[b] = p.cz[n]; p.ry[b] = p.ry[n]; p.rz[b] = p.rz[n]; }
  p.at = (x) => {
    const f = clamp(((x - x0) / (x1 - x0)) * bins - 0.5, 0, bins - 1.001);
    const i = Math.floor(f), t = f - i, j = Math.min(bins - 1, i + 1);
    const L = (a) => a[i] + (a[j] - a[i]) * t;
    return { cy: L(p.cy), cz: L(p.cz), ry: L(p.ry), rz: L(p.rz) };
  };
  return p;
}

export async function loadModel(url, onProgress) {
  const gltf = await new GLTFLoader().loadAsync(url, onProgress);
  gltf.scene.updateMatrixWorld(true);
  let willow = null, box = null;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    if (/bark|willow/i.test(o.material.name + o.name)) willow = o;
    else if (/box/i.test(o.material.name + o.name)) box = o;
  });
  if (!willow || !box) throw new Error('model: willow or box mesh missing');
  const w = normalize(willow, WILLOW_ROLL);
  const b = normalize(box);
  return { willow: { ...w, profile: profile(w.geometry) }, box: b };
}

// ---------------------------------------------------------------------------
// The break
// ---------------------------------------------------------------------------

const ATTRS = ['position', 'normal', 'uv', 'tangent'];

function subset(src, keep) {
  const out = new THREE.BufferGeometry();
  for (const name of ATTRS) {
    const a = src.attributes[name];
    if (!a) continue;
    const size = a.itemSize;
    const arr = new Float32Array(keep.length * 3 * size);
    let o = 0;
    for (const t of keep) {
      for (let v = 0; v < 3; v++) {
        const idx = t * 3 + v;
        for (let k = 0; k < size; k++) arr[o++] = a.array[idx * size + k];
      }
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/**
 * Split the willow at `x0` (model units, length 1) into two rigid halves with
 * torn, splintered faces. `ts` is +1 when the underside (−y) is in tension.
 */
export function breakWillow(model, x0, ts, seed) {
  const rand = mulberry32(seed >>> 0);
  const geo = model.geometry.index ? model.geometry.toNonIndexed() : model.geometry;
  const prof = model.profile;
  const sec = prof.at(x0);
  const r0 = Math.max(sec.ry, sec.rz);
  const tensionAngle = ts > 0 ? -Math.PI / 2 : Math.PI / 2; // angle of −y or +y

  // the tear line around the circumference: short on the compression side,
  // ragged and long on the tension side
  const H = [];
  for (let k = 0; k < 4; k++) H.push({ f: 1 + k * 2 + Math.floor(rand() * 2), p: rand() * 6.283, a: (rand() - 0.5) * r0 * (0.26 / (k + 1)) });
  const tension = (th) => {
    let d = Math.abs(Math.atan2(Math.sin(th - tensionAngle), Math.cos(th - tensionAngle)));
    return Math.max(0, 1 - d / 1.9);
  };
  const cutAt = (th) => {
    let x = x0;
    for (const h of H) x += h.a * Math.sin(h.f * th + h.p);
    return x + tension(th) * r0 * 0.1 * Math.sin(th * 7 + H[0].p);
  };

  const pos = geo.attributes.position;
  const left = [], right = [];
  const n = pos.count / 3;
  for (let t = 0; t < n; t++) {
    let x = 0, y = 0, z = 0;
    for (let v = 0; v < 3; v++) { x += pos.getX(t * 3 + v); y += pos.getY(t * 3 + v); z += pos.getZ(t * 3 + v); }
    x /= 3; y /= 3; z /= 3;
    const th = Math.atan2(y - sec.cy, z - sec.cz);
    (x < cutAt(th) ? left : right).push(t);
  }

  // measure the real radius of the bark around the cut, per angle
  const A = 48;
  const rad = new Float32Array(A).fill(0);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    if (Math.abs(x - x0) > r0 * 1.6) continue;
    const dy = pos.getY(i) - sec.cy, dz = pos.getZ(i) - sec.cz;
    const a = Math.floor(((Math.atan2(dy, dz) + Math.PI) / (2 * Math.PI)) * A) % A;
    rad[a] = Math.max(rad[a], Math.hypot(dy, dz));
  }
  for (let a = 0; a < A; a++) if (!rad[a]) rad[a] = r0;
  const radAt = (th) => {
    const f = ((th + Math.PI) / (2 * Math.PI)) * A;
    const i = Math.floor(f) % A, j = (i + 1) % A, t = f - Math.floor(f);
    return (rad[i] * (1 - t) + rad[j] * t) * 1.03;
  };

  return {
    left: subset(geo, left),
    right: subset(geo, right),
    capLeft: fractureFace(sec, cutAt, radAt, tension, r0, +1, rand),
    capRight: fractureFace(sec, cutAt, radAt, tension, r0, -1, rand),
    x0,
    r0,
  };
}

/**
 * A torn face of fresh wood: rings of vertices from the bark edge in to the
 * pith, pushed in and out along the grain so it splinters instead of lying
 * flat. dir = +1 for the left half (fibres reach to +x), −1 for the right.
 */
function fractureFace(sec, cutAt, radAt, tension, r0, dir, rand) {
  const N = 40, RINGS = 4;
  const verts = [];
  const cols = [];
  const pale = new THREE.Color(0xb89c74), dark = new THREE.Color(0x7d6042), c = new THREE.Color();
  const grid = [];
  for (let k = 0; k <= RINGS; k++) {
    const row = [];
    const f = 1 - k / RINGS; // 1 at the bark, 0 at the centre
    for (let i = 0; i < N; i++) {
      const th = (i / N) * Math.PI * 2 - Math.PI;
      const R = radAt(th) * (k === 0 ? 1 : f * (0.96 + rand() * 0.06));
      // fibres: longer, sharper splinters where the wood was in tension
      const ten = tension(th);
      let dx = 0;
      if (k > 0) {
        const len = r0 * (0.05 + ten * 0.38) * Math.pow(rand(), 1.4);
        dx = (rand() < 0.5 + 0.2 * dir ? dir : -dir) * len * (k === RINGS ? 0.4 : 1);
      }
      const x = cutAt(th) + dx;
      row.push(verts.length / 3);
      verts.push(x, sec.cy + Math.sin(th) * R, sec.cz + Math.cos(th) * R);
      c.copy(pale).lerp(dark, rand() * 0.45 + (k === 0 ? 0.35 : 0));
      cols.push(c.r, c.g, c.b);
    }
    grid.push(row);
  }
  const idx = [];
  for (let k = 0; k < RINGS; k++) {
    for (let i = 0; i < N; i++) {
      const a = grid[k][i], b = grid[k][(i + 1) % N], cc = grid[k + 1][i], d = grid[k + 1][(i + 1) % N];
      idx.push(a, cc, b, b, cc, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(idx);
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export class Stage {
  constructor(model) {
    this.model = model;
    const canvas = document.createElement('canvas');
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    r.setClearColor(0x000000, 0);
    this.renderer = r;
    this.canvas = canvas;

    const scene = new THREE.Scene();
    this.scene = scene;
    const pmrem = new THREE.PMREMGenerator(r);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.1;

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 1, 10000);

    scene.add(new THREE.HemisphereLight(0x7a6858, 0x060504, 0.42));
    const key = new THREE.DirectionalLight(0xffdcb4, 2.5);
    this.key = key;
    scene.add(key);
    scene.add(key.target);
    const rim = new THREE.DirectionalLight(0xcfc6b8, 1.0);
    this.rim = rim;
    scene.add(rim);
    scene.add(rim.target);

    // materials
    const bark = model.willow.material;
    bark.side = THREE.DoubleSide;
    // the baked bark texture is very dark; lift it just enough to read under the
    // stage light, and make it matte: the baked roughness map is far too glossy
    bark.color.setRGB(1.5, 1.32, 1.18);
    bark.roughnessMap = null;
    bark.roughness = 0.9;
    bark.metalness = 0;
    bark.envMapIntensity = 0.3;
    if (bark.normalScale) bark.normalScale.set(1.0, 1.0);
    bark.needsUpdate = true;
    this.bark = bark;
    this.woodMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, flatShading: true, side: THREE.DoubleSide });
    const boxMat = model.box.material;
    boxMat.side = THREE.DoubleSide;
    // printed card, not glossy plastic
    boxMat.roughnessMap = null;
    boxMat.roughness = 0.86;
    boxMat.envMapIntensity = 0.45;
    boxMat.color.setRGB(0.92, 0.9, 0.86);
    boxMat.needsUpdate = true;
    this.boxMat = boxMat;

    // the intact willow
    this.stick = this._holder(new THREE.Mesh(model.willow.geometry, bark));
    // the box
    this.boxRoot = new THREE.Group();
    this.boxSpin = new THREE.Group();
    this.boxSpin.rotation.order = 'YXZ'; // tip the face to the light, then turn
    this.boxMesh = new THREE.Mesh(model.box.geometry, boxMat);
    this.boxSpin.add(this.boxMesh);
    this.boxRoot.add(this.boxSpin);
    scene.add(this.boxRoot);
    this.halves = null;
    this.W = 1;
    this.H = 1;
  }

  _holder(mesh) {
    const root = new THREE.Group();
    const inner = new THREE.Group();
    inner.rotation.y = WILLOW_YAW;
    inner.add(mesh);
    root.add(inner);
    this.scene.add(root);
    return { root, inner, mesh };
  }

  resize(W, H, dpr) {
    this.W = W;
    this.H = H;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(W, H, false);
    const cam = this.camera;
    cam.aspect = W / H;
    const D = H / 2 / Math.tan((FOV * Math.PI) / 360);
    cam.position.set(0, 0, D);
    cam.near = D * 0.2;
    cam.far = D * 3;
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    this.key.position.set(-0.55 * D, 0.95 * D, 0.9 * D);
    this.rim.position.set(0.7 * D, -0.15 * D, -1.0 * D);
  }

  /** Screen pose → world transform for a willow holder. */
  _place(h, pose, L, spin = 0) {
    h.root.position.set(pose.x - this.W / 2, this.H / 2 - pose.y, 0);
    h.root.rotation.z = -pose.ang;
    h.root.scale.setScalar(L);
    h.mesh.rotation.x = spin;
  }

  showStick(pose, L, visible = true, spin = 0) {
    this.stick.root.visible = visible;
    if (visible) this._place(this.stick, pose, L, spin);
  }

  /** Build the two halves for a break at stick-local x (model units). */
  breakAt(x0, ts, seed) {
    this.clearHalves();
    const b = breakWillow(this.model.willow, x0, ts, seed);
    const mk = (geo, cap) => {
      const h = this._holder(new THREE.Mesh(geo, this.bark));
      h.mesh.add(new THREE.Mesh(cap, this.woodMat));
      return h;
    };
    this.halves = [mk(b.left, b.capLeft), mk(b.right, b.capRight)];
    this.brk = b;
    return b;
  }

  clearHalves() {
    if (!this.halves) return;
    for (const h of this.halves) {
      this.scene.remove(h.root);
      h.mesh.geometry.dispose();
      h.mesh.children.forEach((c) => c.geometry.dispose());
    }
    this.halves = null;
  }

  showHalves(poses, L, spins = [0, 0]) {
    if (!this.halves) return;
    this.halves.forEach((h, i) => {
      h.root.visible = !!poses[i];
      if (poses[i]) this._place(h, poses[i], L, spins[i]);
    });
  }

  /** The box: centred on screen, `s` px long, with a gentle idle motion. */
  showBox(visible, x, y, s, yaw = 0, pitch = 0, lift = 0, opacity = 1) {
    this.boxRoot.visible = visible && opacity > 0.001;
    if (!this.boxRoot.visible) return;
    this.boxRoot.position.set(x - this.W / 2, this.H / 2 - y + lift, 0);
    this.boxRoot.scale.setScalar(s);
    this.boxSpin.rotation.set(pitch, yaw, 0);
    const transparent = opacity < 0.999;
    if (this.boxMat.transparent !== transparent) {
      this.boxMat.transparent = transparent;
      // while it dissolves, let the willow inside show through
      this.boxMat.depthWrite = !transparent;
      this.boxMat.needsUpdate = true;
    }
    this.boxMat.opacity = opacity;
  }

  /** Projected screen rectangle of the box (for hit testing). */
  boxRect() {
    this.boxRoot.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(this.boxMesh, true);
    const pts = [];
    for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) pts.push(new THREE.Vector3(x, y, z).project(this.camera));
    const xs = pts.map((p) => ((p.x + 1) / 2) * this.W);
    const ys = pts.map((p) => ((1 - p.y) / 2) * this.H);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
