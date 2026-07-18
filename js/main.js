// main.js — the controller. Wires the UI to the engine, runs the loop,
// samples metrics on a cadence, and handles poke / snapshot / share / URL state.
import { Engine } from './engine.js';
import { NoveltyDrive, countWorms } from './metrics.js';
import { makeWorld } from './worlds.js';

const REPO_URL = 'https://github.com/teknium1/genesis-engine';
const SIM_W = 512, SIM_H = 512;

const $ = (id) => document.getElementById(id);

// ---- state ----
const params = {
  preset: 'primordial',
  dt: 0.10,
  radius: 13,
  massConserve: true,
  genome: true,
  metabolism: true,
  curiosityOn: true,
  mut: 0.006,
  flow: 2.6,
  light: 0.35,
  view: 0,
  // runtime
  time: 0,
  curiosity: 0,
  poke: [-1, -1],
  pokeR: 0.05,
  pokeAmt: 0.6,
};

let engine, novelty, running = true;
let stepCount = 0;
let readBuf = null;
let prevMassGrid = null;
let lastFpsT = performance.now(), frames = 0, fps = 0;
let noveltyCtx = null;

function initEngine() {
  const canvas = $('sim');
  engine = new Engine(canvas, SIM_W, SIM_H);
  if (!engine.ok()) {
    $('nowebgl').classList.remove('hidden');
    return false;
  }
  novelty = new NoveltyDrive(220);
  readBuf = new Float32Array(SIM_W * SIM_H * 4);
  noveltyCtx = $('novelty-graph').getContext('2d');
  reseed();
  return true;
}

function reseed() {
  const data = makeWorld(params.preset, SIM_W, SIM_H);
  engine.seed(data);
  stepCount = 0;
  params.time = 0;
  params.curiosity = 0;
  prevMassGrid = null;
  if (novelty) { novelty.prevFeat = null; novelty.stagnantFor = 0; novelty.curiosity = 0; }
}

function resizeCanvas() {
  const canvas = $('sim');
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
}

// ---- metrics cadence: sample every N steps (readback is the expensive part) ----
const METRIC_EVERY = 6;
function sampleMetrics() {
  engine.readback(readBuf);

  // build a coarse mass grid for the "activity" term + worm detection
  const feat = NoveltyDrive.features(readBuf, SIM_W, SIM_H, prevMassGrid);
  const nov = novelty.update(feat);
  params.curiosity = params.curiosityOn ? novelty.curiosity : 0;

  // update prevMassGrid (strided to match features stride of 4)
  if (!prevMassGrid) prevMassGrid = new Float32Array(SIM_W * SIM_H);
  for (let i = 0; i < SIM_W * SIM_H; i++) prevMassGrid[i] = readBuf[i * 4];

  // HUD numbers
  const meanMass = feat[0], meanEnergy = feat[2];
  const worms = countWorms(readBuf, SIM_W, SIM_H);
  // crude species count: histogram of genome mu over occupied cells
  const bins = new Array(12).fill(0);
  let occ = 0;
  for (let i = 0; i < SIM_W * SIM_H; i += 5) {
    const m = readBuf[i * 4];
    if (m > 0.1) { occ++; bins[Math.min(11, (readBuf[i * 4 + 2] * 12) | 0)]++; }
  }
  const species = bins.filter((b) => b > occ * 0.02).length;

  $('hud-mass').textContent = meanMass.toFixed(3);
  $('hud-energy').textContent = meanEnergy.toFixed(3);
  $('hud-species').textContent = String(species);
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
    frames = 0; lastFpsT = now;
    $('hud-fps').textContent = String(fps);
  }

  if (running) {
    // a couple of sim steps per frame for livelier dynamics
    for (let k = 0; k < 2; k++) {
      params.time += params.dt;
      engine.step(params);
      stepCount++;
      // clear one-shot poke after first application
      if (params.poke[0] >= 0) params.poke = [-1, -1];
    }
    if (stepCount % METRIC_EVERY === 0) sampleMetrics();
  }
  engine.render(params.view);
  $('hud-step').textContent = String(stepCount);
}

