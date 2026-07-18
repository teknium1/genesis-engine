// worlds.js — seed generators (v3).
//
// v3 fixes the CORE BUG: at 512x512 the native ~20px Orbium was far too small
// relative to the kernel radius (13) and SHATTERED into confetti instead of
// gliding. We now BILINEAR-UPSCALE the Orbium stamp so a creature spans several
// kernel radii and stays a coherent, translating body.
//
// State packing (TWO textures, MRT):
//   tex0: [mass, creatureEnergy, genomeMu, genomeSigma]
//   tex1: [aggression, freeEnergy(env pool), spare, spare]
//
// makeWorld returns { s0, s1 } two Float32Arrays. Total world energy
// (sum creatureEnergy + sum freeEnergy) is what the conservation model holds.

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Canonical Orbium glider (Bert Chan), native ~20x20 at R=13, mu=0.15, sigma=0.017.
const ORBIUM = [
[0,0,0,0,0,0,0.1,0.14,0.1,0,0,0.03,0.03,0,0,0.3,0,0,0,0],
[0,0,0,0,0,0.08,0.24,0.3,0.3,0.18,0.14,0.15,0.16,0.15,0.09,0.2,0,0,0,0],
[0,0,0,0,0,0.15,0.34,0.44,0.46,0.38,0.18,0.14,0.11,0.13,0.19,0.18,0.45,0,0,0],
[0,0,0,0,0.06,0.13,0.39,0.5,0.5,0.37,0.06,0,0,0,0.02,0.16,0.68,0,0,0],
[0,0,0,0.11,0.17,0.17,0.33,0.4,0.38,0.28,0.14,0,0,0,0,0,0.18,0.42,0,0],
[0,0,0.09,0.18,0.13,0.06,0.08,0.26,0.32,0.32,0.27,0,0,0,0,0,0,0.82,0,0],
[0.27,0,0.16,0.12,0,0,0,0.25,0.38,0.44,0.45,0.34,0,0,0,0,0,0.22,0.17,0],
[0,0.07,0.11,0.11,0,0,0.19,0.57,0.69,0.76,0.76,0.49,0,0,0,0,0,0.4,0.09,0],
[0,0.05,0.09,0.09,0,0.29,0.59,0.86,0.97,1,0.92,0.62,0,0,0,0,0,0.36,0.14,0],
[0,0.05,0.09,0.03,0.16,0.61,0.9,1,1,1,1,0.68,0,0,0,0,0.02,0.36,0.13,0],
[0,0,0.11,0,0.31,0.63,0.9,1,1,1,1,0.75,0.02,0,0,0,0.09,0.36,0.11,0],
[0,0,0.08,0.05,0.32,0.6,0.86,1,1,1,1,0.8,0.07,0,0,0,0.13,0.34,0.05,0],
[0,0,0,0.1,0.29,0.5,0.75,0.94,1,1,1,0.83,0.15,0,0,0.02,0.19,0.3,0,0],
[0,0,0,0.03,0.22,0.42,0.63,0.83,0.96,1,1,0.84,0.24,0.03,0.03,0.11,0.23,0.15,0,0],
[0,0,0,0,0.11,0.31,0.5,0.68,0.83,0.91,0.93,0.79,0.31,0.15,0.15,0.19,0.16,0,0,0],
[0,0,0,0,0,0.15,0.35,0.51,0.63,0.7,0.7,0.6,0.35,0.23,0.21,0.15,0,0,0,0],
[0,0,0,0,0,0,0.16,0.31,0.42,0.48,0.48,0.42,0.29,0.2,0.11,0,0,0,0,0],
[0,0,0,0,0,0,0,0.12,0.22,0.27,0.27,0.23,0.15,0.06,0,0,0,0,0,0],
[0,0,0,0,0,0,0,0,0.06,0.1,0.1,0.07,0,0,0,0,0,0,0,0],
];
const OH = ORBIUM.length, OW = ORBIUM[0].length;

