// Fixed WebGL planet behind the page — after the Ascend scene spec
// (three r0.143: WebGL1Renderer, outputEncoding, three composers, FinalPass).
//
// One deliberate difference: the original loads planet.glb / planet-lights.glb /
// planet-clouds.png from a remote bucket. Hosted pages here may only load
// scripts from public CDNs, not data from other servers, so the Earth's
// colour map, night-lights map and cloud texture are generated procedurally
// on a canvas at start-up. Every shader, CONFIG value, composer and the scroll
// choreography follow the spec.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { GammaCorrectionShader } from "three/examples/jsm/shaders/GammaCorrectionShader.js";
import { CopyShader } from "three/examples/jsm/shaders/CopyShader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const CONFIG = {
  rimColor: "#c1faff", rimPower: 2.4, nightLights: 10, terrainDepth: 0.33, terrainShade: 1.3,
  oceanGlint: 0.45, oceanDeep: 0.12, oceanFlow: 3, oceanFlowSpeed: 0.8, oceanFlowScale: 2.1,
  glowColor: "#3a6cff", glowIntensity: 1.5, planetRadius: 1.95, spin: 0.03, initRotation: 2.07,
  tilt: 0.37, autoRotate: 0,
  cloud1Height: 1.005, cloud1Opacity: 0.6, cloud1Spin: 0.06,
  cloud2Height: 1.03, cloud2Opacity: 0.5, cloud2Spin: 0.14,
  cloud3Height: 1.075, cloud3Opacity: 0.5, cloud3Spin: 0.1,
  bgColor: "#040a1e", flameColor: "#3a6cff", flameColor2: "#c1faff", flameAmt: 0.15,
  atmoColor: "#9fc4ff", atmoCount: 320, atmoSize: 22, atmoSpeed: 0.8,
  starColor: "#cfe0ff", starCount: 1400, starSize: 1.6, starFlicker: 1,
  markerColor: "#ffd27a", markerCount: 60, markerSize: 16, markerSpeed: 0.5,
};
const LAYERS = { NONE: 0, TORUS_SCENE: 1, BLOOM_SCENE: 2, ENTIRE_SCENE: 3 };

const STOPS_X = [{ p: 0, v: 0 }, { p: 0.32, v: -3.1 }, { p: 0.64, v: 3.2 }, { p: 1, v: 0 }];
const STOPS_Y = [{ p: 0, v: -4.5 }, { p: 0.32, v: 0.55 }, { p: 0.64, v: 0.45 }, { p: 1, v: 0.15 }];
const STOPS_S = [{ p: 0, v: 2.15 }, { p: 0.32, v: 1.0 }, { p: 0.64, v: 0.92 }, { p: 1, v: 1.12 }];
const ENTRY_DUR = 1.9;
const ENTRY_START_Y = -6.5;

const Lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hexToVec3 = (hex) => {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
};
function sample(stops, p) {
  if (p <= stops[0].p) return stops[0].v;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (p <= b.p) {
      let t = (p - a.p) / (b.p - a.p);
      t = t * t * (3 - 2 * t);
      return Lerp(a.v, b.v, t);
    }
  }
  return stops[stops.length - 1].v;
}

