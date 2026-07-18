// main.js — controller (v2). Lenia base + camera (pan/zoom) + honest curiosity.
import { Engine } from './engine.js';
import { NoveltyDrive, countWorms } from './metrics.js';
import { makeWorld } from './worlds.js';

const REPO_URL = 'https://github.com/teknium1/genesis-engine';
const SIM_W = 512, SIM_H = 512;
const $ = (id) => document.getElementById(id);

const params = {
  preset: 'garden',
  dt: 0.10,
  radius: 13,
  massConserve: true,
  genome: true,
  metabolism: true,
  curiosityOn: false,         // OFF by default now — no more "waves"
  mu: 0.15,
  sigma: 0.017,
  mut: 0.003,
  light: 0.35,
  view: 0,
  time: 0,
  curiosity: 0,
  massScale: 1.0,             // mass-conservation correction ratio (CPU-computed)
  poke: [-1, -1],
  pokeR: 0.045,
  pokeAmt: 0.9,
  pokeErase: false,
};

const cam = { x: 0, y: 0, zoom: 1 };

let engine, novelty, running = true;
let stepCount = 0, readBuf = null, prevMassGrid = null;
let targetMass = null;         // seeded mass budget for conservation
let lastFpsT = performance.now(), frames = 0, fps = 0;
let noveltyCtx = null;

function initEngine() {
  const canvas = $('sim');
  engine = new Engine(canvas, SIM_W, SIM_H);
  if (!engine.ok()) { $('nowebgl').classList.remove('hidden'); return false; }
  novelty = new NoveltyDrive(220);
  readBuf = new Float32Array(SIM_W * SIM_H * 4);
  noveltyCtx = $('novelty-graph').getContext('2d');
  reseed();
  return true;
}

function reseed() {
  const data = makeWorld(params.preset, SIM_W, SIM_H);
  engine.seed(data);
  stepCount = 0; params.time = 0; params.curiosity = 0; params.massScale = 1.0;
  prevMassGrid = null; targetMass = null;
  if (novelty) { novelty.prevFeat = null; novelty.stagnantFor = 0; novelty.curiosity = 0; }
}

function resizeCanvas() {
  const canvas = $('sim');
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
}

const METRIC_EVERY = 6;
function sampleMetrics() {
  engine.readback(readBuf);
  const feat = NoveltyDrive.features(readBuf, SIM_W, SIM_H, prevMassGrid);
  const nov = novelty.update(feat);
  params.curiosity = params.curiosityOn ? novelty.curiosity : 0;

  if (!prevMassGrid) prevMassGrid = new Float32Array(SIM_W * SIM_H);

  // total mass for conservation ratio
  let total = 0;
  for (let i = 0; i < SIM_W * SIM_H; i++) { total += readBuf[i * 4]; prevMassGrid[i] = readBuf[i * 4]; }
  if (targetMass === null && total > 1) targetMass = total;   // lock budget after first real sample
  if (params.massConserve && targetMass && total > 1) {
    // gentle correction, clamped so it never yanks hard
    params.massScale = Math.min(1.05, Math.max(0.95, targetMass / total));
  } else {
    params.massScale = 1.0;
  }

  const meanMass = feat[0], meanEnergy = feat[2];
  const worms = countWorms(readBuf, SIM_W, SIM_H);
  const bins = new Array(12).fill(0); let occ = 0;
  for (let i = 0; i < SIM_W * SIM_H; i += 5) {
    const m = readBuf[i * 4];
    if (m > 0.1) { occ++; bins[Math.min(11, Math.max(0, ((readBuf[i * 4 + 2] - 0.05) / 0.30 * 12) | 0))]++; }
  }
  const species = Math.max(1, bins.filter((b) => b > occ * 0.03).length);

  $('hud-mass').textContent = meanMass.toFixed(3);
  $('hud-energy').textContent = meanEnergy.toFixed(3);
  $('hud-species').textContent = occ > 0 ? String(species) : '0';
  $('hud-worms').textContent = String(worms);
  $('novelty-num').textContent = nov.toFixed(2);
  novelty.drawGraph(noveltyCtx);
}