// Bilinear sample of the Orbium field at continuous (fx,fy) in native coords.
function orbiumSample(fx, fy) {
  if (fx < 0 || fy < 0 || fx > OW - 1 || fy > OH - 1) return 0;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(OW - 1, x0 + 1), y1 = Math.min(OH - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const a = ORBIUM[y0][x0], b = ORBIUM[y0][x1];
  const c = ORBIUM[y1][x0], d = ORBIUM[y1][x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

// Stamp an upscaled Orbium centred at (cx,cy). `scale` enlarges the native
// creature; rot is k*90deg. Writes mass/energy/genome to s0, aggression/free to s1.
function stampOrbium(s0, s1, W, H, cx, cy, mu, sigma, rot, scale, aggr, energy) {
  const dw = Math.ceil(OW * scale), dh = Math.ceil(OH * scale);
  const halfW = dw / 2, halfH = dh / 2;
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      // map dest pixel -> native orbium coord
      const nx = dx / scale, ny = dy / scale;
      const v = orbiumSample(nx, ny);
      if (v <= 0.001) continue;
      // rotate the destination offset around centre
      let ox = dx - halfW, oy = dy - halfH, rx = ox, ry = oy;
      if (rot === 1) { rx = -oy; ry = ox; }
      else if (rot === 2) { rx = -ox; ry = -oy; }
      else if (rot === 3) { rx = oy; ry = -ox; }
      const px = ((cx + Math.round(rx)) % W + W) % W;
      const py = ((cy + Math.round(ry)) % H + H) % H;
      const i = (py * W + px) * 4;
      const m = Math.min(1, v);
      if (m > s0[i]) {
        s0[i] = m;
        s0[i + 1] = energy * m;   // creature energy proportional to mass
        s0[i + 2] = mu;
        s0[i + 3] = sigma;
        s1[i] = aggr;             // aggression gene
      }
    }
  }
}

// Total energy budget of a world = sum(creatureEnergy) + sum(freeEnergy).
// We seed a uniform free-energy pool so the pool is auditable and light has
// something bounded to draw from.
function fillFreeEnergy(s1, W, H, perCell) {
  for (let i = 0; i < W * H; i++) s1[i * 4 + 1] = perCell;
}

export function makeWorld(name, W, H, opts) {
  opts = opts || {};
  const radius = opts.radius || 13;
  const s0 = new Float32Array(W * H * 4);
  const s1 = new Float32Array(W * H * 4);
  const rand = rng(name.length * 7919 + W + (opts.seed || (Date.now() % 100000)));
  const MU = 0.15, SIG = 0.017;

  // Orbium is a precise R=13 solution at its native ~20px size. To keep it a
  // COHERENT glider at any radius we scale the stamp with the radius so the
  // body/kernel ratio stays ~native (validated empirically: shatters otherwise).
  const scale = opts.scaleOverride || Math.max(0.9, radius / 13.0);

  // Free-energy pool per cell (uniform). Kept modest so the HUD total is legible.
  const FREE = 0.15;
  fillFreeEnergy(s1, W, H, FREE);

  switch (name) {
    case 'glider': {
      stampOrbium(s0, s1, W, H, (W * 0.35) | 0, (H * 0.5) | 0, MU, SIG, 0, scale, 0.2, 0.8);
      break;
    }
    case 'garden': {
      const n = Math.max(3, Math.round((W * H) / (110 * 110)) * 2);
      for (let k = 0; k < n; k++) {
        stampOrbium(s0, s1, W, H, (rand() * W) | 0, (rand() * H) | 0,
          MU + (rand() - 0.5) * 0.02, SIG, (rand() * 4) | 0, scale,
          0.1 + rand() * 0.4, 0.8);
      }
      break;
    }
    case 'collide': {
      // two DIFFERENT-genome gliders aimed to meet — good for eating demos
      stampOrbium(s0, s1, W, H, (W * 0.28) | 0, (H * 0.5) | 0, MU, SIG, 0, scale, 0.15, 0.8);
      stampOrbium(s0, s1, W, H, (W * 0.68) | 0, (H * 0.5) | 0, MU + 0.03, SIG, 2, scale, 0.55, 0.8);
      break;
    }
    case 'soup': {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const mask = 0.5 + 0.5 * Math.sin(x * 0.06 + rand() * 0.1) * Math.cos(y * 0.06);
        if (rand() * mask > 0.7) {
          const i = (y * W + x) * 4;
          s0[i] = 0.4 + rand() * 0.6; s0[i + 1] = 0.5 * s0[i];
          s0[i + 2] = MU + (rand() - 0.5) * 0.06; s0[i + 3] = SIG + (rand() - 0.5) * 0.01;
          s1[i] = rand();
        }
      }
      break;
    }
    case 'blobs':
    default: {
      const br = Math.max(4, Math.round(radius * 0.9));
      for (let k = 0; k < 8; k++) {
        const cx = (rand() * W) | 0, cy = (rand() * H) | 0;
        const r = br + (rand() * br * 0.6) | 0;
        const mu = MU + (rand() - 0.5) * 0.04, ag = rand();
        for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
          const d = Math.hypot(x, y); if (d > r) continue;
          const px = ((cx + x) % W + W) % W, py = ((cy + y) % H + H) % H;
          const i = (py * W + px) * 4;
          const m = Math.exp(-(d * d) / (2 * (r * 0.5) * (r * 0.5))) * (0.6 + 0.4 * rand());
          if (m > s0[i]) { s0[i] = Math.min(1, m); s0[i + 1] = 0.5 * s0[i]; s0[i + 2] = mu; s0[i + 3] = SIG; s1[i] = ag; }
        }
      }
      break;
    }
  }
  return { s0, s1 };
}
