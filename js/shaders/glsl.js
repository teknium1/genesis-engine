// glsl.js — shader sources for the Genesis Engine (v3).
//
// v3 rebuild goals:
//   (A) creatures TRANSLATE (coherent Lenia gliders, seeded large enough)
//   (B) energy is CONSERVED (finite world budget: creatureEnergy + freeEnergy)
//   (C) eating = symmetric energy TRANSFER between different-genome neighbours
//   (D) light is UNIFORM by default (no hidden unreachable "top")
//   (E) defaults look ALIVE (dampening modulators off by default in main.js)
//
// TWO state textures (WebGL2 MRT / gl.drawBuffers):
//   tex0: R=mass  G=creatureEnergy  B=genomeMu  A=genomeSigma
//   tex1: R=aggression(gene)  G=freeEnergy(env pool)  B=spare  A=spare
//
// Energy bookkeeping is per-cell and strictly local so it conserves exactly:
//   * photosynthesis moves min(want, freeEnergy) from free -> creature
//   * upkeep + death move creature energy back to free
//   * eating moves creature energy between two touching different-genome cells;
//     both cells compute the SAME transfer from the shared neighbourhood read,
//     so what one loses the other gains (optional small loss returned to free).

export const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main(){
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// PASS 1 — potential U = mass convolved with a Lenia ring kernel.
// ---------------------------------------------------------------------------
export const POTENTIAL_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uState;   // tex0
uniform vec2  uTexel;
uniform float uRadius;

float bump(float x, float m, float s){
  float d = (x - m) / s;
  return exp(-0.5 * d * d);
}

void main(){
  float R = uRadius;
  int Ri = int(R);
  float sum = 0.0, wsum = 0.0;
  for(int dy=-30; dy<=30; dy++){
    if(dy > Ri || dy < -Ri) continue;
    for(int dx=-30; dx<=30; dx++){
      if(dx > Ri || dx < -Ri) continue;
      float r = length(vec2(float(dx), float(dy))) / R;
      if(r > 1.0) continue;
      float k = bump(r, 0.5, 0.15);
      float m = texture(uState, vUV + vec2(float(dx), float(dy)) * uTexel).r;
      sum += k * m; wsum += k;
    }
  }
  float U = (wsum > 0.0) ? sum / wsum : 0.0;
  outColor = vec4(U, texture(uState, vUV).r, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// PASS 2 — Lenia growth update + conserved energy + eating (MRT: writes tex0,tex1)
// ---------------------------------------------------------------------------
export const STEP_FS = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location=0) out vec4 out0;   // mass, creatureEnergy, mu, sigma
layout(location=1) out vec4 out1;   // aggression, freeEnergy, spare, spare

uniform sampler2D uState;   // tex0
uniform sampler2D uAux;     // tex1
uniform sampler2D uPot;     // R=U
uniform vec2  uTexel;
uniform float uDt;
uniform float uMuBase;
uniform float uSigBase;
uniform float uMut;
uniform float uLight;        // photosynthesis rate
uniform float uGenome;       // 1 = use/evolve local mu/sigma
uniform float uMetabolism;   // 1 = energy economy on
uniform float uEat;          // 1 = eating (energy transfer) on
uniform float uPredPayoff;   // 0..1 how much eating pays the aggressor
uniform float uMassConserve; // 1 = renormalize toward target mass
uniform float uMassScale;    // CPU-supplied target/current ratio
uniform float uCuriosity;
uniform float uTime;
uniform vec2  uPoke;
uniform float uPokeR;
uniform float uPokeAmt;
uniform float uPokeErase;

float bump(float x, float m, float s){ float d=(x-m)/s; return exp(-0.5*d*d); }
float hash(vec2 p){
  p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32);
  return fract(p.x*p.y);
}

// Symmetric per-edge eating transfer between THIS cell and one neighbour.
// Returns net creature-energy delta for THIS cell (>0 = gain), and adds any
// declared loss into lossToFree. Both endpoints compute the identical value
// with signs swapped, so the pairwise transfer is exactly conserved.
float edgeTransfer(float myMass, float myMu, float myEn, float myAggr,
                   float nbMass, float nbMu, float nbEn, float nbAggr,
                   float payoff, inout float lossToFree){
  // only when both are real bodies and genomes differ
  if(myMass < 0.05 || nbMass < 0.05) return 0.0;
  float genomeDiff = abs(myMu - nbMu);
  if(genomeDiff < 0.008) return 0.0;              // same species -> no predation
  // contact strength
  float contact = min(myMass, nbMass);
  // aggression differential decides direction & magnitude (antisymmetric)
  float dir = myAggr - nbAggr;                    // >0 : I am the aggressor
  // base drained amount is proportional to contact and |dir|
  float base = 0.12 * contact * abs(dir);
  // predator drains from prey's stored energy; capped by prey energy
  float victimEn = (dir > 0.0) ? nbEn : myEn;
  float drained = min(base, victimEn);
  // Net for THIS cell: +drained*keep if aggressor, -drained if prey.
  float keep = mix(0.25, 1.0, clamp(payoff,0.0,1.0)); // low payoff -> predation loses
  if(dir > 0.0){
    // I gain keep*drained; the (1-keep)*drained is lost to free energy.
    lossToFree += drained * (1.0 - keep) * 0.5; // half attributed here, half at neighbour
    return  drained * keep;
  } else {
    lossToFree += drained * (1.0 - keep) * 0.5;
    return -drained;   // I am prey: lose the full drained amount
  }
}

void main(){
  vec4 s  = texture(uState, vUV);
  vec4 a  = texture(uAux,   vUV);
  float mass = s.r, cEnergy = s.g, mu = s.b, sigma = s.a;
  float aggr = a.r, freeE = a.g;
  float U = texture(uPot, vUV).r;

  float gmu  = (uGenome > 0.5 && mu > 0.001) ? mu : uMuBase;
  float gsig = (uGenome > 0.5 && sigma > 0.001) ? max(0.008, sigma) : uSigBase;

  // Lenia growth in [-1,1].
  float growth = 2.0 * bump(U, gmu, gsig) - 1.0;

  // -------- Conserved energy economy (all transfers move energy, never mint) --
  float gate = 1.0;
  if(uMetabolism > 0.5){
    // Photosynthesis: pull energy from the LOCAL free pool into the creature,
    // bounded by what the pool holds. Uniform light (no height gradient).
    float want = uLight * mass * uDt;
    float got  = min(want, freeE);
    cEnergy += got; freeE -= got;
    // Upkeep: creatures return a TINY amount of energy to the environment each
    // tick. Kept small so a healthy glider is never starved to death by default.
    float upkeep = 0.004 * mass * uDt;
    float back = min(upkeep, cEnergy);
    cEnergy -= back; freeE += back;
    cEnergy = min(cEnergy, 3.0);
    // VERY soft modulation: growth is only mildly slowed under scarcity so the
    // glider keeps its shape and locomotion (empirically, harder gating kills it).
    gate = (growth > 0.0) ? clamp(0.9 + cEnergy, 0.9, 1.0) : 1.0;
  }

  // -------- Eating: symmetric transfer with the 4 neighbours ------------------
  if(uEat > 0.5){
    float lossToFree = 0.0;
    vec4 sL = texture(uState, vUV - vec2(uTexel.x,0.0));
    vec4 sR = texture(uState, vUV + vec2(uTexel.x,0.0));
    vec4 sD = texture(uState, vUV - vec2(0.0,uTexel.y));
    vec4 sU = texture(uState, vUV + vec2(0.0,uTexel.y));
    float aL = texture(uAux, vUV - vec2(uTexel.x,0.0)).r;
    float aR = texture(uAux, vUV + vec2(uTexel.x,0.0)).r;
    float aD = texture(uAux, vUV - vec2(0.0,uTexel.y)).r;
    float aU = texture(uAux, vUV + vec2(0.0,uTexel.y)).r;
    float dE = 0.0;
    dE += edgeTransfer(mass,mu,cEnergy,aggr, sL.r,sL.b,sL.g,aL, uPredPayoff, lossToFree);
    dE += edgeTransfer(mass,mu,cEnergy,aggr, sR.r,sR.b,sR.g,aR, uPredPayoff, lossToFree);
    dE += edgeTransfer(mass,mu,cEnergy,aggr, sD.r,sD.b,sD.g,aD, uPredPayoff, lossToFree);
    dE += edgeTransfer(mass,mu,cEnergy,aggr, sU.r,sU.b,sU.g,aU, uPredPayoff, lossToFree);
    cEnergy = max(0.0, cEnergy + dE);
    freeE  += lossToFree;   // declared eating loss goes back to the shared pool
  }

  float newMass = clamp(mass + uDt * growth * gate, 0.0, 1.0);

  if(uMassConserve > 0.5){
    newMass = clamp(newMass * mix(1.0, uMassScale, 0.5), 0.0, 1.0);
  }

  // Death: when a cell loses mass, release its stored energy back to the pool
  // in proportion to the mass lost, so total energy is conserved on decay.
  if(uMetabolism > 0.5 && mass > 0.0){
    float lost = max(0.0, mass - newMass);
    float rel = cEnergy * (lost / max(mass, 1e-4));
    cEnergy -= rel; freeE += rel;
    if(newMass < 0.01){ freeE += cEnergy; cEnergy = 0.0; }
  }

  // -------- Genome (mu/sigma) + aggression drift/mutation --------------------
  if(uGenome > 0.5){
    // neighbour genome (used both to seed newborns and to keep a creature's
    // gene spatially coherent so it doesn't destabilize a moving glider).
    float mL=texture(uState,vUV-vec2(uTexel.x,0)).b, mR=texture(uState,vUV+vec2(uTexel.x,0)).b;
    float mD=texture(uState,vUV-vec2(0,uTexel.y)).b, mUu=texture(uState,vUV+vec2(0,uTexel.y)).b;
    float nbCount = step(0.001,mL)+step(0.001,mR)+step(0.001,mD)+step(0.001,mUu);
    float nbMu = (nbCount>0.5) ? (mL+mR+mD+mUu)/max(nbCount,1.0) : uMuBase;
    if(newMass > 0.02 && mu <= 0.001){
      // newborn INHERITS the local genome (only a tiny jitter) so the growing
      // front of a glider stays on-rule instead of shattering.
      mu = nbMu + (hash(vUV*71.0+uTime)-0.5)*0.004;
      sigma = uSigBase + (hash(vUV*37.0-uTime)-0.5)*0.004;
      aggr = clamp(aggr + (hash(vUV*17.0+uTime)-0.5)*0.03, 0.0, 1.0);
    }
    if(newMass > 0.02){
      if(nbCount>0.5) mu = mix(mu, nbMu, 0.25);   // strong coherence
      float agL=texture(uAux,vUV-vec2(uTexel.x,0)).r, agR=texture(uAux,vUV+vec2(uTexel.x,0)).r;
      float agD=texture(uAux,vUV-vec2(0,uTexel.y)).r, agU=texture(uAux,vUV+vec2(0,uTexel.y)).r;
      float agnb=(agL+agR+agD+agU)*0.25;
      aggr = mix(aggr, agnb, 0.1);
      mu    = clamp(mu    + uMut*(hash(vUV*997.0+uTime)-0.5)*0.3, 0.05, 0.35);
      sigma = clamp(sigma + uMut*(hash(vUV*631.0-uTime)-0.5)*0.2, 0.008, 0.06);
      aggr  = clamp(aggr  + uMut*(hash(vUV*547.0+uTime)-0.5)*2.0, 0.0, 1.0);
    }
  }

  // Curiosity spark (rare) — spawns fresh matter; energy taken from free pool.
  if(uCuriosity > 0.001){
    float spark = hash(vUV*311.0 + floor(uTime*3.0));
    if(spark > 1.0 - 0.0025 * uCuriosity){
      newMass = max(newMass, 0.55);
      mu = uMuBase + (hash(vUV*53.0+uTime)-0.5)*0.1;
      sigma = uSigBase;
      float grab = min(0.5, freeE); freeE -= grab; cEnergy += grab;
    }
  }

  // Pointer interaction (poke adds/erases mass; energy borrowed from pool).
  if(uPoke.x >= 0.0){
    float d = distance(vUV, uPoke);
    if(d < uPokeR){
      float w = 1.0 - d/uPokeR;
      if(uPokeErase > 0.5){
        float before = newMass;
        newMass *= (1.0 - w);
        float rel = cEnergy * (before>0.0 ? (before-newMass)/before : 0.0);
        cEnergy -= rel; freeE += rel;
      } else {
        newMass = clamp(newMass + uPokeAmt*w, 0.0, 1.0);
        if(mu <= 0.001){ mu = uMuBase; sigma = uSigBase; aggr = 0.3; }
        float grab = min(0.4*w, freeE); freeE -= grab; cEnergy += grab;
      }
    }
  }

  freeE = max(0.0, freeE);
  out0 = vec4(newMass, cEnergy, mu, sigma);
  out1 = vec4(aggr, freeE, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// RENDER — smooth-fill bodies, distinct hues per genome, camera (pan/zoom).
// ---------------------------------------------------------------------------
export const RENDER_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uState;   // tex0
uniform sampler2D uAux;     // tex1
uniform sampler2D uPot;
uniform int uView;          // 0 species,1 mass,2 energy,3 potential,4 aggression
uniform vec4 uCam;          // x,y offset, z zoom, w aspect
uniform float uGenome;
uniform float uShowLight;   // 1 = draw a faint light backdrop (opt-in gradient)
uniform float uLightGrad;   // 1 = gradient light, 0 = uniform

vec3 hsv(float h,float s,float v){
  vec4 K=vec4(1.,2./3.,1./3.,3.);
  vec3 p=abs(fract(vec3(h)+K.xyz)*6.-K.www);
  return v*mix(K.xxx,clamp(p-K.xxx,0.,1.),s);
}

void main(){
  vec2 uv = (vUV - 0.5) / uCam.z + 0.5 + uCam.xy;
  uv = fract(uv);

  vec4 s = texture(uState, uv);
  vec4 a = texture(uAux, uv);
  float mass = s.r;

  // Optional visible light backdrop so a gradient (if enabled) is never hidden.
  vec3 bg = vec3(0.02,0.03,0.05);
  if(uShowLight > 0.5){
    float L = (uLightGrad > 0.5) ? (0.55 + 0.45*(1.0-uv.y)) : 0.75;
    bg = mix(vec3(0.02,0.03,0.05), vec3(0.10,0.11,0.14), L);
  }

  vec3 col;
  if(uView == 0){
    // Species: hue from genome, SMOOTH FILL body (not just thin rings).
    float g = (uGenome > 0.5 && s.b > 0.001) ? s.b : 0.15;
    float hue = fract(0.5 + g * 2.2);
    // smooth fill: interior bright, soft edge; gives a coherent "organism" look
    float body = smoothstep(0.04, 0.28, mass);
    float core = pow(mass, 0.55);
    vec3 fill = hsv(hue, 0.75, 0.30 + 0.70*core);
    // subtle rim brighten so a blob reads as one body with an outline
    float rim = smoothstep(0.05,0.12,mass) * (1.0 - smoothstep(0.25,0.6,mass));
    col = mix(bg, fill, body) + rim*0.18*hsv(hue,0.4,1.0);
  } else if(uView == 1){
    float body = smoothstep(0.04,0.3,mass);
    col = mix(bg, vec3(0.55,0.95,0.85)*pow(mass,0.6), body);
  } else if(uView == 2){
    // energy view: creature energy warm, free-pool cool haze in background
    float e = clamp(s.g/1.5, 0.0, 1.0);
    float f = clamp(a.g/0.4, 0.0, 1.0);
    vec3 pool = mix(vec3(0.02,0.03,0.06), vec3(0.10,0.22,0.30), f);
    col = mix(pool, vec3(1.0,0.72,0.3), e*smoothstep(0.02,0.2,mass));
  } else if(uView == 3){
    float Uu = texture(uPot, uv).r;
    col = hsv(fract(0.6 - Uu*0.7), 0.8, Uu);
  } else {
    // aggression view: green (gentle) -> red (aggressive), over the body
    float body = smoothstep(0.04,0.3,mass);
    vec3 ag = mix(vec3(0.2,0.8,0.4), vec3(1.0,0.25,0.2), clamp(a.r,0.0,1.0));
    col = mix(bg, ag*pow(mass,0.5), body);
  }

  vec2 d = vUV - 0.5;
  col *= 1.0 - 0.28*dot(d,d);
  outColor = vec4(col, 1.0);
}`;