// ---- UI wiring ----
function bindUI() {
  $('btn-play').addEventListener('click', togglePlay);
  $('btn-reset').addEventListener('click', reseed);
  $('btn-help').addEventListener('click', () => $('help-modal').classList.remove('hidden'));
  $('help-close').addEventListener('click', () => $('help-modal').classList.add('hidden'));
  $('help-modal').addEventListener('click', (e) => { if (e.target.id === 'help-modal') $('help-modal').classList.add('hidden'); });

  $('ctl-preset').addEventListener('change', (e) => { params.preset = e.target.value; reseed(); });

  bindSlider('ctl-dt', 'v-dt', 'dt', (v) => v.toFixed(2));
  bindSlider('ctl-radius', 'v-radius', 'radius', (v) => String(v | 0));
  bindSlider('ctl-mut', 'v-mut', 'mut', (v) => v.toFixed(3));
  bindSlider('ctl-flow', 'v-flow', 'flow', (v) => v.toFixed(1));
  bindSlider('ctl-light', 'v-light', 'light', (v) => v.toFixed(2));

  bindToggle('ctl-mass', 'massConserve');
  bindToggle('ctl-genome', 'genome');
  bindToggle('ctl-metabolism', 'metabolism');
  bindToggle('ctl-curiosity', 'curiosityOn');

  $('ctl-view').addEventListener('change', (e) => {
    params.view = { species: 0, mass: 1, energy: 2, flow: 3 }[e.target.value];
  });

  $('btn-snap').addEventListener('click', snapshot);
  $('btn-share').addEventListener('click', shareLink);
  const rl = $('repo-link'); if (rl) rl.href = REPO_URL;

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'r' || e.key === 'R') reseed();
  });

  // pointer poke
  const canvas = $('sim');
  let dragging = false;
  const toUV = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    const cy = (ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top;
    return [cx / rect.width, 1 - cy / rect.height];
  };
  const poke = (ev) => { params.poke = toUV(ev); };
  canvas.addEventListener('pointerdown', (e) => { dragging = true; poke(e); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) poke(e); });
  window.addEventListener('pointerup', () => { dragging = false; });

  window.addEventListener('resize', resizeCanvas);
}

function bindSlider(inputId, labelId, key, fmt) {
  const el = $(inputId), lbl = $(labelId);
  const apply = () => {
    params[key] = parseFloat(el.value);
    lbl.textContent = fmt(params[key]);
  };
  el.addEventListener('input', apply);
  apply();
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
  const canvas = $('sim');
  const a = document.createElement('a');
  a.download = `genesis-${params.preset}-${stepCount}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
}

// Encode the current knobs in the URL so a world is shareable.
function shareLink() {
  const q = new URLSearchParams({
    p: params.preset,
    dt: params.dt, r: params.radius, mut: params.mut,
    fl: params.flow, li: params.light,
    mc: params.massConserve ? 1 : 0, gn: params.genome ? 1 : 0,
    mb: params.metabolism ? 1 : 0, cu: params.curiosityOn ? 1 : 0,
    v: params.view,
  });
  const url = `${location.origin}${location.pathname}?${q.toString()}`;
  navigator.clipboard?.writeText(url).then(
    () => flashButton($('btn-share'), 'Copied!'),
    () => flashButton($('btn-share'), url.slice(0, 24) + '...')
  );
}
function flashButton(btn, txt) {
  const old = btn.innerHTML; btn.textContent = txt;
  setTimeout(() => { btn.innerHTML = old; }, 1400);
}

// Load knobs from URL (?p=...&dt=...) if present.
function loadFromURL() {
  const q = new URLSearchParams(location.search);
  if (![...q.keys()].length) return;
  const setSel = (id, val, key) => { if (val != null) { $(id).value = val; params[key] = val; } };
  const setNum = (id, lbl, key, val, fmt) => {
    if (val != null && !Number.isNaN(parseFloat(val))) {
      $(id).value = val; params[key] = parseFloat(val);
      if (lbl) $(lbl).textContent = fmt(params[key]);
    }
  };
  const setChk = (id, key, val) => { if (val != null) { const b = val === '1'; $(id).checked = b; params[key] = b; } };

  if (q.get('p')) { $('ctl-preset').value = q.get('p'); params.preset = q.get('p'); }
  setNum('ctl-dt', 'v-dt', 'dt', q.get('dt'), (v) => v.toFixed(2));
  setNum('ctl-radius', 'v-radius', 'radius', q.get('r'), (v) => String(v | 0));
  setNum('ctl-mut', 'v-mut', 'mut', q.get('mut'), (v) => v.toFixed(3));
  setNum('ctl-flow', 'v-flow', 'flow', q.get('fl'), (v) => v.toFixed(1));
  setNum('ctl-light', 'v-light', 'light', q.get('li'), (v) => v.toFixed(2));
  setChk('ctl-mass', 'massConserve', q.get('mc'));
  setChk('ctl-genome', 'genome', q.get('gn'));
  setChk('ctl-metabolism', 'metabolism', q.get('mb'));
  setChk('ctl-curiosity', 'curiosityOn', q.get('cu'));
  if (q.get('v')) { params.view = parseInt(q.get('v'), 10) || 0; $('ctl-view').value = ['species','mass','energy','flow'][params.view]; }
}

// ---- boot ----
function boot() {
  bindUI();
  loadFromURL();
  if (!initEngine()) return;
  resizeCanvas();
  // show help on first visit
  if (!localStorage.getItem('ge-seen')) {
    $('help-modal').classList.remove('hidden');
    localStorage.setItem('ge-seen', '1');
  }
  loop();
}

boot();
