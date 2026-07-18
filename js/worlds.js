// worlds.js — seed generators. v2 seeds REAL Orbium gliders (a known moving
// Lenia creature) so you see genuine motion + collisions immediately, plus a
// soup option for the honest "watch it self-organize (and often freeze)" case.
// State packing per cell: [mass, energy, genomeMu, genomeSigma].

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

// Stamp the orbium at (cx,cy), optionally rotated by k*90deg, with a genome.
function stampOrbium(data, W, H, cx, cy, mu, sigma, rot) {
  const oh = ORBIUM.length, ow = ORBIUM[0].length;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let v = ORBIUM[y][x];
      if (v <= 0) continue;
      let sx = x, sy = y;
      if (rot === 1) { sx = y; sy = ow - 1 - x; }
      else if (rot === 2) { sx = ow - 1 - x; sy = oh - 1 - y; }
      else if (rot === 3) { sx = oh - 1 - y; sy = x; }
      const px = ((cx + sx) % W + W) % W;
      const py = ((cy + sy) % H + H) % H;
      const i = (py * W + px) * 4;
      data[i] = Math.min(1, v);
      data[i + 1] = 0.8;
      data[i + 2] = mu;
      data[i + 3] = sigma;
    }
  }
}

function stampBlob(data, W, H, cx, cy, r, mu, sigma, rand) {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
    const d = Math.hypot(x, y); if (d > r) continue;
    const px = ((cx + x) % W + W) % W, py = ((cy + y) % H + H) % H;
    const i = (py * W + px) * 4;
    const m = Math.exp(-(d*d)/(2*(r*0.5)*(r*0.5))) * (0.6 + 0.4*rand());
    if (m > data[i]) { data[i] = Math.min(1,m); data[i+1] = 0.7; data[i+2] = mu; data[i+3] = sigma; }
  }
}

export function makeWorld(name, W, H) {
  const data = new Float32Array(W * H * 4);
  const rand = rng(name.length * 7919 + W + Date.now() % 100000);
  const MU = 0.15, SIG = 0.017;

  switch (name) {
    case 'glider': {
      // one clean glider — watch it cruise across the torus
      stampOrbium(data, W, H, (W*0.4)|0, (H*0.4)|0, MU, SIG, 0);
      break;
    }
    case 'garden': {
      // a field of gliders, various headings + slight genome variation
      for (let k = 0; k < 14; k++) {
        stampOrbium(data, W, H, (rand()*W)|0, (rand()*H)|0,
          MU + (rand()-0.5)*0.02, SIG, (rand()*4)|0);
      }
      break;
    }
    case 'collide': {
      // two gliders aimed to meet — collisions are where novelty lives
      stampOrbium(data, W, H, (W*0.25)|0, (H*0.5)|0, MU, SIG, 0);
      stampOrbium(data, W, H, (W*0.6)|0, (H*0.5)|0, MU, SIG, 2);
      stampOrbium(data, W, H, (W*0.5)|0, (H*0.25)|0, MU, SIG, 1);
      break;
    }
    case 'soup': {
      // random soup — the honest case: usually self-organizes then freezes.
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const mask = 0.5 + 0.5*Math.sin(x*0.06 + rand()*0.1)*Math.cos(y*0.06);
        if (rand()*mask > 0.7) {
          const i = (y*W + x)*4;
          data[i] = 0.4 + rand()*0.6; data[i+1] = 0.6;
          data[i+2] = MU + (rand()-0.5)*0.06; data[i+3] = SIG + (rand()-0.5)*0.01;
        }
      }
      break;
    }
    case 'blobs':
    default: {
      // a few soft blobs — some will organize into gliders, some dissolve
      for (let k = 0; k < 10; k++) {
        stampBlob(data, W, H, (rand()*W)|0, (rand()*H)|0, 7 + (rand()*5)|0,
          MU + (rand()-0.5)*0.04, SIG, rand);
      }
      break;
    }
  }
  return data;
}
