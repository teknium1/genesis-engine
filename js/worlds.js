// worlds.js — initial-state generators (presets) and an Orbium-like seed.
// State packing per cell: [mass, energy, genomeMu, genomeSigma].

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Stamp a soft gaussian blob of mass with a given genome at (cx,cy).
function stamp(data, W, H, cx, cy, r, mu, sigma, rand) {
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const d = Math.sqrt(x * x + y * y);
      if (d > r) continue;
      const px = ((cx + x) % W + W) % W;
      const py = ((cy + y) % H + H) % H;
      const i = (py * W + px) * 4;
      const w = Math.exp(-(d * d) / (2 * (r * 0.5) * (r * 0.5)));
      const m = w * (0.6 + 0.4 * (rand ? rand() : 0.5));
      if (m > data[i]) {
        data[i] = Math.min(1, m);
        data[i + 1] = 0.6;                 // energy
        data[i + 2] = mu + (rand ? (rand() - 0.5) * 0.04 : 0);
        data[i + 3] = sigma;
      }
    }
  }
}

export function makeWorld(name, W, H) {
  const data = new Float32Array(W * H * 4);
  const rand = rng(name.length * 7919 + W);

  switch (name) {
    case 'orbium': {
      // A handful of the same species — watch a single-species world.
      for (let k = 0; k < 6; k++) {
        stamp(data, W, H, (rand() * W) | 0, (rand() * H) | 0, 22, 0.13, 0.09, rand);
      }
      break;
    }
    case 'multispecies': {
      // Several genomes seeded apart — a reef that should sort into niches.
      const genomes = [0.06, 0.10, 0.14, 0.18, 0.20];
      for (const g of genomes) {
        for (let k = 0; k < 4; k++) {
          stamp(data, W, H, (rand() * W) | 0, (rand() * H) | 0, 16, g, 0.08 + rand() * 0.05, rand);
        }
      }
      break;
    }
    case 'scarcity': {
      // Sparse matter, low starting energy — metabolism does the selecting.
      for (let k = 0; k < 40; k++) {
        stamp(data, W, H, (rand() * W) | 0, (rand() * H) | 0, 8, 0.06 + rand() * 0.14, 0.09, rand);
      }
      break;
    }
    case 'worms': {
      // Long thin filaments to bias toward worm/replicator dynamics.
      for (let k = 0; k < 8; k++) {
        const cx = (rand() * W) | 0, cy = (rand() * H) | 0;
        const len = 30 + (rand() * 40) | 0;
        const mu = 0.08 + rand() * 0.1;
        const horiz = rand() > 0.5;
        for (let t = 0; t < len; t++) {
          const px = horiz ? cx + t : cx;
          const py = horiz ? cy : cy + t;
          stamp(data, W, H, px, py, 3, mu, 0.09, rand);
        }
      }
      break;
    }
    case 'primordial':
    default: {
      // Correlated noise soup — many random genomes, let abiogenesis happen.
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          // low-frequency mask so it clumps rather than pure static
          const mask =
            0.5 + 0.5 * Math.sin(x * 0.05 + rand() * 0.1) * Math.cos(y * 0.05);
          const r = rand();
          if (r * mask > 0.72) {
            data[i] = 0.4 + rand() * 0.6;
            data[i + 1] = 0.5;
            data[i + 2] = 0.05 + rand() * 0.16;  // genome in the viable band
            data[i + 3] = 0.08 + rand() * 0.06;
          }
        }
      }
      break;
    }
  }
  return data;
}