function loop() {
  requestAnimationFrame(loop);
  frames++;
  const now = performance.now();
  if (now - lastFpsT > 500) {
    fps = Math.round((frames * 1000) / (now - lastFpsT));
    frames = 0; lastFpsT = now; $('hud-fps').textContent = String(fps);
  }
  if (running) {
    for (let k = 0; k < 2; k++) {
      params.time += params.dt;
      engine.step(params);
      stepCount++;
      if (params.poke[0] >= 0) params.poke = [-1, -1];
    }
    if (stepCount % METRIC_EVERY === 0) sampleMetrics();
  }
  engine.render(params.view, cam);
  $('hud-step').textContent = String(stepCount);
}

function bindUI() {
  $('btn-play').addEventListener('click', togglePlay);
  $('btn-reset').addEventListener('click', reseed);
  $('btn-help').addEventListener('click', () => $('help-modal').classList.remove('hidden'));
  $('help-close').addEventListener('click', () => $('help-modal').classList.add('hidden'));
  $('help-modal').addEventListener('click', (e) => { if (e.target.id === 'help-modal') $('help-modal').classList.add('hidden'); });
  $('btn-recenter').addEventListener('click', () => { cam.x = 0; cam.y = 0; cam.zoom = 1; });

  $('ctl-preset').addEventListener('change', (e) => { params.preset = e.target.value; reseed(); });

  bindSlider('ctl-dt', 'v-dt', 'dt', (v) => v.toFixed(2));
  bindSlider('ctl-radius', 'v-radius', 'radius', (v) => String(v | 0));
  bindSlider('ctl-mu', 'v-mu', 'mu', (v) => v.toFixed(3));
  bindSlider('ctl-sigma', 'v-sigma', 'sigma', (v) => v.toFixed(3));
  bindSlider('ctl-mut', 'v-mut', 'mut', (v) => v.toFixed(3));
  bindSlider('ctl-light', 'v-light', 'light', (v) => v.toFixed(2));

  bindToggle('ctl-mass', 'massConserve');
  bindToggle('ctl-genome', 'genome');
  bindToggle('ctl-metabolism', 'metabolism');
  bindToggle('ctl-curiosity', 'curiosityOn');

  $('ctl-view').addEventListener('change', (e) => {
    params.view = { species: 0, mass: 1, energy: 2, potential: 3 }[e.target.value];
  });

  $('btn-snap').addEventListener('click', snapshot);
  $('btn-share').addEventListener('click', shareLink);
  const rl = $('repo-link'); if (rl) rl.href = REPO_URL;

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'r' || e.key === 'R') reseed();
  });

  bindCanvasGestures();
  window.addEventListener('resize', resizeCanvas);
}

// ---- camera + gesture handling ----
function bindCanvasGestures() {
  const canvas = $('sim');
  let mode = null;         // 'pan' | 'poke'
  let last = null;

  const eventUV = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width;
    const py = 1 - (ev.clientY - rect.top) / rect.height;
    // invert the render camera transform to get world-UV under the cursor
    const wx = (px - 0.5) / cam.zoom + 0.5 + cam.x;
    const wy = (py - 0.5) / cam.zoom + 0.5 + cam.y;
    return [((wx % 1) + 1) % 1, ((wy % 1) + 1) % 1, px, py];
  };

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    if (ev.shiftKey || ev.altKey) {
      mode = 'poke';
      params.pokeErase = ev.altKey;
      const [wx, wy] = eventUV(ev);
      params.poke = [wx, wy];
    } else {
      mode = 'pan';
      const rect = canvas.getBoundingClientRect();
      last = [ev.clientX / rect.width, ev.clientY / rect.height];
    }
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (mode === 'poke') {
      const [wx, wy] = eventUV(ev);
      params.poke = [wx, wy];
    } else if (mode === 'pan') {
      const rect = canvas.getBoundingClientRect();
      const nx = ev.clientX / rect.width, ny = ev.clientY / rect.height;
      cam.x -= (nx - last[0]) / cam.zoom;
      cam.y += (ny - last[1]) / cam.zoom;   // y flipped
      last = [nx, ny];
    }
  });

  const end = () => { mode = null; last = null; params.pokeErase = false; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const [, , px, py] = eventUV(ev);
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newZoom = Math.min(20, Math.max(1, cam.zoom * factor));
    // zoom toward cursor: keep world point under cursor fixed
    const wpx = (px - 0.5) / cam.zoom + 0.5 + cam.x;
    const wpy = (py - 0.5) / cam.zoom + 0.5 + cam.y;
    cam.zoom = newZoom;
    cam.x = wpx - (px - 0.5) / cam.zoom - 0.5;
    cam.y = wpy - (py - 0.5) / cam.zoom - 0.5;
  }, { passive: false });
}

