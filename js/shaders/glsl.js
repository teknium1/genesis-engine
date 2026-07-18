// glsl.js — shared shader source strings for the Genesis Engine.
// The whole simulation lives on the GPU. State is packed into RGBA float textures
// and advanced with ping-pong fragment shader passes.
//
// State texture channels (per cell):
//   R = mass      (the "stuff" a creature is made of; conserved when mass-conservation is on)
//   G = energy    (metabolic charge; produced from the light field, spent on upkeep + growth)
//   B = genome μ  (LOCAL growth-kernel center — the embedded, evolvable "gene")
//   A = genome σ  (LOCAL growth-kernel width  — the second embedded gene)
//
// μ and σ ride WITH the mass during advection (parameter localization), which is what
// lets many species coexist in one world and lets the genome mutate intrinsically.

export const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main(){
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// PASS 1 — potential + flow.
// Convolves mass with a smooth ring kernel to get a Lenia-style potential U,
// then converts the *local-genome* growth response into an affinity field A.
// The gradient of A defines the flow direction (Flow-Lenia: matter flows uphill
// in affinity instead of teleporting via a growth term).
// Output RG = flow vector, B = growth response, A = local mass (passthrough).
// ---------------------------------------------------------------------------
export const FLOW_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;

uniform sampler2D uState;
uniform vec2  uTexel;     // 1/resolution
uniform float uRadius;    // kernel radius in cells
uniform float uTime;

const float PI = 3.14159265359;

// smooth bump centered at 0.5, used for both the ring kernel and growth fn
float bump(float x, float m, float s){
  float d = (x - m) / s;
  return exp(-0.5 * d * d);
}

void main(){
  float R = uRadius;
  int   Ri = int(R);
  float sum = 0.0;   // kernel-weighted neighbour mass  -> potential
  float wsum = 0.0;

  // Ring kernel: a shell peaking at ~0.5R. Sampled sparsely for speed.
  for(int dy=-24; dy<=24; dy++){
    if(dy > Ri || dy < -Ri) continue;
    for(int dx=-24; dx<=24; dx++){
      if(dx > Ri || dx < -Ri) continue;
      float r = length(vec2(float(dx), float(dy))) / R;
      if(r > 1.0) continue;
      // kernel shell weight (Lenia-style single ring)
      float k = bump(r, 0.5, 0.15);
      vec2 uv = vUV + vec2(float(dx), float(dy)) * uTexel;
      float m = texture(uState, uv).r;
      sum  += k * m;
      wsum += k;
    }
  }
  float U = (wsum > 0.0) ? sum / wsum : 0.0;   // normalized potential [0,1]-ish

  // Local genome decides how this cell "wants" to grow given the potential U.
  vec4 s = texture(uState, vUV);
  float mu    = s.b;               // genome center
  float sigma = max(0.02, s.a);    // genome width
  // Growth/affinity response: high where U matches this genome's preferred density.
  float growth = 2.0 * bump(U, mu, sigma) - 1.0;   // in [-1, 1]

  // Affinity field for flow = a scalar we can take the gradient of.
  // We approximate grad(affinity) by sampling neighbour potentials.
  float uL = 0.0, uR = 0.0, uD = 0.0, uT = 0.0;
  {
    // cheap 1-cell finite difference of the growth-weighted potential
    vec2 e = uTexel * max(1.0, R*0.25);
    float muL = texture(uState, vUV - vec2(e.x,0)).b;
    float sgL = max(0.02, texture(uState, vUV - vec2(e.x,0)).a);
    float muR = texture(uState, vUV + vec2(e.x,0)).b;
    float sgR = max(0.02, texture(uState, vUV + vec2(e.x,0)).a);
    float muD = texture(uState, vUV - vec2(0,e.y)).b;
    float sgD = max(0.02, texture(uState, vUV - vec2(0,e.y)).a);
    float muT = texture(uState, vUV + vec2(0,e.y)).b;
    float sgT = max(0.02, texture(uState, vUV + vec2(0,e.y)).a);
    // sample potential at neighbours (reuse U as local approx of neighbour U;
    // gradient dominated by genome preference differences -> drives sorting)
    uL = bump(U, muL, sgL);
    uR = bump(U, muR, sgR);
    uD = bump(U, muD, sgD);
    uT = bump(U, muT, sgT);
  }
  vec2 flow = vec2(uR - uL, uT - uD);   // points toward higher affinity

  outColor = vec4(flow, growth, s.r);
}`;

// ---------------------------------------------------------------------------
// PASS 2 — integrate. Advects mass + genome along the flow field with
// (optional) mass conservation, applies the metabolic energy economy, and
// mutates the local genome. This is where evolution actually happens.
// ---------------------------------------------------------------------------
export const STEP_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;

uniform sampler2D uState;   // previous full state (RGBA as documented above)
uniform sampler2D uFlow;    // pass-1 output: RG flow, B growth, A mass
uniform vec2  uTexel;
uniform float uDt;
uniform float uFlowK;       // flow strength
uniform float uMut;         // mutation rate
uniform float uLight;       // light influx
uniform float uMassConserve;// 1 = conserve, 0 = classic growth
uniform float uMetabolism;  // 1 = energy economy on
uniform float uGenome;      // 1 = evolvable local genome on
uniform float uCuriosity;   // curiosity perturbation strength (0..1), set by CPU
uniform float uTime;
uniform vec2  uPoke;        // pointer position in UV (or <0 if none)
uniform float uPokeR;       // poke radius
uniform float uPokeAmt;     // poke amount

// hash noise for mutation + curiosity
float hash(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main(){
  vec4 s = texture(uState, vUV);
  vec4 f = texture(uFlow, vUV);
  float mass = s.r;
  float energy = s.g;
  float mu = s.b;
  float sigma = s.a;
  float growth = f.b;

  // ---- MASS UPDATE ----
  // Local, self-sustaining growth response driven by THIS cell's genome.
  // sigma is floored so a fresh genome always has a workable growth band.
  float sig = max(0.08, sigma);
  float localGrowth = growth;               // from pass 1 (already 2*bump-1)
  float growthK = 0.5;                       // validated: keeps worlds alive, not exploding

  float newMass;
  if(uMassConserve > 0.5){
    // Semi-Lagrangian advection: pull matter (and its genome) from upstream so
    // total mass is (approximately) conserved instead of minted by a growth term.
    vec2 vel = f.rg * uFlowK;
    vec2 src = vUV - vel * uTexel * 6.0 * uDt;
    vec4 back = texture(uState, src);
    vec4 bf   = texture(uFlow, src);
    // advected mass, gently reshaped by the local growth response
    newMass = back.r + uDt * growthK * back.r * bf.b;
    mu    = mix(mu,    back.b, 0.9);   // genome rides with the matter
    sigma = mix(sig,   back.a, 0.9);
  } else {
    // Classic Lenia-style additive growth (can create/destroy mass -> stalls).
    newMass = mass + uDt * growthK * mass * localGrowth;
  }

  // ---- METABOLISM ----
  if(uMetabolism > 0.5){
    // A vertical light gradient: more light near the top. Mass photosynthesizes.
    float light = uLight * (0.5 + 0.5 * (1.0 - vUV.y));
    float produced = light * mass * uDt;
    float upkeep   = 0.012 * mass * uDt;         // it costs energy to exist
    energy += produced - upkeep;
    // Starvation: no energy -> structure decays. Surplus -> can grow.
    if(energy < 0.0){ newMass += energy * 0.5; energy = 0.0; }
    energy = clamp(energy, 0.0, 2.0);
    newMass += 0.09 * uDt * min(energy, newMass); // invest surplus into mass
  }

  newMass = clamp(newMass, 0.0, 1.0);

  // ---- GENOME MUTATION (only where there is living matter) ----
  if(uGenome > 0.5 && newMass > 0.02){
    float n1 = hash(vUV * 997.0 + uTime) - 0.5;
    float n2 = hash(vUV * 631.0 - uTime) - 0.5;
    mu    = clamp(mu    + uMut * n1, 0.05, 0.95);
    sigma = clamp(sigma + uMut * n2 * 0.5, 0.06, 0.30);
  }
  // Seed a genome into freshly-born matter that had none.
  // Range 0.05-0.20 matches the achievable potential of localized patterns
  // (validated offline: seeds outside this band decay to a dead world).
  if(newMass > 0.02 && (mu <= 0.001)){
    mu = 0.05 + 0.15 * hash(vUV * 71.0 + uTime);
    sigma = 0.08 + 0.06 * hash(vUV * 37.0 - uTime);
  }

  // ---- CURIOSITY / NOVELTY DRIVE ----
  // When the CPU detects stagnation it raises uCuriosity; we inject sparse
  // matter + fresh genomes to knock the world out of a boring attractor.
  if(uCuriosity > 0.001){
    float spark = hash(vUV * 311.0 + uTime * 1.7);
    if(spark > 1.0 - 0.02 * uCuriosity){
      newMass = max(newMass, 0.4 + 0.4 * spark);
      mu = 0.1 + 0.7 * hash(vUV * 53.0 + uTime);
      sigma = 0.04 + 0.12 * hash(vUV * 29.0 - uTime);
      energy = max(energy, 0.6);
    }
  }

  // ---- POINTER POKE ----
  if(uPoke.x >= 0.0){
    float d = distance(vUV, uPoke);
    if(d < uPokeR){
      float w = 1.0 - d / uPokeR;
      newMass = clamp(newMass + uPokeAmt * w, 0.0, 1.0);
      if(mu <= 0.001){ mu = 0.12; sigma = 0.09; }
      energy = max(energy, 0.5 * w);
    }
  }

  outColor = vec4(newMass, energy, mu, sigma);
}`;

// ---------------------------------------------------------------------------
// RENDER — map state to screen colors according to the chosen view mode.
// ---------------------------------------------------------------------------
export const RENDER_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;

uniform sampler2D uState;
uniform sampler2D uFlow;
uniform int uView;   // 0 species, 1 mass, 2 energy, 3 flow

// map a hue [0,1] to rgb
vec3 hsv(float h, float s, float v){
  vec3 c = vec3(h, s, v);
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main(){
  vec4 s = texture(uState, vUV);
  float mass = s.r;
  vec3 col;

  if(uView == 0){
    // Species = hue from genome μ, brightness from mass, saturation from σ.
    float hue = fract(0.55 + s.b * 1.3);
    col = hsv(hue, clamp(0.35 + s.a * 2.2, 0.3, 1.0), pow(mass, 0.7));
  } else if(uView == 1){
    col = vec3(pow(mass, 0.6)) * vec3(0.6, 0.95, 0.85);
  } else if(uView == 2){
    float e = s.g / 2.0;
    col = mix(vec3(0.05,0.06,0.12), vec3(1.0, 0.72, 0.3), e) * (0.3 + 0.7*mass);
  } else {
    vec2 flow = texture(uFlow, vUV).rg;
    float ang = atan(flow.y, flow.x) / 6.2831853 + 0.5;
    float mag = clamp(length(flow) * 6.0, 0.0, 1.0);
    col = hsv(ang, 0.8, mag) * (0.2 + 0.8*mass);
  }

  // subtle vignette
  vec2 d = vUV - 0.5;
  col *= 1.0 - 0.35 * dot(d, d);
  outColor = vec4(col, 1.0);
}`;