const SNOISE = /* glsl */ `
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0); const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy)); vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz); vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy); vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + 1.0 * C.xxx; vec3 x2 = x0 - i2 + 2.0 * C.xxx; vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0/7.0; vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z *ns.z);
  vec4 x_ = floor(j * ns.z); vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ *ns.x + ns.yyyy; vec4 y = y_ *ns.x + ns.yyyy; vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy); vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0; vec4 s1 = floor(b1)*2.0 + 1.0; vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy; vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy,h.x); vec3 p1 = vec3(a0.zw,h.y); vec3 p2 = vec3(a1.xy,h.z); vec3 p3 = vec3(a1.zw,h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0); m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

// ---------------------------------------------------------------------------
// Procedural Earth textures (stand-ins for the remote GLB/PNG assets)
// ---------------------------------------------------------------------------
function makeNoise3(seed) {
  // Classic 3D simplex noise (Gustavson), seeded permutation.
  const grad = [[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]];
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = seed >>> 0;
  for (let i = 255; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const F3 = 1 / 3, G3 = 1 / 6;
  return (x, y, z) => {
    const s1 = (x + y + z) * F3;
    const i = Math.floor(x + s1), j = Math.floor(y + s1), k = Math.floor(z + s1);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    const corner = (tx, ty, tz, gi) => {
      let tt = 0.6 - tx * tx - ty * ty - tz * tz;
      if (tt < 0) return 0;
      const g = grad[gi % 12];
      tt *= tt;
      return tt * tt * (g[0] * tx + g[1] * ty + g[2] * tz);
    };
    const n0 = corner(x0, y0, z0, perm[ii + perm[jj + perm[kk]]]);
    const n1 = corner(x1, y1, z1, perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]]);
    const n2 = corner(x2, y2, z2, perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]]);
    const n3 = corner(x3, y3, z3, perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]]);
    return 32 * (n0 + n1 + n2 + n3);
  };
}

function fbm(noise, x, y, z, oct) {
  let a = 0.5, f = 1, s = 0;
  for (let o = 0; o < oct; o++) {
    s += a * noise(x * f, y * f, z * f);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}

// Matches THREE.SphereGeometry: u around, v from north pole; canvas row 0 = north.
const dirFromUV = (u, v) => {
  const phi = u * Math.PI * 2, theta = v * Math.PI;
  return [-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta)];
};

function buildEarth(W = 1024, H = 512) {
  const noise = makeNoise3(20261029);
  const detail = makeNoise3(7);
  const day = document.createElement("canvas");
  const night = document.createElement("canvas");
  day.width = night.width = W;
  day.height = night.height = H;
  const dctx = day.getContext("2d");
  const nctx = night.getContext("2d");
  const dimg = dctx.createImageData(W, H);
  const nimg = nctx.createImageData(W, H);
  const land = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const lat = Math.abs(0.5 - v) * 2; // 0 equator, 1 pole
    for (let x = 0; x < W; x++) {
      const [dx, dy, dz] = dirFromUV((x + 0.5) / W, v);
      const h = fbm(noise, dx * 1.6 + 3.1, dy * 1.6, dz * 1.6, 5) + 0.12 * detail(dx * 9, dy * 9, dz * 9);
      const i = (y * W + x) * 4;
      let r, g, b;
      if (h > 0.04) {
        land[y * W + x] = 1;
        const e = Math.min(1, (h - 0.04) * 3.2);
        const dry = clamp(0.55 - Math.abs(lat - 0.28) * 2.2 + 0.25 * detail(dx * 4, dy * 4, dz * 4), 0, 1);
        r = Lerp(Lerp(52, 150, dry), 168, e * 0.6);
        g = Lerp(Lerp(92, 128, dry), 150, e * 0.5);
        b = Lerp(Lerp(44, 82, dry), 120, e * 0.5);
        if (lat > 0.82) { r = g = 235; b = 242; }
        // City lights: sparse warm clusters away from the poles.
        const c = detail(dx * 40, dy * 40, dz * 40) + 0.6 * detail(dx * 90 + 5, dy * 90, dz * 90);
        const city = lat < 0.7 && c > 0.62 ? Math.min(1, (c - 0.62) * 3) : 0;
        nimg.data[i] = 255 * city;
        nimg.data[i + 1] = 200 * city;
        nimg.data[i + 2] = 120 * city;
        nimg.data[i + 3] = 255;
      } else {
        const d = clamp(-h * 2.2, 0, 1);
        r = Lerp(26, 6, d);
        g = Lerp(86, 32, d);
        b = Lerp(138, 82, d);
        if (lat > 0.9) { r = g = 225; b = 236; }
        nimg.data[i + 3] = 255;
      }
      // Darker albedo: the spec's ambient light (1.8) is tuned for a
      // photographic Earth texture, which is much darker than flat colours.
      dimg.data[i] = r * 0.72;
      dimg.data[i + 1] = g * 0.72;
      dimg.data[i + 2] = b * 0.72;
      dimg.data[i + 3] = 255;
    }
  }
  dctx.putImageData(dimg, 0, 0);
  nctx.putImageData(nimg, 0, 0);
  return { day, night, land, W, H };
}

function buildClouds(N = 256) {
  // Tileable value noise so RepeatWrapping x5 has no seams.
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(N, N);
  const lattice = (period, seed) => {
    const a = new Float32Array(period * period);
    let s = seed;
    for (let i = 0; i < a.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      a[i] = s / 4294967296;
    }
    return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const fx = x - xi, fy = y - yi;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const at = (X, Y) => a[((Y % period) + period) % period * period + ((X % period) + period) % period];
      return Lerp(Lerp(at(xi, yi), at(xi + 1, yi), sx), Lerp(at(xi, yi + 1), at(xi + 1, yi + 1), sx), sy);
    };
  };
  const octs = [4, 8, 16, 32].map((p, i) => [p, lattice(p, 99 + i * 17)]);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let v = 0, amp = 0.5, tot = 0;
      for (const [p, fn] of octs) {
        v += amp * fn((x / N) * p, (y / N) * p);
        tot += amp;
        amp *= 0.5;
      }
      v /= tot;
      const a = clamp((v - 0.6) * 2.2, 0, 1);
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
const canvas = document.querySelector(".planet-canvas");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function start() {
  const renderer = new THREE.WebGL1Renderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 0, 8);
  camera.layers.enable(LAYERS.TORUS_SCENE);
  camera.layers.enable(LAYERS.BLOOM_SCENE);
  camera.layers.enable(LAYERS.ENTIRE_SCENE);
  scene.add(camera);

  const ambient = new THREE.AmbientLight(0xffffff, 1.8);
  ambient.layers.set(LAYERS.ENTIRE_SCENE);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(0, 10, 2);
  dir.layers.set(LAYERS.ENTIRE_SCENE);
  scene.add(dir);

  const w = window.innerWidth, h = window.innerHeight;
  const torusComposer = new EffectComposer(renderer);
  torusComposer.renderToScreen = false;
  torusComposer.addPass(new RenderPass(scene, camera));
  torusComposer.addPass(new ShaderPass(GammaCorrectionShader));
  const torusBloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.22, 0.2, 0);
  torusComposer.addPass(torusBloom);
  torusComposer.addPass(new ShaderPass(CopyShader));

  const bloomComposer = new EffectComposer(renderer);
  bloomComposer.renderToScreen = false;
  bloomComposer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.6, 0);
  bloomComposer.addPass(bloomPass);
  bloomComposer.addPass(new ShaderPass(GammaCorrectionShader));

  const FinalPass = {
    uniforms: {
      iTime: { value: 0 }, tDiffuse: { value: null }, torusTexture: { value: null }, bloomTexture: { value: null }, haloTexture: { value: null },
      uBg: { value: hexToVec3(CONFIG.bgColor) }, uFlameA: { value: hexToVec3(CONFIG.flameColor) },
      uFlameB: { value: hexToVec3(CONFIG.flameColor2) }, uFlameAmt: { value: CONFIG.flameAmt },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float iTime; uniform sampler2D tDiffuse; uniform sampler2D bloomTexture; uniform sampler2D torusTexture; uniform sampler2D haloTexture;
      uniform vec3 uBg; uniform vec3 uFlameA; uniform vec3 uFlameB; uniform float uFlameAmt;
      varying vec2 vUv;
      vec3 warp3d(vec3 pos, float t){ float curv=.8,a=1.9,b=0.7; pos*=2.;
        pos.x+=curv*sin(t+a*pos.y)+t*b; pos.y+=curv*cos(t+a*pos.x);
        pos.y+=curv*sin(t+a*pos.z)+t*b; pos.z+=curv*cos(t+a*pos.y);
        pos.z+=curv*sin(t+a*pos.x)+t*b; pos.x+=curv*cos(t+a*pos.z);
        return 0.5+0.5*cos(pos.xyz+vec3(1,2,4)); }
      void main(){
        vec2 uv = 2.*vUv - 1.;
        vec3 w = pow(warp3d(vec3(uv.x, sin(uv.y), uv.y), iTime*1.5), vec3(1.5));
        vec3 flame = 1.5*uFlameA*w.x; flame*=w.y; flame += uFlameB*w.z;
        flame *= smoothstep(0.25, 1., abs(uv.y));
        float md = smoothstep(-0.7, 1., -uv.y*uv.x); flame *= md*md;
        vec3 bg = uBg * (1.0 - 0.4 * length(uv));
        vec3 halo = texture2D(haloTexture, vUv).xyz;
        gl_FragColor = vec4(bg + flame*uFlameAmt + texture2D(bloomTexture, vUv).xyz + texture2D(torusTexture, vUv).xyz + texture2D(tDiffuse, vUv).xyz + halo, 1.);
      }`,
  };
  const finalComposer = new EffectComposer(renderer);
  finalComposer.addPass(new RenderPass(scene, camera));
  const finalPass = new ShaderPass(FinalPass);
  finalPass.uniforms.bloomTexture.value = bloomComposer.renderTarget1.texture;
  finalPass.uniforms.torusTexture.value = torusComposer.renderTarget1.texture;
  finalComposer.addPass(finalPass);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.enabled = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = CONFIG.autoRotate;
  controls.minDistance = 3.5;
  controls.maxDistance = 16;
  controls.target.set(0, 0, 0);

  // ---- groups
  const worldGroup = new THREE.Group();
  const planetGroup = new THREE.Group();
  const cloudGroup = new THREE.Group();
  planetGroup.rotation.z = CONFIG.tilt;
  cloudGroup.rotation.z = CONFIG.tilt;
  cloudGroup.visible = false;
  worldGroup.add(planetGroup, cloudGroup);
  worldGroup.position.set(STOPS_X[0].v, STOPS_Y[0].v, 0);
  worldGroup.scale.setScalar(STOPS_S[0].v);
  scene.add(worldGroup);

  // ---- atmosphere halo
  const glowMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uGlow: { value: hexToVec3(CONFIG.glowColor) }, uIntensity: { value: CONFIG.glowIntensity } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 uGlow; uniform float uIntensity; varying vec2 vUv;
        void main(){
          float d = length(vUv - 0.5) * 2.0;
          float a = pow(clamp(1.0 - d, 0.0, 1.0), 2.2);
          gl_FragColor = vec4(uGlow * a * uIntensity, a);
        }`,
    }),
  );
  glowMesh.scale.setScalar(CONFIG.planetRadius * 2.3);
  // The halo lives only in the torus pass, so it is drawn once and softened
  // by that pass's light bloom before the final composite adds it.
  glowMesh.layers.set(LAYERS.TORUS_SCENE);
  worldGroup.add(glowMesh);

  // ---- ambient motes
  const atmoGeo = new THREE.BufferGeometry();
  {
    const n = CONFIG.atmoCount;
    const pos = new Float32Array(n * 3), size = new Float32Array(n), seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = Math.random() * 2 - 1;
      pos[i * 3 + 1] = Math.random() * 2 - 1;
      pos[i * 3 + 2] = Math.random() * 2 - 1;
      size[i] = CONFIG.atmoSize * (0.4 + Math.random());
      seed[i] = Math.random();
    }
    atmoGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    atmoGeo.setAttribute("size", new THREE.BufferAttribute(size, 1));
    atmoGeo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
  }
  const atmoMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uRes: { value: new THREE.Vector2(w, h) }, uColor: { value: hexToVec3(CONFIG.atmoColor) } },
    vertexShader: `
      attribute float size; attribute float seed; uniform float uTime; uniform vec2 uRes;
      varying float vA;
      vec3 warp(vec3 p, float t){ float c=0.9,a=1.9,b=0.02,s=0.05; p*=2.;
        p.x+=c*sin(s*t+a*p.y)+t*b; p.y+=c*cos(s*t+a*p.x); p.y+=c*sin(s*t+a*p.z)+t*b;
        p.z+=c*cos(s*t+a*p.y); p.z+=c*sin(s*t+a*p.x)+t*b; p.x+=c*cos(s*t+a*p.z);
        return cos(p+vec3(1,2,4)); }
      void main(){
        vec3 v = position*4.0 + warp(position, uTime)*1.2;
        vec4 mv = modelViewMatrix * vec4(v, 1.0);
        float r = length(v); float farF = 1.0 - smoothstep(5.0, 6.5, r); float nearF = smoothstep(0.0, 0.5, -mv.z);
        vA = farF * nearF;
        gl_PointSize = size * uRes.y / 900.0 / -mv.z; gl_PointSize = max(gl_PointSize, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; varying float vA;
      void main(){ vec2 p = gl_PointCoord - 0.5; float l = length(p); if (l > 0.5) discard;
        float tex = smoothstep(0.5, 0.0, l); gl_FragColor = vec4(uColor * tex, tex * vA * 0.55); }`,
  });
  const atmo = new THREE.Points(atmoGeo, atmoMat);
  atmo.frustumCulled = false;
  atmo.layers.set(LAYERS.ENTIRE_SCENE);
  atmo.layers.enable(LAYERS.BLOOM_SCENE);
  atmo.onBeforeRender = () => {
    const t = (performance.now() / 1000) * CONFIG.atmoSpeed * 8;
    atmoMat.uniforms.uTime.value = t;
    atmo.position.copy(camera.position);
    finalPass.uniforms.iTime.value = performance.now() / 1000;
  };
  scene.add(atmo);

  // ---- starfield
  const starGeo = new THREE.BufferGeometry();
  {
    const n = CONFIG.starCount;
    const pos = new Float32Array(n * 3), seed = new Float32Array(n), bright = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      pos[i * 3] = 90 * r * Math.cos(th);
      pos[i * 3 + 1] = 90 * u;
      pos[i * 3 + 2] = 90 * r * Math.sin(th);
      seed[i] = Math.random() * 100;
      bright[i] = 0.35 + Math.random() * 0.65;
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
    starGeo.setAttribute("bright", new THREE.BufferAttribute(bright, 1));
  }
  const starMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uSize: { value: CONFIG.starSize }, uFlicker: { value: CONFIG.starFlicker }, uColor: { value: hexToVec3(CONFIG.starColor) }, uRes: { value: new THREE.Vector2(w, h) } },
    vertexShader: `
      attribute float seed; attribute float bright;
      uniform float uTime; uniform float uSize; uniform float uFlicker; uniform vec2 uRes;
      varying float vTw;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float tw = 0.6 + 0.4 * sin(uTime * uFlicker + seed);
        vTw = bright * tw;
        gl_PointSize = max(uSize * uRes.y / 900.0 * (90.0 / max(-mv.z, 1.0)), 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; varying float vTw;
      void main(){
        vec2 p = gl_PointCoord - 0.5; float l = length(p); if (l > 0.5) discard;
        float core = smoothstep(0.5, 0.0, l);
        gl_FragColor = vec4(uColor, core * vTw);
      }`,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  stars.layers.set(LAYERS.ENTIRE_SCENE);
  stars.layers.enable(LAYERS.BLOOM_SCENE);
  scene.add(stars);

  // ---- time + choreography state
  let planetTime = 0, cloudTime = 0, starTime = 0, markerTime = 0, spinPhase = 0;
  let curP = 0, curX = STOPS_X[0].v, curY = STOPS_Y[0].v, curS = STOPS_S[0].v;
  let entryT = reduceMotion ? ENTRY_DUR : 0;
  let entryActive = false;
  let planetMesh = null, markerMat = null;
  const cloudMeshes = [];
  const cloudOpacity = [];
  const planetTimeU = { value: 0 };
  const cloudTimeU = { value: 0 };

  // ---- planet (built after first paint so the page appears instantly)
  setTimeout(() => {
    const earth = buildEarth();
    const map = new THREE.CanvasTexture(earth.day);
    map.encoding = THREE.sRGBEncoding;
    const nightTex = new THREE.CanvasTexture(earth.night);
    nightTex.encoding = THREE.sRGBEncoding;

    const geo = new THREE.SphereGeometry(CONFIG.planetRadius, 160, 120);
    const mat = new THREE.MeshStandardMaterial({ map, metalness: 0, roughness: 1, envMapIntensity: 0 });
    mat.extensions = { derivatives: true };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        time: planetTimeU, noiseScale: { value: 30 }, speedX: { value: 1.5 }, speedY: { value: 2.0 }, speedZ: { value: 2.5 },
        rimColor: { value: new THREE.Color(CONFIG.rimColor) }, rimPower: { value: CONFIG.rimPower },
        nightBlendTexture: { value: nightTex }, nightLights: { value: CONFIG.nightLights },
        terrainDepth: { value: CONFIG.terrainDepth }, terrainShade: { value: CONFIG.terrainShade },
        oceanGlint: { value: CONFIG.oceanGlint }, oceanDeep: { value: CONFIG.oceanDeep },
        oceanFlow: { value: CONFIG.oceanFlow }, oceanFlowSpeed: { value: CONFIG.oceanFlowSpeed }, oceanFlowScale: { value: CONFIG.oceanFlowScale },
      });
      shader.vertexShader = `varying vec2 vCustomUv;\n${shader.vertexShader.replace("void main() {", "void main() {\n  vCustomUv = uv;")}`;
      shader.fragmentShader = `
        uniform float time; uniform float noiseScale; uniform float speedX; uniform float speedY; uniform float speedZ;
        uniform vec3 rimColor; uniform float rimPower; uniform sampler2D nightBlendTexture; uniform float nightLights;
        uniform float terrainDepth; uniform float terrainShade; uniform float oceanGlint; uniform float oceanDeep;
        uniform float oceanFlow; uniform float oceanFlowSpeed; uniform float oceanFlowScale;
        varying vec2 vCustomUv;
        ${SNOISE}
        ${shader.fragmentShader}`.replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
        vec3 normalizedNormal = normalize(vNormal);
        vec3 viewDir = normalize(vViewPosition);
        float rim = 1.0 - max(dot(viewDir, normalizedNormal), 0.0);
        rim = pow(rim, rimPower); rim = pow(rim, 1.5); rim *= 0.7;
        vec3 currentColor = gl_FragColor.rgb;
        float blueDom = currentColor.b - max(currentColor.r, currentColor.g);
        float waterMask = clamp(smoothstep(-0.005, 0.03, blueDom), 0.0, 1.0);
        float shimmer = snoise(vec3(vCustomUv.x * noiseScale + time * speedX, vCustomUv.y * noiseScale - time * speedY, time * speedZ));
        gl_FragColor.rgb += waterMask * shimmer * 0.025;
        float fT = time * oceanFlowSpeed * 4.0;
        float fS = 4.0 * oceanFlowScale;
        float warp = snoise(vec3(vCustomUv.x * fS - fT * 0.5, vCustomUv.y * fS + fT * 0.4, fT * 0.5));
        float flow = snoise(vec3(vCustomUv.x * fS * 2.0 + fT * 0.6 + warp, vCustomUv.y * fS * 2.0 - fT * 0.5, fT * 0.7));
        flow = warp * 0.6 + flow * 0.4;
        gl_FragColor.rgb += waterMask * flow * 0.12 * oceanFlow;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.01, 0.06, 0.16), waterMask * oceanDeep);
        vec3 finalColor = mix(gl_FragColor.rgb, rimColor, rim);
        gl_FragColor = vec4(finalColor, 1.0);
        vec3 surfPos = -vViewPosition;
        float terrH = dot(texture2D(map, vCustomUv).rgb, vec3(0.299, 0.587, 0.114));
        vec3 sigX = dFdx(surfPos), sigY = dFdy(surfPos);
        vec3 vR1 = cross(sigY, normalizedNormal), vR2 = cross(normalizedNormal, sigX);
        float fDet = dot(sigX, vR1);
        vec3 vGrad = sign(fDet) * (dFdx(terrH) * vR1 + dFdy(terrH) * vR2);
        vec3 bumpedNormal = normalize(abs(fDet) * normalizedNormal - terrainDepth * vGrad);
        vec3 shadeNormal = mix(bumpedNormal, normalizedNormal, waterMask);
        vec3 cityLights = texture2D(nightBlendTexture, vCustomUv).rgb * gl_FragColor.rgb * nightLights;
        vec3 viewSunDir = normalize(vec3(-0.9, 0.18, 0.4));
        float ndl = dot(normalizedNormal, viewSunDir);
        float dayAmt = smoothstep(-0.05, 0.35, ndl);
        float relief = dot(shadeNormal, viewSunDir) - ndl;
        gl_FragColor.rgb *= clamp(1.0 + relief * terrainShade * dayAmt, 0.55, 1.6);
        float nightFactor  = smoothstep(0.18, -0.30, ndl);
        float lightsFactor = smoothstep(0.30, -0.35, ndl);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * 0.08, nightFactor);
        gl_FragColor.rgb += cityLights * lightsFactor;
        vec3 halfDir = normalize(viewSunDir + viewDir);
        float ripple = snoise(vec3(vCustomUv * 240.0, time * 4.0));
        float ndh = max(dot(normalizedNormal, halfDir) + ripple * 0.02, 0.0);
        float glint = pow(ndh, 140.0);
        gl_FragColor.rgb += glint * waterMask * dayAmt * oceanGlint * vec3(1.0, 0.97, 0.88);`,
      );
    };
    planetMesh = new THREE.Mesh(geo, mat);
    handle.planetMat = mat;
    planetMesh.layers.set(LAYERS.ENTIRE_SCENE);
    planetGroup.add(planetMesh);

    // ---- clouds
    const cloudTex = new THREE.CanvasTexture(buildClouds());
    cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping;
    cloudTex.repeat.set(5, 5);
    const layers = [
      { h: CONFIG.cloud1Height, o: CONFIG.cloud1Opacity, s: "cloud1Spin", ry: 0.0, phase: 0.0 },
      { h: CONFIG.cloud2Height, o: CONFIG.cloud2Opacity, s: "cloud2Spin", ry: 2.2, phase: 13.0 },
      { h: CONFIG.cloud3Height, o: CONFIG.cloud3Opacity, s: "cloud3Spin", ry: 4.3, phase: 27.0 },
    ];
    for (const L of layers) {
      const cm = new THREE.MeshStandardMaterial({ map: cloudTex, transparent: true, depthWrite: false });
      cm.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, { uTime: cloudTimeU, noiseScale: { value: 20 }, uSpeedX: { value: 1 }, uSpeedY: { value: 2 }, uSpeedZ: { value: 2 }, uOpacity: cloudOpacity[cloudOpacity.push({ value: L.o }) - 1], uPhase: { value: L.phase } });
        shader.vertexShader = `varying vec2 vCloudUv;\n${shader.vertexShader.replace("void main() {", "void main() {\n  vCloudUv = uv;")}`;
        shader.fragmentShader = `
          uniform float uTime; uniform float noiseScale; uniform float uSpeedX; uniform float uSpeedY; uniform float uSpeedZ; uniform float uOpacity; uniform float uPhase;
          varying vec2 vCloudUv;
          ${SNOISE}
          ${shader.fragmentShader}`.replace(
          "#include <dithering_fragment>",
          `#include <dithering_fragment>
          gl_FragColor.rgb = vec3(1.0);
          float cloudNoise = snoise(vec3(vCloudUv.x * noiseScale + uTime * uSpeedX + uPhase, vCloudUv.y * noiseScale - uTime * uSpeedY + uPhase, uTime * uSpeedZ + uPhase));
          float cloudNdv = max(dot(normalize(vNormal), normalize(vViewPosition)), 0.0);
          float cloudEdge = pow(1.0 - cloudNdv, 3.0);
          float cloudMod = mix(cloudNoise, 1.0, cloudEdge);
          float cloudNdl = dot(normalize(vNormal), normalize(vec3(-0.9, 0.18, 0.4)));
          float cloudDay = 1.0 - smoothstep(0.30, -0.30, cloudNdl) * 0.9;
          gl_FragColor.a *= cloudMod * uOpacity * cloudDay;`,
        );
      };
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(CONFIG.planetRadius * L.h, 64, 64), cm);
      mesh.rotation.y = L.ry;
      mesh.renderOrder = 2;
      mesh.userData.spinKey = L.s;
      mesh.layers.set(LAYERS.ENTIRE_SCENE);
      cloudGroup.add(mesh);
      cloudMeshes.push(mesh);
    }
    cloudGroup.visible = true;

    // ---- golden radar-ping markers on land
    {
      const n = CONFIG.markerCount;
      const pos = new Float32Array(n * 3), seed = new Float32Array(n);
      let k = 0, guard = 0;
      while (k < n && guard++ < 20000) {
        const u = Math.random();
        const v = Math.acos(1 - 2 * Math.random()) / Math.PI; // area-uniform
        const px = Math.min(earth.W - 1, Math.floor(u * earth.W));
        const py = Math.min(earth.H - 1, Math.floor(v * earth.H));
        if (!earth.land[py * earth.W + px]) continue;
        if (Math.abs(0.5 - v) * 2 > 0.8) continue;
        const [dx, dy, dz] = dirFromUV(u, v);
        const r = CONFIG.planetRadius * 1.012;
        pos[k * 3] = dx * r;
        pos[k * 3 + 1] = dy * r;
        pos[k * 3 + 2] = dz * r;
        seed[k] = Math.random();
        k++;
      }
      const mg = new THREE.BufferGeometry();
      mg.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, k * 3), 3));
      mg.setAttribute("seed", new THREE.BufferAttribute(seed.subarray(0, k), 1));
      markerMat = new THREE.ShaderMaterial({
        transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 }, uColor: { value: hexToVec3(CONFIG.markerColor) }, uSize: { value: CONFIG.markerSize }, uSpeed: { value: CONFIG.markerSpeed }, uRes: { value: new THREE.Vector2(w, h) } },
        vertexShader: `
          attribute float seed; uniform float uSize; uniform vec2 uRes;
          varying float vSeed; varying float vFade;
          void main(){
            vSeed = seed;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vec3 vn = normalize(normalMatrix * normalize(position));
            vec3 vd = normalize(-mv.xyz);
            vFade = smoothstep(0.15, 0.5, dot(vn, vd));
            gl_PointSize = max(uSize * uRes.y / 900.0 * (7.0 / max(-mv.z, 1.0)), 2.0);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          uniform vec3 uColor; uniform float uTime; uniform float uSpeed;
          varying float vSeed; varying float vFade;
          void main(){
            if (vFade <= 0.001) discard;
            vec2 p = gl_PointCoord - 0.5;
            float d = length(p) * 2.0;
            if (d > 1.0) discard;
            float core = smoothstep(0.30, 0.0, d) * 1.2;
            float ph = fract(uTime * uSpeed + vSeed);
            float ring = smoothstep(0.07, 0.0, abs(d - ph)) * (1.0 - ph);
            gl_FragColor = vec4(uColor, clamp(core + ring, 0.0, 1.0) * vFade);
          }`,
      });
      const markers = new THREE.Points(mg, markerMat);
      markers.layers.set(LAYERS.ENTIRE_SCENE);
      markers.layers.enable(LAYERS.BLOOM_SCENE);
      planetMesh.add(markers);
    }
    entryActive = !reduceMotion;
    canvas.classList.add("ready");
  }, 30);

  // Handle for tuning from the console; holds no secrets.
  const handle = { renderer, scene, camera, ambient, dir, glowMesh, torusBloom, bloomPass, finalPass, cloudOpacity, atmoMat, starMat, CONFIG, planetMat: null };
  window.__planet = handle;

  // ---- resize
  function resize() {
    const W = window.innerWidth, H = window.innerHeight;
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    renderer.setSize(W, H, false);
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [torusComposer, bloomComposer, finalComposer]) {
      c.setPixelRatio(pr);
      c.setSize(W, H);
    }
    for (const m of [atmoMat, starMat, markerMat]) if (m) m.uniforms.uRes.value.set(W, H);
  }
  window.addEventListener("resize", resize);
  resize();

  // ---- loop
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    planetTime += dt / 12;
    cloudTime += dt / 20;
    starTime += dt;
    markerTime += dt;
    planetTimeU.value = planetTime;
    cloudTimeU.value = cloudTime;
    starMat.uniforms.uTime.value = starTime;
    if (markerMat) markerMat.uniforms.uTime.value = markerTime;

    const max = document.documentElement.scrollHeight - window.innerHeight;
    const pTarget = clamp(max > 0 ? window.scrollY / max : 0, 0, 1);
    curP += (pTarget - curP) * Math.min(1, dt * 4.5);
    const sideScale = clamp(window.innerWidth / 1200, 0.5, 1);
    const k = Math.min(1, dt * 3.2);
    curX += (sample(STOPS_X, curP) * sideScale - curX) * k;
    curY += (sample(STOPS_Y, curP) - curY) * k;
    curS += (sample(STOPS_S, curP) - curS) * k;

    let entryY = 0;
    if (entryActive) {
      entryT = Math.min(ENTRY_DUR, entryT + dt);
      const t = entryT / ENTRY_DUR;
      entryY = Lerp(ENTRY_START_Y, 0, 1 - Math.pow(1 - t, 3));
      if (entryT >= ENTRY_DUR) entryActive = false;
    }
    worldGroup.position.set(curX, curY + entryY, 0);
    worldGroup.scale.setScalar(curS);

    spinPhase += dt * CONFIG.spin;
    planetGroup.rotation.y = CONFIG.initRotation + spinPhase + curP * Math.PI * 1.6;
    for (const c of cloudMeshes) c.rotation.y += dt * CONFIG[c.userData.spinKey];
    glowMesh.quaternion.copy(camera.quaternion);
    controls.update();

    camera.layers.set(LAYERS.TORUS_SCENE);
    torusComposer.render();
    camera.layers.set(LAYERS.BLOOM_SCENE);
    bloomComposer.render();
    camera.layers.set(LAYERS.ENTIRE_SCENE);
    finalComposer.render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

if (canvas) {
  try {
    start();
  } catch (e) {
    console.warn("planet scene unavailable:", e);
    canvas.remove();
  }
}
