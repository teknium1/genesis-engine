// metrics.js — the ASAL-inspired novelty drive and the "worm" detector.
//
// ASAL (Sakana AI, 2024) steers ALife search toward simulations that keep
// producing novelty in a foundation-model feature space. We can't ship a
// vision-language model to a static page, so we ADAPT the idea: compute a
// small, cheap feature vector describing the whole world each measurement,
// and track how much that vector keeps *changing over time*. Sustained change
// = the world is still surprising; a collapse to zero = it has stalled, and we
// raise a "curiosity" signal that the shader uses to perturb the medium.

export class NoveltyDrive {
  constructor(histLen = 180) {
    this.prevFeat = null;
    this.history = new Float32Array(histLen); // recent novelty values for the graph
    this.hi = 0;
    this.smoothed = 0;
    this.curiosity = 0;
    this.stagnantFor = 0;
  }

  // features: [meanMass, massVar, meanEnergy, genomeMean, genomeVar, activity, occupancy]
  static features(rgba, W, H, prevMass) {
    let mSum = 0, mSq = 0, eSum = 0, gSum = 0, gSq = 0, occ = 0, act = 0, n = 0;
    // stride sample for speed
    const stride = 4;
    for (let y = 0; y < H; y += stride) {
      for (let x = 0; x < W; x += stride) {
        const i = (y * W + x) * 4;
        const m = rgba[i], e = rgba[i + 1], g = rgba[i + 2];
        mSum += m; mSq += m * m; eSum += e; gSum += g; gSq += g * g;
        if (m > 0.05) occ++;
        if (prevMass) act += Math.abs(m - prevMass[(y * W + x)]);
        n++;
      }
    }
    const mean = mSum / n;
    return [
      mean,
      Math.max(0, mSq / n - mean * mean),
      eSum / n,
      gSum / n,
      Math.max(0, gSq / n - (gSum / n) * (gSum / n)),
      prevMass ? act / n : 0,
      occ / n,
    ];
  }

  update(feat) {
    let nov = 0;
    if (this.prevFeat) {
      // L2 distance between successive feature vectors = instantaneous novelty
      let s = 0;
      for (let i = 0; i < feat.length; i++) {
        const d = feat[i] - this.prevFeat[i];
        s += d * d;
      }
      nov = Math.sqrt(s);
    }
    this.prevFeat = feat.slice();

    // scale into a friendly 0..1-ish range and smooth
    const scaled = Math.min(1, nov * 6);
    this.smoothed = this.smoothed * 0.9 + scaled * 0.1;

    this.history[this.hi % this.history.length] = this.smoothed;
    this.hi++;

    // Stagnation detection: novelty persistently near zero -> ramp curiosity.
    if (this.smoothed < 0.02) {
      this.stagnantFor++;
    } else {
      this.stagnantFor = Math.max(0, this.stagnantFor - 2);
    }
    const target = this.stagnantFor > 40 ? Math.min(1, (this.stagnantFor - 40) / 120) : 0;
    this.curiosity = this.curiosity * 0.92 + target * 0.08;
    return this.smoothed;
  }

  drawGraph(ctx) {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(20,26,39,0.6)';
    ctx.fillRect(0, 0, w, h);
    const L = this.history.length;
    ctx.beginPath();
    for (let i = 0; i < L; i++) {
      const idx = (this.hi + i) % L;
      const v = this.history[idx];
      const x = (i / (L - 1)) * w;
      const y = h - v * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = this.curiosity > 0.05 ? '#ffb454' : '#55e6c1';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (this.curiosity > 0.05) {
      ctx.fillStyle = 'rgba(255,180,84,0.9)';
      ctx.font = '9px sans-serif';
      ctx.fillText('curiosity firing', 6, 11);
    }
  }
}

// "Be on the lookout for worms." Count connected elongated mass structures at
// low resolution. A worm-like blob = medium mass extent with high aspect ratio.
// This is a coarse heuristic, exactly in the spirit of the video's advice.
export function countWorms(rgba, W, H) {
  const ds = 6;                     // downsample factor
  const w = Math.floor(W / ds), h = Math.floor(H / ds);
  const grid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y * ds) * W + (x * ds)) * 4;
      grid[y * w + x] = rgba[i] > 0.12 ? 1 : 0;
    }
  }
  const seen = new Uint8Array(w * h);
  let worms = 0;
  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!grid[p] || seen[p]) continue;
      // flood fill this component, tracking bbox + size
      let minx = x, maxx = x, miny = y, maxy = y, size = 0;
      stack.length = 0; stack.push(p); seen[p] = 1;
      while (stack.length) {
        const c = stack.pop();
        const cx = c % w, cy = (c / w) | 0;
        size++;
        if (cx < minx) minx = cx; if (cx > maxx) maxx = cx;
        if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
        const nb = [c - 1, c + 1, c - w, c + w];
        for (const q of nb) {
          if (q < 0 || q >= w * h) continue;
          // avoid wrap across row edges for horizontal neighbours
          if ((q === c - 1 && cx === 0) || (q === c + 1 && cx === w - 1)) continue;
          if (grid[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
      }
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
      const extent = Math.max(bw, bh);
      const fill = size / (bw * bh);
      // worm = elongated, medium length, not a solid blob or a dust speck
      if (extent >= 3 && extent <= Math.floor(w * 0.5) && aspect >= 2.2 && fill < 0.7 && size >= 4) {
        worms++;
      }
    }
  }
  return worms;
}