function bindSlider(inputId, labelId, key, fmt) {
  const el = $(inputId), lbl = $(labelId);
  const apply = () => { params[key] = parseFloat(el.value); lbl.textContent = fmt(params[key]); };
  el.addEventListener('input', apply); apply();
}
function bindToggle(inputId, key) {
  const el = $(inputId);
  el.addEventListener('change', () => { params[key] = el.checked; });
  params[key] = el.checked;
}

function togglePlay() {
  running = !running;
  $('btn-play').innerHTML = running ? '&#10073;&#10073; Pause' : '&#9654; Play';
}

function snapshot() {
  const a = document.createElement('a');
  a.download = `genesis-${params.preset}-${stepCount}.png`;
  a.href = $('sim').toDataURL('image/png'); a.click();
}

function shareLink() {
  const q = new URLSearchParams({
    p: params.preset, dt: params.dt, r: params.radius, mu: params.mu, sg: params.sigma,
    mut: params.mut, li: params.light,
    mc: params.massConserve ? 1 : 0, gn: params.genome ? 1 : 0,
    mb: params.metabolism ? 1 : 0, cu: params.curiosityOn ? 1 : 0, v: params.view,
  });
  const url = `${location.origin}${location.pathname}?${q.toString()}`;
  navigator.clipboard?.writeText(url).then(
    () => flashButton($('btn-share'), 'Copied!'),
    () => flashButton($('btn-share'), 'Copy failed')
  );
}
function flashButton(btn, txt) {
  const old = btn.innerHTML; btn.textContent = txt;
  setTimeout(() => { btn.innerHTML = old; }, 1400);
}

function loadFromURL() {
  const q = new URLSearchParams(location.search);
  if (![...q.keys()].length) return;
  const num = (id, lbl, key, val, fmt) => {
    if (val != null && !Number.isNaN(parseFloat(val))) {
      $(id).value = val; params[key] = parseFloat(val); if (lbl) $(lbl).textContent = fmt(params[key]);
    }
  };
  const chk = (id, key, val) => { if (val != null) { const b = val === '1'; $(id).checked = b; params[key] = b; } };
  if (q.get('p')) { $('ctl-preset').value = q.get('p'); params.preset = q.get('p'); }
  num('ctl-dt', 'v-dt', 'dt', q.get('dt'), (v) => v.toFixed(2));
  num('ctl-radius', 'v-radius', 'radius', q.get('r'), (v) => String(v | 0));
  num('ctl-mu', 'v-mu', 'mu', q.get('mu'), (v) => v.toFixed(3));
  num('ctl-sigma', 'v-sigma', 'sigma', q.get('sg'), (v) => v.toFixed(3));
  num('ctl-mut', 'v-mut', 'mut', q.get('mut'), (v) => v.toFixed(3));
  num('ctl-light', 'v-light', 'light', q.get('li'), (v) => v.toFixed(2));
  chk('ctl-mass', 'massConserve', q.get('mc'));
  chk('ctl-genome', 'genome', q.get('gn'));
  chk('ctl-metabolism', 'metabolism', q.get('mb'));
  chk('ctl-curiosity', 'curiosityOn', q.get('cu'));
  if (q.get('v')) { params.view = parseInt(q.get('v'), 10) || 0; $('ctl-view').value = ['species','mass','energy','potential'][params.view]; }
}

function boot() {
  bindUI();
  loadFromURL();
  if (!initEngine()) return;
  resizeCanvas();
  if (!localStorage.getItem('ge-seen2')) {
    $('help-modal').classList.remove('hidden');
    localStorage.setItem('ge-seen2', '1');
  }
  loop();
}
boot();
